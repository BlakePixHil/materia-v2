import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  clerkDraftCallables,
  clerkDraftRepository,
  clerkDraftsQuery,
  contactsRepository,
  forMatter,
  MATTER_PARTIES_QUERY,
  matterPartiesRepository,
  sortDrafts,
  suggestionStaleOf,
} from '@materia/data-access/repository';
import {
  basisPartLabel,
  CLERK_DRAFT_INSTRUCTIONS_MAX,
  CLERK_DRAFT_RECIPIENTS_MAX,
  clerkDraftTypesFor,
  contactDisplayName,
  type ClerkDraftRecipientInput,
} from '@materia/domain';
import { MtButton, MtCheckbox, MtNote, MtRadioGroup, MtTextarea, MtTextField, type MtOption } from '@materia/ui';

import { clerkUnavailable, draftStatusLabel, recipientOptions } from './clerk-draft-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { MANUAL_PATH } from '../clerk/clerk-chat-view';
import { MatterScreen } from '../matter-detail/matter-screen';

/**
 * Starting a Clerk draft (`/matters/:id/drafts/new`, AI-10, ADR-050): the letter types that fit the
 * matter, who it goes to (the matter's parties, the type's own roles first, or someone typed in),
 * optional instructions, and, for a letter to a third party, whether Clerk may draw on privileged
 * material. `?type=` and `?instructions=` prefill it (⌘J `/draft`), and a letter Clerk suggested
 * (AI-10b) also its recipients (`?to=` party ids, `?toName=`/`?toAddress=`) and `?suggestion=`, which
 * starting the draft accepts (against `?basis=` after a re-review; if its sources changed since, the
 * page lists what changed and the next start accepts it anyway). Clerk drafts on the server and the
 * editor opens at once to watch it. The person's earlier drafts on the matter are listed below.
 */
@Component({
  selector: 'mt-clerk-draft-start-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtNote, MtRadioGroup, MtTextarea, MtTextField, RouterLink],
  template: `
    <div class="page">
      <div class="mt-col" style="gap: var(--space-4)">
        <h2 class="title-m">Draft a letter with Clerk</h2>
        <p class="body-s t-2">
          Clerk drafts the letter from this matter’s facts, notes and documents. You check it beside its sources, then
          save it on the firm’s letterhead. Nothing is sent.
        </p>
      </div>

      @if (!enabled()) {
        <mt-note tone="warning">Clerk drafting isn’t turned on for your practice. {{ manualPath }}</mt-note>
      } @else if (!writable()) {
        <mt-note>This matter can’t change while it’s archived or deleted, so Clerk can’t draft on it.</mt-note>
      } @else if (!types().length) {
        <mt-note>Clerk doesn’t draft letters for this kind of matter yet.</mt-note>
      } @else {
        <form class="mt-col form" (submit)="$event.preventDefault(); start()">
          @if (changes(); as changes) {
            <mt-note tone="warning" data-suggestion-stale>
              Since Clerk suggested this letter, these changed: {{ changes }}. Check the letter, then draft it.
            </mt-note>
          } @else if (suggestionId()) {
            <mt-note data-from-suggestion>
              Clerk suggested this letter. Check who it goes to and what it says; drafting it accepts the suggestion.
            </mt-note>
          }
          <mt-radio-group
            name="type"
            label="Letter"
            [options]="typeOptions()"
            [ngModel]="typeId()"
            (ngModelChange)="pickType($event)"
          />
          <p class="caption t-3">
            The wording guidance for each letter is a starting point until a practitioner reviews it.
          </p>

          <fieldset class="mt-col recipients">
            <legend class="label">To</legend>
            @for (option of recipients(); track option.partyId) {
              <mt-checkbox
                [name]="'to-' + option.partyId"
                [label]="option.name"
                [description]="option.roleLabel"
                [disabled]="!chosen().includes(option.partyId) && full()"
                [ngModel]="chosen().includes(option.partyId)"
                (ngModelChange)="toggle(option.partyId, $event)"
              />
            } @empty {
              <p class="caption t-3">
                No one on the matter yet. Add someone below, or leave it for a general salutation.
              </p>
            }
            <mt-checkbox
              name="someone-else"
              label="Someone else"
              [ngModel]="other()"
              (ngModelChange)="other.set($event)"
            />
            @if (other()) {
              <mt-text-field
                name="other-name"
                label="Name"
                [ngModel]="otherName()"
                (ngModelChange)="otherName.set($event ?? '')"
              />
              <mt-textarea
                name="other-address"
                label="Address"
                [rows]="3"
                description="Leave it blank and the letter shows a placeholder to fill in."
                [ngModel]="otherAddress()"
                (ngModelChange)="otherAddress.set($event ?? '')"
              />
            }
          </fieldset>

          <mt-textarea
            name="instructions"
            [label]="type()?.needsInstructions ? 'What the letter says' : 'Instructions (optional)'"
            [required]="!!type()?.needsInstructions"
            [rows]="4"
            [maxLength]="instructionsMax"
            description="Anything Clerk should include, or the tone to take."
            [ngModel]="instructions()"
            (ngModelChange)="instructions.set($event ?? '')"
          />

          @if (type()?.audience === 'third_party' && canPrivileged()) {
            <mt-checkbox
              name="privileged"
              label="Let Clerk use privileged material"
              description="Off by default: a letter to a third party shouldn’t carry advice or privileged notes. You confirm again before saving."
              [ngModel]="includePrivileged()"
              (ngModelChange)="includePrivileged.set($event)"
            />
          }

          @if (error(); as error) {
            <mt-note tone="danger">{{ errorText(error) }} {{ unavailable(error) ? manualPath : '' }}</mt-note>
          }
          <div class="mt-row">
            <button mtButton variant="primary" type="submit" iconStart="sparkle" [loading]="starting()">
              Draft letter
            </button>
            <a mtButton variant="ghost" [routerLink]="['/matters', id(), 'documents']">Cancel</a>
          </div>
        </form>
      }

      @if (drafts().length) {
        <section class="mt-col" aria-labelledby="mt-drafts-recent">
          <h3 id="mt-drafts-recent" class="label">Your drafts on this matter</h3>
          <ul class="drafts">
            @for (draft of drafts(); track draft.id) {
              <li>
                <a [routerLink]="['/matters', id(), 'drafts', draft.id]">{{ draft.title }}</a>
                <span class="caption t-3">{{ statusLabel(draft) }}</span>
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .page {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-width: 720px;
      padding: var(--space-16);
    }
    .form {
      gap: var(--space-12);
    }
    .recipients {
      gap: var(--space-8);
      border: 0;
      padding: 0;
      margin: 0;
    }
    .drafts {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .drafts li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8);
      align-items: baseline;
    }
  `,
})
export class ClerkDraftStartPage {
  private readonly screen = inject(MatterScreen);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly context = inject(OrgContext);
  private readonly flags = inject(FeatureFlagService);
  private readonly api = clerkDraftCallables(inject(CALLABLES));
  private readonly contacts = contactsRepository();

