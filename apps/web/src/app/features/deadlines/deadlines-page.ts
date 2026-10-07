import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  viewChild,
  ViewEncapsulation,
  type ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can, OrgContext } from '@materia/data-access';
import {
  deadlineChangeGroupRepository,
  deadlineGroupRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  myPendingChangesQuery,
  REVIEW_QUEUE_QUERY,
  UPCOMING_DEADLINES_QUERY,
  upcomingDeadlinesBetweenQuery,
  type DeadlineItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  deadlineMatchesFilters,
  DeadlineKindSchema,
  groupDeadlines,
  JurisdictionSchema,
  monthCalendarRange,
  needsReview,
  STATUTORY_DISABLED_MESSAGE,
  type DeadlineFilters,
  type Jurisdiction,
} from '@materia/domain';
import {
  formatDateOnly,
  MT_MENU,
  MT_TODAY,
  MtButton,
  MtEmptyState,
  MtIcon,
  MtNote,
  MtSegmentedControl,
  MtSkeleton,
  type MtOption,
} from '@materia/ui';

import { DeadlineActions } from './deadline-actions';
import { DeadlineCalendar } from './deadline-calendar';
import { DeadlineRow, type DeadlineRowAction } from './deadline-row';
import {
  deadlineErrorCopy,
  deadlineKindLabel,
  monthOf,
  sameData,
  type ChangeRowVm,
  type DeadlineMatterRef,
  type DeadlineRowVm,
} from './deadline-view';
import { matterLookup } from './matter-lookup';
import { PendingChanges } from './pending-changes';
import { statutoryDisabled } from './statutory-flag';
import { MtExportButton } from '../../core/exports/export-button';
import { PushDevices } from '../../core/push/push-devices';
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
 *
 * Windowed (SEC-07c): the list reads a page of deadlines at a time by due date (the overdue ones and
 * the next few weeks first) and the next as it scrolls into view; the calendar reads the month it
 * shows; the review queue reads its own. Each row names its matter from the deadline's copy of it
 * (`Deadline.matter`), so no matter is read per row. Filters hide rows rather than redraw them, and
 * nothing below the head is drawn until every query has answered, so rows don't jump.
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
    MtSkeleton,
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

    @switch (state()) {
      @case ('loading') {
        <mt-skeleton variant="rows" label="Loading deadlines…" [count]="6" />
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="retry()">Try again</button>
        </mt-note>
      }
      @default {
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

        @if (reviewRows().length) {
          <section class="block" aria-labelledby="mt-dl-review" [hidden]="!reviewCount()">
            <h2 class="title-m" id="mt-dl-review">
              Needs review <span class="caption t-3">{{ reviewCount() }}{{ review.hasMore() ? '+' : '' }}</span>
            </h2>
            <p class="caption t-2 hint">
              Already past when they were computed. Mark each done, waive it, confirm it missed or override its date.
            </p>
            <ul class="rows">
              @for (row of reviewRows(); track row.key) {
                @let shown = matching().has(row.key);
                <li [attr.data-filtered]="shown ? null : ''" [attr.aria-hidden]="shown ? null : 'true'">
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
          @if (calendarDeadlines.status() === 'error') {
            <mt-note tone="danger">
              {{ calendarError() }}
              <button mtButton size="sm" (click)="calendarDeadlines.refresh()">Try again</button>
            </mt-note>
          }
          <mt-deadline-calendar
            [month]="month()"
            [rows]="calendarRows()"
            [today]="today()"
            [attr.aria-busy]="calendarDeadlines.status() === 'loading' ? 'true' : null"
            (monthChange)="month.set($event)"
          />
          @if (calendarDeadlines.status() === 'loading') {
            <p class="caption t-3" role="status">Loading deadlines…</p>
          } @else if (calendarDeadlines.hasMore()) {
            <div class="more">
              <p class="caption t-2">Showing the first {{ calendarDeadlines.value().length }} deadlines here.</p>
              <button
                mtButton
                size="sm"
                [loading]="calendarDeadlines.loadingMore()"
                (click)="calendarDeadlines.loadMore()"
              >
                Show more
              </button>
            </div>
          }
        } @else {
          @if (deadlines.newItems(); as count) {
            <button mtButton size="sm" class="fresh" (click)="deadlines.refresh()">
              {{ count === 1 ? '1 new deadline' : count + ' new deadlines' }}
            </button>
          }
          <div class="groups">
            @for (group of groups(); track group.id) {
              @let count = groupCounts().get(group.id) ?? 0;
              <section
                class="block"
                [attr.data-empty]="count ? null : ''"
                [attr.aria-hidden]="count ? null : 'true'"
                [attr.aria-labelledby]="'mt-dl-' + group.id"
                [attr.data-group]="group.id"
              >
                <h2 class="title-m" [id]="'mt-dl-' + group.id">
                  {{ group.label }}
                  <span class="caption t-3">{{ count }}{{ $last && deadlines.hasMore() ? '+' : '' }}</span>
                </h2>
                <ul class="rows">
                  @for (row of group.deadlines; track row.key) {
                    @let shown = matching().has(row.key);
                    <li [attr.data-filtered]="shown ? null : ''" [attr.aria-hidden]="shown ? null : 'true'">
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
          </div>
          @if (deadlines.hasMore()) {
            <div class="more" #more>
              @if (filtered()) {
                <p class="caption t-2">
                  {{ shownCount() ? 'These filters cover' : 'Nothing matches these filters among' }} the deadlines due
                  by {{ loadedThrough() }}.
                </p>
              }
              <button mtButton size="sm" [loading]="deadlines.loadingMore()" (click)="loadMore()">
                Show later deadlines
              </button>
            </div>
          } @else if (!shownCount()) {
            @if (filtered()) {
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
    .mt-deadlines-page .block[hidden] {
      display: none;
    }
    .mt-deadlines-page .groups {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .mt-deadlines-page .groups > .block:not([data-empty]) ~ .block:not([data-empty]) {
      margin-top: var(--space-16);
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
    .mt-deadlines-page .rows > li:not([data-filtered]) ~ li:not([data-filtered]) {
      border-top: 1px solid var(--border-subtle);
    }
    /* Rows off screen aren't laid out or painted until they near it: a page of 100, or a filter
       showing them again, costs what the screen shows (SEC-07c). */
    .mt-deadlines-page .rows > li {
      content-visibility: auto;
      contain-intrinsic-size: auto 96px;
    }
    /* A row the filters leave out, and a group left empty, take no space and aren't drawn. Not
       display: none, which would size every button inside to nothing and wake each one's resize
       observer, which then reads its style: about 2 ms a row on a slow phone (SEC-07c). */
    .mt-deadlines-page .rows > li[data-filtered],
    .mt-deadlines-page .groups > .block[data-empty] {
      content-visibility: hidden;
      contain-intrinsic-size: 0 0;
    }
    .mt-deadlines-page .fresh {
      align-self: flex-start;
    }
    .mt-deadlines-page .more {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: var(--space-8);
      text-align: center;
    }
    .mt-deadlines-page .more p {
      margin: 0;
      flex-basis: 100%;
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
  private readonly push = inject(PushDevices);
  protected readonly today = inject(MT_TODAY);

  protected readonly canComplete = can('task.edit');
  protected readonly canDecide = can('deadline.override');
  protected readonly statutoryMessage = STATUTORY_DISABLED_MESSAGE;
  protected readonly statutoryOff = statutoryDisabled(() => ['VIC']);

  protected readonly viewOptions: MtOption<View>[] = [
    { value: 'list', label: 'List', icon: 'list' },
    { value: 'calendar', label: 'Calendar', icon: 'calendar' },
  ];
  protected readonly view = signal<View>(storedView());
  protected readonly month = signal(monthOf(this.today()));

  private readonly repo = deadlineGroupRepository();
  /** The list: a page of upcoming deadlines at a time, by due date. */
  protected readonly deadlines = this.repo.watchQuery(() => (this.view() === 'list' ? UPCOMING_DEADLINES_QUERY : null));
  /** The calendar: the upcoming deadlines on the days its month shows. */
  protected readonly calendarDeadlines = this.repo.watchQuery(() => {
    if (this.view() !== 'calendar') return null;
    const { from, to } = monthCalendarRange(this.month());
    return upcomingDeadlinesBetweenQuery(from, to);
  });
  protected readonly review = this.repo.watchQuery(REVIEW_QUEUE_QUERY);
  private readonly changes = deadlineChangeGroupRepository().watchQuery(() => {
    const uid = this.context.uid();
    return uid ? myPendingChangesQuery(uid) : null;
  });
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  private readonly memberNames = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );
  /**
   * Matters read one by one: only for deadlines without their copy (written before SEC-07c, until
   * `backfill-deadline-matters` runs) and for the changes waiting on me.
   */
  private readonly matters = matterLookup(() =>
    [
      ...[this.deadlines, this.calendarDeadlines, this.review].flatMap((query) =>
        query.value().flatMap((row) => (row.matterId && !row.matter ? [row.matterId] : [])),
      ),
      ...this.changes.value().map((row) => row.matterId),
    ].filter(Boolean),
  );

  /**
   * What is drawn below the head: nothing until the list (or, on the calendar, the review queue),
   * the changes waiting on me and whether to offer deadline alerts (this browser's own record) are
   * known, so nothing jumps when a later one arrives.
   */
  protected readonly state = computed<'loading' | 'error' | 'ready'>(() => {
    const list = this.view() === 'list' ? this.deadlines.status() : 'ready';
    const review = this.review.status();
    if (list === 'error' || review === 'error') return 'error';
    const waiting = list === 'loading' || review === 'loading' || this.changes.status() === 'loading';
    return waiting || !this.push.loaded() ? 'loading' : 'ready';
  });
  protected readonly loadError = computed(() => deadlineErrorCopy(this.deadlines.error() ?? this.review.error()));
  protected readonly calendarError = computed(() => deadlineErrorCopy(this.calendarDeadlines.error()));

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
  private readonly matches = computed(() => {
    const uid = this.context.uid() ?? '';
    const filters: DeadlineFilters = {
      mine: this.mine(),
      team: this.team(),
      critical: this.critical(),
      kinds: this.kinds(),
      jurisdictions: this.jurisdictions(),
    };
    return (row: DeadlineRowVm) => deadlineMatchesFilters(row.deadline, filters, { uid, matter: row.matter });
  });

  /** The list's deadlines, review queue's aside (it's above), each with its matter. Filters don't change it. */
  private readonly listRows = computed(() =>
    this.rowsOf(this.deadlines.value()).filter((row) => !needsReview(row.deadline)),
  );
  protected readonly reviewRows = computed(() => this.rowsOf(this.review.value()));
  protected readonly calendarRows = computed(() => {
    const matches = this.matches();
    return this.rowsOf(this.calendarDeadlines.value()).filter((row) => !needsReview(row.deadline) && matches(row));
  });
  /** The keys of the list and review rows these filters keep; the rest are set aside, not redrawn. */
  protected readonly matching = computed(() => {
    const matches = this.matches();
    return new Set([...this.listRows(), ...this.reviewRows()].filter(matches).map((row) => row.key));
  });
  protected readonly reviewCount = computed(
    () => this.reviewRows().filter((row) => this.matching().has(row.key)).length,
  );
  protected readonly groups = computed(() => {
    const byKey = new Map(this.listRows().map((row) => [row.key, row] as const));
    const like = this.listRows().map((row) => ({ ...row.deadline, id: row.key }));
    return groupDeadlines(like, this.today())
      .filter((group) => group.deadlines.length)
      .map((group) => ({
        id: group.id,
        label: group.label,
        deadlines: group.deadlines.map((row) => byKey.get(row.id) as DeadlineRowVm),
      }));
  });
  /** Each group's rows these filters keep. */
  protected readonly groupCounts = computed(() => {
    const matching = this.matching();
    return new Map(
      this.groups().map((group) => [group.id, group.deadlines.filter((row) => matching.has(row.key)).length] as const),
    );
  });
  protected readonly shownCount = computed(() => [...this.groupCounts().values()].reduce((sum, n) => sum + n, 0));
  /** The last loaded deadline's due date: the list has every deadline due before it. */
  protected readonly loadedThrough = computed(() => {
    const last = this.deadlines.value().at(-1)?.dueDate;
    return last ? formatDateOnly(last) : '';
  });
  /**
   * A critical deadline is on the page: the moment to offer deadline alerts on this device (MOB-04).
   * Whatever the filters, so the offer doesn't come and go as they change.
   */
  protected readonly hasCritical = computed(() =>
    (this.view() === 'calendar' ? this.rowsOf(this.calendarDeadlines.value()) : this.listRows()).some(
      (row) => row.deadline.critical,
    ),
  );
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

  /** The list's end: the next page loads as it nears the screen, unless filters are on (then on the button). */
  private readonly more = viewChild<ElementRef<HTMLElement>>('more');

  constructor() {
    void this.push.load();
    let observer: IntersectionObserver | undefined;
    effect(() => {
      observer?.disconnect();
      observer = undefined;
      const target = this.more()?.nativeElement;
      if (!target || this.filtered() || typeof IntersectionObserver === 'undefined') return;
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this.loadMore();
        },
        { rootMargin: '0px 0px 600px 0px' },
      );
      observer.observe(target);
    });
    inject(DestroyRef).onDestroy(() => observer?.disconnect());
  }

  /**
   * The rows drawn, by key. A row whose deadline and matter are unchanged is kept, so a snapshot
   * that changes nothing in it (the server confirming the cache, or a page read again when the next
   * one loads) doesn't redraw it.
   */
  private readonly drawn = new Map<string, DeadlineRowVm>();

  /**
   * Rows for deadlines on a matter, each with its matter: the deadline's copy, or else the one read
   * for it (the lookup is only read, and so only watched, when a deadline has no copy).
   */
  private rowsOf(list: readonly WithId<DeadlineItem>[]): DeadlineRowVm[] {
    let lookup: ReadonlyMap<string, DeadlineMatterRef> | undefined;
    return list.flatMap((deadline) => {
      const matterId = deadline.matterId;
      if (!matterId) return [];
      const matter: DeadlineMatterRef | undefined = deadline.matter
        ? { id: matterId, ...deadline.matter }
        : (lookup ??= this.matters()).get(matterId);
      const key = `${matterId}/${deadline.id}`;
      const kept = this.drawn.get(key);
      if (kept && sameData(kept.deadline, deadline) && sameData(kept.matter, matter)) return [kept];
      const row = { key, matterId, deadline, matter };
      this.drawn.set(key, row);
      return [row];
    });
  }

  protected loadMore(): void {
    if (!this.deadlines.hasMore() || this.deadlines.loadingMore()) return;
    void this.deadlines.loadMore();
  }

  protected retry(): void {
    for (const query of [this.deadlines, this.review]) {
      if (query.status() === 'error') query.refresh();
    }
  }

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
