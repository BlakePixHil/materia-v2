import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import {
  contactsRepository,
  forMatter,
  MATTER_PARTIES_QUERY,
  matterDeadlinesRepository,
  matterDocumentRepository,
  matterDocumentsQuery,
  matterNoteRepository,
  matterNotesQuery,
  matterPartiesRepository,
  matterTasksRepository,
  OPEN_DEADLINES_QUERY,
  OPEN_TASKS_QUERY,
} from '@materia/data-access/repository';
import { contactDisplayName, deadlineTraceText, type PartyRole } from '@materia/domain';
import {
  DialogService,
  formatRelativeDate,
  MT_TODAY,
  type MtDateInput,
  MtDeadlineChip,
  MtIcon,
  MtIconButton,
  MtSkeleton,
} from '@materia/ui';
import { MtMarkdown } from '@materia/ui/markdown';

import type { MatterAction, MatterActionsData, MatterPerson } from './matter-actions-sheet';
import { MatterBrief } from './matter-brief';
import { MatterKeyFacts } from './matter-key-facts';
import { MatterScreen } from './matter-screen';
import { effectiveDue, nextDeadlines, partyRoleLabel, sortOpenTasks } from './matter-view';
import { INTENT_PARAM } from '../../core/commands/intents';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { matterTabsFor } from '../../pages/matter-tabs';
import { MtPageActions } from '../../shell/page-header';
import { CitationScope, CitationSources } from '../citations/citation-sources';
import { CitationViewer } from '../citations/citation-viewer';
import { MatterDisclosurePanel } from '../costs/matter-disclosure-panel';
import { MatterFeePanel } from '../fees/matter-fee-panel';
import { matterResolver, memberResolver } from '../notes/note-mentions';
import { noteTime } from '../notes/note-time';
import { mentionsAcross, noteAuthor, type NoteRecord } from '../notes/note-view';
import { MatterSuggestions } from '../suggestions/matter-suggestions';
import type { TimeQuickEntryData } from '../time/time-quick-entry';
import { MatterTrust } from '../trust/matter-trust';

/** How many of each the phone's sections list before "See all". */
const SHOWN = 5;
const NOTES_SHOWN = 3;

/** The people a matter is for, whom the phone offers to call or email. */
const CLIENT_ROLES: ReadonlySet<PartyRole> = new Set([
  'client',
  'executor',
  'administrator',
  'testator',
  'attorney',
  'trustee',
  'guardian',
]);

/**
 * A matter's Overview on a phone (MOB-02): one scroll under the header, with big buttons to call the
 * client, log time and add a note, the matter's brief (AI-06c), then sections that fold away (Key
 * facts, Deadlines, Tasks, Documents and Notes, each with "See all"), the money and Clerk panels
 * the Overview shows, and the matter's other tabs. The "…" in the top bar opens the same actions, and an email link, in a sheet.
 */
