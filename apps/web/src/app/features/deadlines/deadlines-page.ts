import { ChangeDetectionStrategy, Component, computed, inject, signal, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can, OrgContext } from '@materia/data-access';
import {
  deadlineChangeGroupRepository,
  deadlineGroupRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  myPendingChangesQuery,
  UPCOMING_DEADLINES_QUERY,
} from '@materia/data-access/repository';
import {
  deadlineMatchesFilters,
  DeadlineKindSchema,
  groupDeadlines,
  JurisdictionSchema,
  needsReview,
  STATUTORY_DISABLED_MESSAGE,
  type DeadlineFilters,
  type Jurisdiction,
} from '@materia/domain';
import {
  MT_MENU,
  MT_TODAY,
  MtButton,
  MtEmptyState,
  MtIcon,
  MtNote,
  MtSegmentedControl,
  type MtOption,
} from '@materia/ui';

import { DeadlineActions } from './deadline-actions';
import { DeadlineCalendar } from './deadline-calendar';
import { DeadlineRow, type DeadlineRowAction } from './deadline-row';
import { deadlineErrorCopy, deadlineKindLabel, monthOf, type ChangeRowVm, type DeadlineRowVm } from './deadline-view';
import { matterLookup } from './matter-lookup';
import { PendingChanges } from './pending-changes';
import { statutoryDisabled } from './statutory-flag';
import { MtExportButton } from '../../core/exports/export-button';
import { PushOffer } from '../../core/push/push-offer';

type View = 'list' | 'calendar';
const VIEW_KEY = 'materia.deadlines.view';

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

/**
 * `/deadlines` (CORE-10): every upcoming deadline across the firm's matters, as a list in Overdue,
 * This week, Next 30 days and Later, or as a month calendar. Filters: mine, my team's matters,
 * critical, kind and jurisdiction. Above the list, the changes waiting on me (Accept or Reject;
 * a red banner when a critical deadline would move into the past) and the review queue (deadlines
 * already past when they were computed).
 */
