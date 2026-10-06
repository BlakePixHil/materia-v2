import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import {
  compareNotes,
  forMatter,
  matterActivityRepository,
  matterDeadlinesRepository,
  matterNoteRepository,
  matterTasksRepository,
  OPEN_DEADLINES_QUERY,
  OPEN_TASKS_QUERY,
  pinnedNotesQuery,
  RECENT_ACTIVITY_QUERY,
} from '@materia/data-access/repository';
import { deadlineTraceText, STATUTORY_DISABLED_MESSAGE } from '@materia/domain';
import { formatRelativeDate, MT_TODAY, MtClerkMark, MtDeadlineChip, MtEmptyState, type MtDateInput } from '@materia/ui';
import { MtMarkdown } from '@materia/ui/markdown';

import { MatterKeyFacts } from './matter-key-facts';
import { MatterScreen } from './matter-screen';
import { duePendingText, effectiveDue, nextDeadlines, sortOpenTasks } from './matter-view';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { statutoryDisabled } from '../deadlines/statutory-flag';
import { matterResolver, memberResolver } from '../notes/note-mentions';
import { noteTime } from '../notes/note-time';
import { activityTitle, mentionsAcross, noteAuthor, type NoteRecord } from '../notes/note-view';
import { MatterSuggestions } from '../suggestions/matter-suggestions';
import { MatterTrust } from '../trust/matter-trust';

/** How many open tasks the overview lists (the count shows them all). */
const TASKS_SHOWN = 5;

/**
 * A matter's Overview tab (CORE-06): pinned notes on top (CORE-13), then its key facts, the trust
 * balance for billing roles (BILL-11, flagged), the next five deadlines, open tasks, the three latest
 * activity lines, "Clerk suggests…" (AI-07) and the Clerk brief (AI-06 fills it).
 * Listens to the matter's pinned notes, deadlines, tasks and activity only while this tab is shown.
 */