  protected readonly manualPath = MANUAL_PATH;
  protected readonly instructionsMax = CLERK_DRAFT_INSTRUCTIONS_MAX;
  protected readonly canPrivileged = can('privileged.view');
  private readonly canUse = can('clerk.use');
  protected readonly enabled = computed(
    () => this.flags.isOn('clerk.enabled') && this.flags.isOn('clerk.features.drafting') && this.canUse(),
  );
  protected readonly writable = computed(() => !this.screen.deleted() && !this.screen.archived());
  protected readonly id = this.screen.id;

  private readonly query = toSignal(this.route.queryParamMap, { requireSync: true });
  protected readonly types = computed(() => clerkDraftTypesFor(this.screen.value()?.type));
  protected readonly typeOptions = computed<MtOption[]>(() =>
    this.types().map((type) => ({ value: type.id, label: type.title, description: type.description })),
  );
  protected readonly typeId = signal<string | null>(null);
  protected readonly type = computed(() => this.types().find((type) => type.id === this.typeId()));

  private readonly parties = matterPartiesRepository(this.id).watchQuery(forMatter(this.id, MATTER_PARTIES_QUERY));
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());
  private readonly requested = new Set<string>();
  protected readonly recipients = computed(() =>
    recipientOptions(this.parties.value(), (id) => this.names().get(id), this.type()),
  );
  protected readonly chosen = signal<string[]>([]);
  protected readonly other = signal(false);
  protected readonly otherName = signal('');
  protected readonly otherAddress = signal('');
  protected readonly full = computed(() => this.chosen().length + (this.other() ? 1 : 0) >= CLERK_DRAFT_RECIPIENTS_MAX);
  protected readonly instructions = signal('');
  protected readonly includePrivileged = signal(false);
  protected readonly starting = signal(false);
  protected readonly error = signal<unknown>(null);
  /** The letter suggestion this starts (AI-10b), the basis to accept it against, and what changed. */
  protected readonly suggestionId = signal<string | null>(null);
  private readonly basis = signal<string | null>(null);
  protected readonly changes = signal<string | null>(null);

  private readonly draftQuery = clerkDraftRepository(this.id).watchQuery(() => {
    const uid = this.context.uid();
    return uid && this.id() && this.canUse()
      ? clerkDraftsQuery({ uid, privilegedVisible: this.canPrivileged() })
      : null;
  });
  protected readonly drafts = computed(() => sortDrafts(this.draftQuery.value()).slice(0, 10));

  constructor() {
    // The prefill (⌘J `/draft`, a deep link), once the matter's types are known.
    effect(() => {
      const types = this.types();
      if (!types.length || untracked(this.typeId)) return;
      const query = untracked(this.query);
      const asked = query.get('type');
      untracked(() => {
        this.typeId.set(types.find((type) => type.id === asked)?.id ?? types[0]?.id ?? null);
        this.instructions.set((query.get('instructions') ?? '').slice(0, CLERK_DRAFT_INSTRUCTIONS_MAX));
        // A letter Clerk suggested (AI-10b): who it goes to, and the suggestion it accepts.
        const to = (query.get('to') ?? '').split(',').filter(Boolean);
        this.chosen.set([...new Set(to)].slice(0, CLERK_DRAFT_RECIPIENTS_MAX));
        const toName = query.get('toName')?.trim();
        if (toName) {
          this.other.set(true);
          this.otherName.set(toName);
          this.otherAddress.set(query.get('toAddress') ?? '');
        }
        this.suggestionId.set(query.get('suggestion') || null);
        this.basis.set(query.get('basis') || null);
      });
    });
    // Contact names, read once per contact.
    effect(() => {
      const ids = [...new Set(this.parties.value().map((party) => party.contactId))].filter(
        (id) => !this.requested.has(id),
      );
      if (!ids.length) return;
      ids.forEach((id) => this.requested.add(id));
      untracked(() => void this.loadNames(ids));
    });
  }

  private async loadNames(ids: string[]): Promise<void> {
    const found = await Promise.all(ids.map((id) => this.contacts.get(id).catch(() => null)));
    this.names.update((names) => {
      const next = new Map(names);
      found.forEach((contact, index) => {
        if (contact) next.set(ids[index] as string, contactDisplayName(contact));
      });
      return next;
    });
  }

  protected pickType(id: string | null): void {
    this.typeId.set(id);
    this.error.set(null);
    if (this.type()?.audience !== 'third_party') this.includePrivileged.set(false);
  }

  protected toggle(partyId: string, on: boolean): void {
    this.chosen.update((ids) => (on ? [...new Set([...ids, partyId])] : ids.filter((id) => id !== partyId)));
  }

  protected statusLabel(draft: Parameters<typeof draftStatusLabel>[0]): string {
    return draftStatusLabel(draft);
  }

  protected errorText(error: unknown): string {
    return error instanceof Error && !('details' in error) ? error.message : errorCopy(error);
  }

  protected unavailable(error: unknown): boolean {
    return clerkUnavailable(error);
  }

  /** Starts the draft and opens the editor, which shows Clerk's letter as it's written. */
  protected async start(): Promise<void> {
    const matterId = this.id();
    const type = this.type();
    if (!matterId || !type || this.starting()) return;
    const instructions = this.instructions().trim();
    if (type.needsInstructions && !instructions) {
      this.error.set(new Error('Say what the letter is about.'));
      return;
    }
    const recipients: ClerkDraftRecipientInput[] = this.recipients()
      .filter((option) => this.chosen().includes(option.partyId))
      .map((option) => ({ partyId: option.partyId }));
    if (this.other()) {
      const name = this.otherName().trim();
      if (!name) {
        this.error.set(new Error('Enter the name of the person or organisation the letter is to.'));
        return;
      }
      const address = this.otherAddress().trim();
      recipients.push({ name, ...(address ? { address } : {}) });
    }
    this.starting.set(true);
    this.error.set(null);
    const suggestionId = this.suggestionId();
    const basis = this.basis();
    try {
      const { draftId } = await this.api.start({
        matterId,
        typeId: type.id,
        recipients,
        instructions,
        includePrivileged: type.audience === 'third_party' && this.includePrivileged(),
        ...(suggestionId ? { suggestionId, ...(basis ? { expectedBasis: basis } : {}) } : {}),
      });
      await this.router.navigate(['/matters', matterId, 'drafts', draftId], { replaceUrl: true });
    } catch (error) {
      const stale = suggestionId ? suggestionStaleOf(error) : null;
      if (stale) {
        // The matter or a cited document changed since Clerk suggested it: say what, and accept it
        // against the current data when the person drafts it again.
        this.basis.set(stale.basis);
        const labels = [...new Set(stale.changed.map((change) => basisPartLabel(change.key)))].map(
          (label) => label.charAt(0).toLowerCase() + label.slice(1),
        );
        this.changes.set(labels.length ? labels.join(', ') : 'the matter or a cited document');
      } else {
        this.error.set(error);
      }
    } finally {
      this.starting.set(false);
    }
  }
}