@Component({
  selector: 'mt-phone-matter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/mrow.css',
    '../../../../../../libs/ui/src/generated/components/card.css',
  ],
  imports: [
    RouterLink,
    CitationViewer,
    MatterBrief,
    MatterDisclosurePanel,
    MatterFeePanel,
    MatterKeyFacts,
    MatterSuggestions,
    MatterTrust,
    MtDeadlineChip,
    MtIcon,
    MtIconButton,
    MtMarkdown,
    MtPageActions,
    MtSkeleton,
  ],
  providers: [CitationSources, { provide: CitationScope, useExisting: MatterScreen }],
  host: { class: 'mt-phone-matter' },
  template: `
    <ng-template mtPageActions>
      <button
        mtIconButton
        icon="more"
        size="sm"
        label="Matter actions"
        data-matter-actions
        (click)="openActions()"
      ></button>
    </ng-template>

    @if (actions().length) {
      <div class="acts" role="group" aria-label="Quick actions">
        @for (act of actions(); track act.id) {
          @switch (act.id) {
            @case ('call') {
              <a class="act" data-act="call" [href]="'tel:' + act.phone" [attr.aria-label]="act.aria">
                <mt-icon name="phone" /><span>{{ act.label }}</span>
              </a>
            }
            @case ('time') {
              <button type="button" class="act" data-act="time" (click)="logTime()">
                <mt-icon name="timer" /><span>{{ act.label }}</span>
              </button>
            }
            @case ('note') {
              <a class="act" data-act="note" [routerLink]="link('notes')" [queryParams]="noteIntent">
                <mt-icon name="compose" /><span>{{ act.label }}</span>
              </a>
            }
          }
        }
      </div>
    }

    <!-- What's due, what changed and the next step (AI-06c), as on the Overview. -->
    <mt-matter-brief />

    <details class="sec" open data-section="facts">
      <summary>Key facts<mt-icon class="chev" name="chevron-down" /></summary>
      <div class="body"><mt-matter-key-facts /></div>
    </details>

    <details class="sec" open data-section="deadlines">
      <summary>
        Deadlines<span class="count">{{ upcoming().length }}</span
        ><mt-icon class="chev" name="chevron-down" />
      </summary>
      <div class="body">
        @if (deadlines.status() === 'loading') {
          <mt-skeleton variant="lines" label="Loading deadlines…" [count]="2" />
        } @else {
          @for (deadline of upcoming(); track deadline.id) {
            <div class="mt-mrow">
              <span class="mt-grow tt">{{ deadline.title }}</span>
              @if (due(deadline); as date) {
                <mt-deadline-chip [due]="date" [critical]="deadline.critical" [trace]="trace(deadline)" />
              } @else {
                <span class="caption t-3">Waiting</span>
              }
            </div>
          } @empty {
            <p class="caption t-3 none">No open deadlines.</p>
          }
        }
        <a class="all caption" [routerLink]="link('deadlines')">See all deadlines</a>
      </div>
    </details>

    <details class="sec" open data-section="tasks">
      <summary>
        Tasks<span class="count">{{ tasks.value().length }}</span
        ><mt-icon class="chev" name="chevron-down" />
      </summary>
      <div class="body">
        @if (tasks.status() === 'loading') {
          <mt-skeleton variant="lines" label="Loading tasks…" [count]="2" />
        } @else {
          @for (task of openTasks(); track task.id) {
            <a class="mt-mrow" [routerLink]="link('tasks')" [queryParams]="{ task: task.id }">
              <span class="mt-grow">
                <span class="tt mt-ell">{{ task.title }}</span>
                @if (task.assigneeUid; as uid) {
                  <span class="ts">{{ screen.memberName(uid) }}</span>
                }
              </span>
              @if (task.dueDate; as dueDate) {
                <span class="caption t-2">{{ relative(dueDate) }}</span>
              }
            </a>
          } @empty {
            <p class="caption t-3 none">No open tasks.</p>
          }
        }
        <a class="all caption" [routerLink]="link('tasks')">See all tasks</a>
      </div>
    </details>

    <details class="sec" data-section="documents">
      <summary>Documents<mt-icon class="chev" name="chevron-down" /></summary>
      <div class="body">
        @if (documents.status() === 'loading') {
          <mt-skeleton variant="lines" label="Loading documents…" [count]="2" />
        } @else {
          @for (doc of recentDocuments(); track doc.id) {
            <a class="mt-mrow" [routerLink]="link('documents', doc.id)">
              <mt-icon name="document" />
              <span class="mt-grow">
                <span class="tt mt-ell">{{ doc.name }}</span>
                <span class="ts">{{ relative(doc.createdAt) }}</span>
              </span>
            </a>
          } @empty {
            <p class="caption t-3 none">No documents yet.</p>
          }
        }
        <a class="all caption" [routerLink]="link('documents')">See all documents</a>
      </div>
    </details>

    <details class="sec" data-section="notes">
      <summary>Notes<mt-icon class="chev" name="chevron-down" /></summary>
      <div class="body">
        @if (notes.status() === 'loading') {
          <mt-skeleton variant="lines" label="Loading notes…" [count]="2" />
        } @else {
          @for (note of latestNotes(); track note.id) {
            <article class="note">
              <p class="caption t-3 who">
                @if (note.pinned) {
                  <mt-icon name="pin" [size]="14" label="Pinned" />
                }
                {{ author(note) }} · {{ when(note.createdAt) }}
              </p>
              <mt-markdown mentions [content]="note.bodyMd" [member]="member()" [matter]="matter()" />
            </article>
          } @empty {
            <p class="caption t-3 none">No notes yet.</p>
          }
        }
        <a class="all caption" [routerLink]="link('notes')">See all notes</a>
      </div>
    </details>

    @if (feesOn()) {
      @defer (on idle) {
        <mt-matter-fee-panel />
      }
    }
    @if (disclosureOn()) {
      @defer (on idle) {
        <mt-matter-disclosure-panel />
      }
    }
    @if (suggestionsOn()) {
      @defer (on idle) {
        <mt-matter-suggestions />
      }
    }
    <mt-matter-trust />

    <nav class="tabs" aria-label="More on this matter">
      @for (tab of otherTabs(); track tab.path) {
        <a class="mt-mrow" [routerLink]="link(tab.path)" [attr.data-tab]="tab.path">
          <span class="tt">{{ tab.label }}</span>
          <mt-icon class="chev" name="chevron-right" />
        </a>
      }
    </nav>

    @if (sources.viewing(); as viewing) {
      @defer (on immediate) {
        <mt-citation-viewer
          [matterId]="screen.id() ?? ''"
          [citations]="viewing.citations"
          [index]="viewing.index"
          (indexChange)="sources.viewing.set({ citations: viewing.citations, index: $event })"
          (closed)="sources.close()"
        />
      } @loading (minimum 0ms) {
        <p class="caption t-3 mt-sr" role="status">Opening the source…</p>
      }
    }
  `,
  styles: `
    .mt-phone-matter {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-phone-matter .acts {
      display: grid;
      grid-auto-columns: minmax(0, 1fr);
      grid-auto-flow: column;
      gap: var(--space-8);
    }
    .mt-phone-matter .act {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-4);
      min-height: 64px;
      padding: var(--space-8);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      color: var(--text-primary);
      font: 500 12px/16px var(--font-sans);
      text-align: center;
      text-decoration: none;
      cursor: pointer;
      outline: none;
      -webkit-tap-highlight-color: transparent;
      transition: background-color var(--motion-fast) var(--ease-out);
    }
    .mt-phone-matter .act mt-icon {
      color: var(--icon-brand);
    }
    .mt-phone-matter .act:active {
      background: var(--bg-pressed);
    }
    .mt-phone-matter .act:focus-visible {
      box-shadow: var(--focus-ring);
    }
    .mt-phone-matter .sec {
      border-bottom: 1px solid var(--border-default);
    }
    .mt-phone-matter .sec > summary {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      min-height: 48px;
      font: 600 15px/20px var(--font-sans);
      color: var(--text-primary);
      list-style: none;
      cursor: pointer;
      outline: none;
      -webkit-tap-highlight-color: transparent;
    }
    .mt-phone-matter .sec > summary::-webkit-details-marker {
      display: none;
    }
    .mt-phone-matter .sec > summary:focus-visible {
      box-shadow: var(--focus-ring);
      border-radius: var(--radius-sm);
    }
    .mt-phone-matter .sec .count {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-phone-matter .sec .chev {
      margin-left: auto;
      color: var(--icon-muted);
      transition: transform var(--motion-fast) var(--ease-out);
    }
    .mt-phone-matter .sec:not([open]) .chev {
      transform: rotate(-90deg);
    }
    .mt-phone-matter .sec .body {
      display: flex;
      flex-direction: column;
      padding-bottom: var(--space-12);
    }
    .mt-phone-matter .sec .mt-mrow .mt-grow {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .mt-phone-matter .sec .none {
      margin: 0 0 var(--space-8);
    }
    .mt-phone-matter .sec .all {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      min-height: 44px;
      color: var(--text-brand);
      text-decoration: none;
    }
    .mt-phone-matter .note {
      padding: var(--space-8) 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-phone-matter .note .who {
      display: flex;
      align-items: center;
      gap: var(--space-4);
      margin: 0 0 var(--space-4);
    }
    /* A long note shows its start: the Notes tab has the rest. */
    .mt-phone-matter .note mt-markdown {
      display: block;
      max-height: 7.5em;
      overflow: hidden;
      mask-image: linear-gradient(to bottom, #000 70%, transparent);
    }
    .mt-phone-matter .tabs {
      display: flex;
      flex-direction: column;
    }
    @media (prefers-reduced-motion: reduce) {
      .mt-phone-matter .sec .chev {
        transition: none;
      }
    }
  `,
})
export class PhoneMatter {
  protected readonly screen = inject(MatterScreen);
  protected readonly sources = inject(CitationSources);
  private readonly router = inject(Router);
  private readonly dialogs = inject(DialogService);
  private readonly today = inject(MT_TODAY);
  private readonly flags = inject(FeatureFlagService);
  private readonly contacts = contactsRepository();
  private readonly canClerk = can('clerk.use');
  private readonly canBilling = can('billing.view');
  private readonly canTime = can('time.record');
  private readonly canNote = can('note.write');
  /** As the Overview: each panel shows when its flag is on and the role may see it. */
  protected readonly feesOn = computed(() => this.flags.isOn('billing.feeBudgets') && this.canBilling());
  protected readonly disclosureOn = computed(() => this.flags.isOn('billing.costsDisclosure') && this.canBilling());
  protected readonly suggestionsOn = computed(() => this.flags.isOn('clerk.features.suggestions') && this.canClerk());
  private readonly id = this.screen.id;