@Component({
  selector: 'mt-matter-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/card.css'],
  imports: [
    RouterLink,
    MatterKeyFacts,
    MatterSuggestions,
    MatterTrust,
    MtClerkMark,
    MtDeadlineChip,
    MtEmptyState,
    MtMarkdown,
  ],
  host: { class: 'mt-matter-overview' },
  template: `
    @if (pinned().length) {
      <section class="mt-card pinned" data-pad aria-labelledby="mt-ov-pinned">
        <div class="mt-card-h">
          <h2 class="mt-card-title" id="mt-ov-pinned">Pinned notes</h2>
          <a class="mt-ml caption" routerLink="../notes">All notes</a>
        </div>
        <ul class="notes">
          @for (note of pinned(); track note.id) {
            <li>
              <p class="caption t-3 who">{{ author(note) }} · {{ when(note.createdAt) }}</p>
              <mt-markdown mentions [content]="note.bodyMd" [member]="member()" [matter]="matter()" />
            </li>
          }
        </ul>
      </section>
    }
    <div class="mt-col col">
      <section class="mt-card" data-pad aria-labelledby="mt-ov-facts">
        <div class="mt-card-h"><h2 class="mt-card-title" id="mt-ov-facts">Key facts</h2></div>
        <mt-matter-key-facts />
      </section>
      @if (suggestionsOn()) {
        <!-- Its own chunk (AI-07): the card, its editor and the callables load only when Clerk can suggest. -->
        @defer (on idle) {
          <mt-matter-suggestions />
        }
      }
      <section class="mt-card" data-pad aria-labelledby="mt-ov-brief">
        <div class="mt-card-h">
          <mt-clerk-mark size="xs" />
          <h2 class="mt-card-title" id="mt-ov-brief">Clerk brief</h2>
        </div>
        <mt-empty-state
          icon="sparkle"
          title="Coming in AI-06"
          description="Clerk’s summary of this matter: what changed, what’s due and what to do next."
          [headingLevel]="3"
        />
      </section>
    </div>
    <div class="mt-col col">
      <mt-matter-trust />
      <section class="mt-card" data-pad aria-labelledby="mt-ov-deadlines">
        <div class="mt-card-h">
          <h2 class="mt-card-title" id="mt-ov-deadlines">Next deadlines</h2>
          <a class="mt-ml caption" routerLink="../deadlines">All deadlines</a>
        </div>
        @if (statutoryOff()) {
          <p class="caption t-2 statutory">{{ statutoryMessage }}</p>
        }
        @if (deadlines.status() === 'loading') {
          <p class="caption t-3" role="status">Loading deadlines…</p>
        } @else {
          <ul class="list">
            @for (deadline of upcoming(); track deadline.id) {
              <li>
                <span class="mt-grow">{{ deadline.title }}</span>
                @if (due(deadline); as date) {
                  <mt-deadline-chip [due]="date" [critical]="deadline.critical" [trace]="trace(deadline)" />
                } @else {
                  <span class="caption t-3">Waiting: {{ deadline.blockedReason ?? 'not computed yet' }}</span>
                }
              </li>
            } @empty {
              <li class="caption t-3">No open deadlines.</li>
            }
          </ul>
        }
      </section>
      <section class="mt-card" data-pad aria-labelledby="mt-ov-tasks">
        <div class="mt-card-h">
          <h2 class="mt-card-title" id="mt-ov-tasks">Open tasks</h2>
          <span class="caption t-3">{{ tasks.value().length }}</span>
          <a class="mt-ml caption" routerLink="../tasks">All tasks</a>
        </div>
        @if (tasks.status() === 'loading') {
          <p class="caption t-3" role="status">Loading tasks…</p>
        } @else {
          <ul class="list">
            @for (task of openTasks(); track task.id) {
              <li>
                <span class="mt-grow">{{ task.title }}</span>
                @if (task.assigneeUid; as uid) {
                  <span class="caption t-3">{{ screen.memberName(uid) }}</span>
                }
                @if (task.dueDate; as due) {
                  <span class="caption t-2">{{ relative(due) }}</span>
                } @else if (pending(task); as text) {
                  <span class="caption t-3 pending">{{ text }}</span>
                }
              </li>
            } @empty {
              <li class="caption t-3">No open tasks.</li>
            }
          </ul>
        }
      </section>
      <section class="mt-card" data-pad aria-labelledby="mt-ov-activity">
        <div class="mt-card-h">
          <h2 class="mt-card-title" id="mt-ov-activity">Recent activity</h2>
          <a class="mt-ml caption" routerLink="../activity">All activity</a>
        </div>
        @if (activity.status() === 'loading') {
          <p class="caption t-3" role="status">Loading activity…</p>
        } @else {
          <ul class="list">
            @for (entry of activity.value(); track entry.id) {
              <li>
                <span class="mt-grow">{{ activityLine(entry.actorUid, entry.summary) }}</span>
                <span class="caption t-3">{{ relative(entry.at) }}</span>
              </li>
            } @empty {
              <li class="caption t-3">Nothing yet.</li>
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: `
    .mt-matter-overview {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      gap: var(--space-16);
      align-items: start;
    }
    .mt-matter-overview .col {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-matter-overview h2 {
      margin: 0;
    }
    .mt-matter-overview .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-matter-overview .statutory {
      margin: 0 0 var(--space-8);
    }
    .mt-matter-overview .pinned {
      grid-column: 1 / -1;
    }
    .mt-matter-overview .notes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-matter-overview .notes li + li {
      padding-top: var(--space-12);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-matter-overview .notes .who {
      margin: 0 0 var(--space-4);
    }
    .mt-matter-overview .list li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      min-width: 0;
    }
    @media (max-width: 900px) {
      .mt-matter-overview {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class MatterOverview {
  protected readonly screen = inject(MatterScreen);
  private readonly today = inject(MT_TODAY);
  private readonly flags = inject(FeatureFlagService);
  private readonly canClerk = can('clerk.use');
  /** Clerk suggestions are on for the org and the role may use Clerk (AI-07). */
  protected readonly suggestionsOn = computed(() => this.flags.isOn('clerk.features.suggestions') && this.canClerk());
  private readonly id = this.screen.id;

  protected readonly deadlines = matterDeadlinesRepository(this.id).watchQuery(
    forMatter(this.id, OPEN_DEADLINES_QUERY),
  );
  protected readonly tasks = matterTasksRepository(this.id).watchQuery(forMatter(this.id, OPEN_TASKS_QUERY));
  protected readonly activity = matterActivityRepository(this.id).watchQuery(forMatter(this.id, RECENT_ACTIVITY_QUERY));
  private readonly pinnedNotes = matterNoteRepository(this.id).watchQuery(() =>
    this.id() ? pinnedNotesQuery({ privilegedVisible: this.screen.canPrivileged() }) : null,
  );
  /** Pinned notes, newest first (CORE-13). */
  protected readonly pinned = computed(() => [...this.pinnedNotes.value()].sort(compareNotes));
  protected readonly member = memberResolver(() => this.screen.memberList());
  protected readonly matter = matterResolver(() => mentionsAcross(this.pinned().map((note) => note.bodyMd)).matterIds);
  protected readonly when = noteTime();

  protected readonly upcoming = computed(() => nextDeadlines(this.deadlines.value()));
  protected readonly openTasks = computed(() => sortOpenTasks(this.tasks.value()).slice(0, TASKS_SHOWN));
  protected readonly due = effectiveDue;
  protected readonly pending = duePendingText;
  protected readonly trace = deadlineTraceText;
  protected readonly statutoryMessage = STATUTORY_DISABLED_MESSAGE;
  protected readonly statutoryOff = statutoryDisabled(() => [this.screen.value()?.jurisdiction]);

  protected relative(value: MtDateInput): string {
    return formatRelativeDate(value, this.today());
  }

  protected author(note: NoteRecord): string {
    return noteAuthor(note, (uid) => this.screen.memberName(uid));
  }

  /** "Priya Shah opened the matter". */
  protected activityLine(actorUid: string, summary: string): string {
    return activityTitle(actorUid, summary, (uid) => this.screen.memberName(uid));
  }
}