@Component({
  selector: 'mt-deadlines-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [DeadlineActions],
  imports: [
    DeadlineCalendar,
    DeadlineRow,
    FormsModule,
    MT_MENU,
    MtButton,
    MtEmptyState,
    MtExportButton,
    MtIcon,
    MtNote,
    MtSegmentedControl,
    PendingChanges,
    PushOffer,
  ],
  host: { class: 'mt-deadlines-page' },
  template: `
    <div class="head">
      <h1 class="title-l">Deadlines</h1>
      <mt-export-button class="mt-ml" kind="deadlines" [filters]="exportFilters()" />
      <mt-segmented-control
        label="Deadlines view"
        [options]="viewOptions"
        [ngModel]="view()"
        (ngModelChange)="setView($event)"
      />
    </div>
    <p class="mt-sr" aria-live="polite">{{ actions.announcement() }}</p>
    @if (statutoryOff()) {
      <mt-note tone="warning">{{ statutoryMessage }}</mt-note>
    }
    @if (hasCritical()) {
      <mt-push-offer />
    }

    @if (changeRows().length) {
      <section class="block" aria-labelledby="mt-dl-changes">
        <h2 class="title-m" id="mt-dl-changes">
          Changes waiting on you <span class="caption t-3">{{ changeRows().length }}</span>
        </h2>
        <mt-pending-changes
          [changes]="changeRows()"
          [showMatter]="true"
          [canResolve]="canDecide()"
          [isBusy]="isBusy"
          (accept)="actions.resolve($event, true)"
          (reject)="actions.resolve($event, false)"
        />
      </section>
    }

    <div class="bar" role="group" aria-label="Filters">
      <button type="button" class="mt-chip" [attr.aria-pressed]="mine()" (click)="mine.set(!mine())">Mine</button>
      <button type="button" class="mt-chip" [attr.aria-pressed]="team()" (click)="team.set(!team())">
        My team’s matters
      </button>
      <button type="button" class="mt-chip" [attr.aria-pressed]="critical()" (click)="critical.set(!critical())">
        Critical
      </button>
      <button
        type="button"
        class="mt-chip"
        [attr.data-selected]="kinds().length ? '' : null"
        [mtMenuTrigger]="kindMenu"
      >
        {{ kindText() }}<mt-icon name="chevron-down" />
      </button>
      <button
        type="button"
        class="mt-chip"
        [attr.data-selected]="jurisdictions().length ? '' : null"
        [mtMenuTrigger]="jurisdictionMenu"
      >
        {{ jurisdictionText() }}<mt-icon name="chevron-down" />
      </button>
      @if (filtered()) {
        <button mtButton variant="ghost" size="sm" (click)="clearFilters()">Clear filters</button>
      }
    </div>

    @switch (deadlines.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading deadlines…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="deadlines.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        @if (reviewRows().length) {
          <section class="block" aria-labelledby="mt-dl-review">
            <h2 class="title-m" id="mt-dl-review">
              Needs review <span class="caption t-3">{{ reviewRows().length }}</span>
            </h2>
            <p class="caption t-2 hint">
              Already past when they were computed. Mark each done, waive it, confirm it missed or override its date.
            </p>
            <ul class="rows">
              @for (row of reviewRows(); track row.key) {
                <li>
                  <mt-deadline-row
                    [row]="row"
                    [showMatter]="true"
                    [assignee]="memberName(row.deadline.assigneeUid)"
                    [canComplete]="canComplete()"
                    [canDecide]="canDecide()"
                    [canEdit]="canComplete()"
                    [busy]="actions.isBusy(row.key)"
                    (action)="act(row, $event)"
                  />
                </li>
              }
            </ul>
          </section>
        }
        @if (view() === 'calendar') {
          <mt-deadline-calendar
            [month]="month()"
            [rows]="visibleRows()"
            [today]="today()"
            (monthChange)="month.set($event)"
          />
        } @else if (groups().length) {
          @for (group of groups(); track group.id) {
            <section class="block" [attr.aria-labelledby]="'mt-dl-' + group.id" [attr.data-group]="group.id">
              <h2 class="title-m" [id]="'mt-dl-' + group.id">
                {{ group.label }} <span class="caption t-3">{{ group.deadlines.length }}</span>
              </h2>
              <ul class="rows">
                @for (row of group.deadlines; track row.key) {
                  <li>
                    <mt-deadline-row
                      [row]="row"
                      [showMatter]="true"
                      [assignee]="memberName(row.deadline.assigneeUid)"
                      [canComplete]="canComplete()"
                      [canDecide]="canDecide()"
                      [canEdit]="canComplete()"
                      [busy]="actions.isBusy(row.key)"
                      (action)="act(row, $event)"
                    />
                  </li>
                }
              </ul>
            </section>
          }
        } @else if (filtered()) {
          <mt-empty-state
            icon="search"
            title="No deadlines match"
            description="Nothing upcoming matches these filters."
            [headingLevel]="2"
          >
            <button mtButton size="sm" (click)="clearFilters()">Clear filters</button>
          </mt-empty-state>
        } @else {
          <mt-empty-state
            icon="calendar"
            title="No upcoming deadlines"
            description="Deadlines computed from matter events, and ones you add on a matter, show here."
            [headingLevel]="2"
          />
        }
      }
    }

    <ng-template #kindMenu>
      <mt-menu aria-label="Kind">
        @for (kind of kindOptions; track kind) {
          <button mtMenuItemCheckbox [checked]="kinds().includes(kind)" (checkedChange)="toggleKind(kind, $event)">
            {{ kindLabel(kind) }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #jurisdictionMenu>
      <mt-menu aria-label="Jurisdiction">
        @for (jurisdiction of jurisdictionOptions; track jurisdiction) {
          <button
            mtMenuItemCheckbox
            [checked]="jurisdictions().includes(jurisdiction)"
            (checkedChange)="toggleJurisdiction(jurisdiction, $event)"
          >
            {{ jurisdiction }}
          </button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    .mt-deadlines-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      flex: 1;
      min-width: 0;
      max-width: 1040px;
    }
    .mt-deadlines-page .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-deadlines-page h1,
    .mt-deadlines-page h2 {
      margin: 0;
    }
    .mt-deadlines-page .block {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-width: 0;
    }
    .mt-deadlines-page .hint {
      margin: 0;
    }
    .mt-deadlines-page .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-deadlines-page .rows > li + li {
      border-top: 1px solid var(--border-subtle);
    }
    .mt-deadlines-page .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-6);
    }
    .mt-deadlines-page .mt-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-6);
      height: 28px;
      padding: 0 10px;
      border-radius: var(--radius-full);
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      font: 500 12px/16px var(--font-sans);
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
    }
    .mt-deadlines-page .mt-chip[aria-pressed='true'],
    .mt-deadlines-page .mt-chip[data-selected] {
      background: var(--bg-selected);
      border-color: var(--border-focus);
      color: var(--text-brand);
    }
    .mt-deadlines-page .mt-chip:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .mt-deadlines-page .mt-chip mt-icon {
      width: 13px;
      height: 13px;
    }
  `,
})
export class DeadlinesPage {
  protected readonly actions = inject(DeadlineActions);
  private readonly context = inject(OrgContext);
  protected readonly today = inject(MT_TODAY);