  protected readonly deadlines = matterDeadlinesRepository(this.id).watchQuery(
    forMatter(this.id, OPEN_DEADLINES_QUERY),
  );
  protected readonly tasks = matterTasksRepository(this.id).watchQuery(forMatter(this.id, OPEN_TASKS_QUERY));
  protected readonly documents = matterDocumentRepository(this.id).watchQuery(() =>
    this.id() ? matterDocumentsQuery({ privilegedVisible: this.screen.canPrivileged(), pageSize: SHOWN }) : null,
  );
  protected readonly notes = matterNoteRepository(this.id).watchQuery(() =>
    this.id() ? matterNotesQuery({ privilegedVisible: this.screen.canPrivileged(), pageSize: NOTES_SHOWN }) : null,
  );
  private readonly parties = matterPartiesRepository(this.id).watchQuery(forMatter(this.id, MATTER_PARTIES_QUERY));

  protected readonly upcoming = computed(() => nextDeadlines(this.deadlines.value(), SHOWN));
  protected readonly openTasks = computed(() => sortOpenTasks(this.tasks.value()).slice(0, SHOWN));
  protected readonly recentDocuments = computed(() => this.documents.value().filter((doc) => !doc.deletedAt));
  protected readonly latestNotes = computed(() => this.notes.value().filter((note) => !note.deletedAt));
  protected readonly member = memberResolver(() => this.screen.memberList());
  protected readonly matter = matterResolver(
    () => mentionsAcross(this.latestNotes().map((note) => note.bodyMd)).matterIds,
  );
  protected readonly when = noteTime();
  protected readonly due = effectiveDue;
  protected readonly trace = deadlineTraceText;
  protected readonly noteIntent = { [INTENT_PARAM]: 'add-note' };

  /** The tabs besides the Overview (this screen), for "More on this matter". */
  protected readonly otherTabs = computed(() =>
    matterTabsFor(this.screen.value()?.type, (key) => this.flags.isOn(key)).filter((tab) => tab.path !== 'overview'),
  );

  /** The people the matter is for, with their numbers and emails, read once per contact. */
  private readonly people = signal<readonly MatterPerson[]>([]);
  /** The first of them with a phone number: the "Call" button. */
  private readonly caller = computed(() => this.people().find((person) => person.phone) ?? null);
  protected readonly actions = computed(() => {
    const caller = this.caller();
    const writable = !this.screen.deleted();
    return [
      ...(caller
        ? [
            {
              id: 'call' as const,
              label: `Call ${caller.role.toLowerCase()}`,
              aria: `Call ${caller.name}, ${caller.role.toLowerCase()}`,
              phone: caller.phone,
            },
          ]
        : []),
      ...(writable && !this.screen.closed() && this.canTime()
        ? [{ id: 'time' as const, label: 'Log time', aria: null, phone: null }]
        : []),
      ...(writable && this.canNote() ? [{ id: 'note' as const, label: 'Add note', aria: null, phone: null }] : []),
    ];
  });

  constructor() {
    let loaded = '';
    effect(() => {
      const parties = this.parties.value().filter((party) => CLIENT_ROLES.has(party.role));
      const key = parties.map((party) => `${party.contactId}:${party.role}`).join(',');
      if (key === loaded) return;
      loaded = key;
      untracked(() => void this.loadPeople(parties, key, () => loaded));
    });
  }

  protected link(...path: string[]): string[] {
    return ['/matters', this.id() ?? '', ...path];
  }

  protected relative(value: MtDateInput): string {
    return formatRelativeDate(value, this.today());
  }

  protected author(note: NoteRecord): string {
    return noteAuthor(note, (uid) => this.screen.memberName(uid));
  }

  /** Quick time entry (BILL-01) on this matter: a sheet on a phone. */
  protected async logTime(): Promise<void> {
    const { TimeQuickEntry } = await import('../time/time-quick-entry');
    await this.dialogs.open<TimeQuickEntryData>(TimeQuickEntry, { data: { matterId: this.id() } }).result;
  }

  /** The matter's actions in a sheet: add a note, log time, call or email. */
  protected async openActions(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    const actions = this.actions();
    const { MatterActionsSheet } = await import('./matter-actions-sheet');
    const picked = await this.dialogs.open<MatterActionsData, MatterAction | null>(MatterActionsSheet, {
      data: {
        number: matter.number,
        people: this.people(),
        canNote: actions.some((action) => action.id === 'note'),
        canTime: actions.some((action) => action.id === 'time'),
      },
    }).result;
    if (picked === 'time') await this.logTime();
    else if (picked === 'note') await this.router.navigate(this.link('notes'), { queryParams: this.noteIntent });
  }

  private async loadPeople(
    parties: readonly { contactId: string; role: PartyRole }[],
    key: string,
    current: () => string,
  ): Promise<void> {
    const found = await Promise.all(parties.map((party) => this.contacts.get(party.contactId).catch(() => null)));
    if (current() !== key) return;
    this.people.set(
      parties.flatMap((party, i) => {
        const contact = found[i];
        if (!contact || contact.deletedAt) return [];
        return [
          {
            contactId: party.contactId,
            name: contactDisplayName(contact),
            role: partyRoleLabel(party.role),
            phone: (contact.phones.find((phone) => phone.type === 'mobile') ?? contact.phones[0])?.number ?? null,
            email: contact.emails[0]?.address ?? null,
          },
        ];
      }),
    );
  }
}