  protected readonly canComplete = can('task.edit');
  protected readonly canDecide = can('deadline.override');
  protected readonly statutoryMessage = STATUTORY_DISABLED_MESSAGE;
  protected readonly statutoryOff = statutoryDisabled(() => ['VIC']);

  protected readonly deadlines = deadlineGroupRepository().watchQuery(UPCOMING_DEADLINES_QUERY);
  protected readonly loadError = computed(() => deadlineErrorCopy(this.deadlines.error()));
  private readonly changes = deadlineChangeGroupRepository().watchQuery(() => {
    const uid = this.context.uid();
    return uid ? myPendingChangesQuery(uid) : null;
  });
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  private readonly memberNames = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );
  private readonly matters = matterLookup(() =>
    [
      ...this.deadlines.value().map((row) => row.matterId ?? ''),
      ...this.changes.value().map((row) => row.matterId),
    ].filter(Boolean),
  );

  protected readonly viewOptions: MtOption<View>[] = [
    { value: 'list', label: 'List', icon: 'list' },
    { value: 'calendar', label: 'Calendar', icon: 'calendar' },
  ];
  protected readonly view = signal<View>(storedView());
  protected readonly month = signal(monthOf(this.today()));

  protected readonly kindOptions = DeadlineKindSchema.options;
  protected readonly jurisdictionOptions = JurisdictionSchema.options;
  protected readonly mine = signal(false);
  protected readonly team = signal(false);
  protected readonly critical = signal(false);
  protected readonly kinds = signal<readonly string[]>([]);
  protected readonly jurisdictions = signal<readonly Jurisdiction[]>([]);
  /** What Export writes: the upcoming deadlines these filters match (INS-03). */
  protected readonly exportFilters = computed(() => ({
    mine: this.mine(),
    team: this.team(),
    critical: this.critical(),
    kinds: [...this.kinds()],
    jurisdictions: [...this.jurisdictions()],
  }));
  protected readonly filtered = computed(
    () => this.mine() || this.team() || this.critical() || this.kinds().length + this.jurisdictions().length > 0,
  );
  protected readonly kindText = computed(() => {
    const kinds = this.kinds();
    if (!kinds.length) return 'Kind';
    return kinds.length === 1 ? deadlineKindLabel(kinds[0] as string) : `Kind: ${kinds.length}`;
  });
  protected readonly jurisdictionText = computed(() => {
    const list = this.jurisdictions();
    if (!list.length) return 'Jurisdiction';
    return list.length === 1 ? (list[0] as string) : `Jurisdiction: ${list.length}`;
  });

  /** Every upcoming deadline on a matter, with its matter, through the filters. */
  private readonly rows = computed<DeadlineRowVm[]>(() => {
    const matters = this.matters();
    const uid = this.context.uid() ?? '';
    const filters: DeadlineFilters = {
      mine: this.mine(),
      team: this.team(),
      critical: this.critical(),
      kinds: this.kinds(),
      jurisdictions: this.jurisdictions(),
    };
    return this.deadlines
      .value()
      .filter((deadline) => !!deadline.matterId)
      .map((deadline) => {
        const matterId = deadline.matterId as string;
        return { key: `${matterId}/${deadline.id}`, matterId, deadline, matter: matters.get(matterId) };
      })
      .filter((row) => deadlineMatchesFilters(row.deadline, filters, { uid, matter: row.matter }));
  });
  protected readonly reviewRows = computed(() => this.rows().filter((row) => needsReview(row.deadline)));
  /** The list and calendar leave out the review queue's deadlines (they're above). */
  protected readonly visibleRows = computed(() => this.rows().filter((row) => !needsReview(row.deadline)));
  /** A critical deadline is in view: the moment to offer deadline alerts on this device (MOB-04). */
  protected readonly hasCritical = computed(() => this.visibleRows().some((row) => row.deadline.critical));
  protected readonly groups = computed(() => {
    const byKey = new Map(this.visibleRows().map((row) => [row.key, row] as const));
    const like = this.visibleRows().map((row) => ({ ...row.deadline, id: row.key }));
    return groupDeadlines(like, this.today())
      .filter((group) => group.deadlines.length)
      .map((group) => ({
        id: group.id,
        label: group.label,
        deadlines: group.deadlines.map((row) => byKey.get(row.id) as DeadlineRowVm),
      }));
  });
  protected readonly changeRows = computed<ChangeRowVm[]>(() => {
    const matters = this.matters();
    return this.changes
      .value()
      .map((change) => ({
        key: `${change.matterId}/${change.id}`,
        matterId: change.matterId,
        change,
        matter: matters.get(change.matterId),
      }))
      .sort((a, b) => Number(b.change.critical) - Number(a.change.critical));
  });

  protected readonly isBusy = (key: string) => this.actions.isBusy(key);

  protected memberName(uid: string | undefined): string | undefined {
    if (!uid) return undefined;
    return uid === this.context.uid() ? 'You' : (this.memberNames().get(uid) ?? 'Former member');
  }

  protected kindLabel(kind: string): string {
    return deadlineKindLabel(kind);
  }

  protected setView(value: View | null): void {
    const next = value === 'calendar' ? 'calendar' : 'list';
    this.view.set(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not remembered (private window); the list stands next time.
    }
  }

  protected toggleKind(kind: string, on: boolean): void {
    this.kinds.update((list) => (on ? [...new Set([...list, kind])] : list.filter((k) => k !== kind)));
  }

  protected toggleJurisdiction(jurisdiction: Jurisdiction, on: boolean): void {
    this.jurisdictions.update((list) =>
      on ? [...new Set([...list, jurisdiction])] : list.filter((j) => j !== jurisdiction),
    );
  }

  protected clearFilters(): void {
    this.mine.set(false);
    this.team.set(false);
    this.critical.set(false);
    this.kinds.set([]);
    this.jurisdictions.set([]);
  }

  protected act(row: DeadlineRowVm, action: DeadlineRowAction): void {
    switch (action) {
      case 'done':
      case 'waived':
      case 'missed':
        void this.actions.complete(row, action);
        return;
      case 'acknowledge':
        void this.actions.acknowledge(row);
        return;
      case 'override':
        void this.actions.override(row);
        return;
      case 'clear_override':
        void this.actions.clearOverride(row);
        return;
      case 'edit':
        void this.actions.editManual(row, {
          people: this.assignable(),
          assigneeUid: row.deadline.assigneeUid ?? this.context.uid() ?? '',
        });
        return;
      case 'delete':
        void this.actions.removeManual(row);
        return;
    }
  }

  private assignable() {
    return this.members
      .value()
      .filter((member) => member.status === 'active' && member.role !== 'readonly')
      .map((member) => ({ uid: member.id, name: member.displayName }));
  }
}
