import { DOCUMENT } from '@angular/common';
import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  InjectionToken,
  Injector,
  PendingTasks,
  runInInjectionContext,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

import { can, Connectivity, DATA_CLOCK, OrgContext } from '@materia/data-access';
import {
  ACTIVE_MEMBERS_QUERY,
  deadlineChangeGroupRepository,
  deadlineGroupRepository,
  matterCountQuery,
  memberCountRepository,
  deadlineCallables,
  myDeadlinesThisWeekQuery,
  myEscalationsQuery,
  myNextTasksQuery,
  myOpenTaskCountQuery,
  myOverdueDeadlinesQuery,
  myTasksThisWeekQuery,
  myTodayChangesQuery,
  orgTimeZoneRepository,
  periodMetricsRepository,
  recentMattersQuery,
  recentMattersRepository,
  taskGroupRepository,
  todayMatterRepository,
  type QueryResource,
} from '@materia/data-access/repository';
import {
  compareMyTasks,
  dateOnlyAt,
  DEFAULT_ORG_TIMEZONE,
  dueThisWeek,
  greeting,
  hourIn,
  longDayLabel,
  metricPeriods,
  monthWindow,
  needsAttention,
  onboardingSteps,
  TODAY_TASKS_SHOWN,
  timeZoneHint,
  todayItemKey,
  todayWindow,
  type TodayEscalationLike,
} from '@materia/domain';
import { ToastService } from '@materia/ui';

import {
  copiedRef,
  lookupEntry,
  visibleRows,
  type AttentionVm,
  type DueVm,
  type MatterLookup,
  type TodayChangeVm,
  type TodayDeadlineVm,
  type TodayMatterRef,
} from './today-view';
import { AuthState } from '../../core/auth/auth-state';
import { CALLABLES } from '../../core/data/callables';
import { deadlineErrorCopy } from '../deadlines/deadline-view';
import { TaskActions } from '../tasks/task-actions';
import { taskEntry, type TaskEntry, type TaskRecord } from '../tasks/task-view';

/** This device's time zone (null when the browser doesn't say). */
export const DEVICE_TIME_ZONE = new InjectionToken<string | null>('DEVICE_TIME_ZONE', {
  factory: () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return null;
    }
  },
});

/** A refresh on focus at most this often. */
const REFRESH_GAP_MS = 10_000;
/** How often the clock moves on (the greeting, and the day at midnight). */
const TICK_MS = 60_000;
/** The longest the sections wait to be drawn together (see `TodayData.settled`). */
const SETTLE_MS = 2500;

/** Today's numbers: null while unknown (loading, offline or refused). */
export interface TodayCounts {
  openMatters: number | null;
  deadlinesThisWeek: number | null;
  openTasks: number | null;
  /** Live matters in the practice the person can see: 0 shows the onboarding checklist. */
  orgMatters: number | null;
  activeMembers: number | null;
  /** WIP this month in cents (roles that record time; see `TodayData.wip`). */
  wipCents: number | null;
}

const NO_COUNTS: TodayCounts = {
  openMatters: null,
  deadlinesThisWeek: null,
  openTasks: null,
  orgMatters: null,
  activeMembers: null,
  wipCents: null,
};

/**
 * Everything the Today screen reads (CORE-14), for the signed-in person in the active org. Provide
 * it on the page, with `TaskActions`.
 *
 * - The day is today in the org's time zone (`orgs/{orgId}.timezone`); the clock moves on every
 *   minute and when the window regains focus, so the day turns over at the org's midnight.
 * - Needs attention listens live (overdue deadlines and changes waiting on me). Everything else is
 *   read once, showing this device's cache first, and read again on focus and after a task changes.
 * - Counts use count aggregation, and aren't asked for while offline. WIP this month (roles that
 *   record time) is one document: my figures for the month from INS-01's rollups (ADR-048), read
 *   with the counts, rather than every entry I recorded this month (SEC-07's read budget).
 * - Rows are named from their copy of their matter (SEC-07e: deadlines, proposals, tasks and recent
 *   entries carry its number, title and type), so the screen reads no matters. It looks a matter up
 *   only for a row without a usable copy: one written before the copies (until
 *   `backfill-matter-copies` runs), or a privileged matter's task, whose copy has no name.
 * - Rows on matters the person can't read (or that were deleted) are left out silently.
 */
@Injectable()
export class TodayData {
  private readonly context = inject(OrgContext);
  private readonly auth = inject(AuthState);
  private readonly clock = inject(DATA_CLOCK);
  private readonly tasks = inject(TaskActions);
  private readonly toasts = inject(ToastService);
  private readonly deadlineApi = deadlineCallables(inject(CALLABLES));
  private readonly deviceZone = inject(DEVICE_TIME_ZONE);
  readonly online = inject(Connectivity).online;
  readonly canEditTasks = can('task.edit');
  private readonly privilegedVisible = can('privileged.view');
  private readonly canCreateMatter = can('matter.create');
  private readonly canInvite = can('members.manage');
  readonly canRecordTime = can('time.record');

  // ---------- the day ----------

  private readonly orgs = orgTimeZoneRepository();
  private readonly orgZone = signal<string | null>(null);
  readonly timeZone = computed(() => this.orgZone() ?? DEFAULT_ORG_TIMEZONE);
  readonly now = signal(this.clock());
  readonly today = computed(() => dateOnlyAt(new Date(this.now()), this.timeZone()));
  readonly window = computed(() => todayWindow(this.today()));
  readonly month = computed(() => monthWindow(this.today()));
  readonly dateLabel = computed(() => longDayLabel(this.today()));
  readonly greeting = computed(() =>
    greeting(hourIn(new Date(this.now()), this.timeZone()), this.auth.session()?.displayName),
  );
  readonly zoneHint = computed(() => timeZoneHint(this.timeZone(), this.deviceZone, new Date(this.now())));

  // ---------- sources ----------

  private readonly overdue = deadlineGroupRepository().watchQuery(() => {
    const uid = this.context.uid();
    return uid ? myOverdueDeadlinesQuery(uid, this.today()) : null;
  });
  private readonly changes = deadlineChangeGroupRepository().watchQuery(() => {
    const uid = this.context.uid();
    return uid ? myTodayChangesQuery(uid) : null;
  });
  /** Critical deadlines escalated to me (CORE-11) that nobody has acknowledged yet. */
  private readonly escalated = deadlineGroupRepository().watchQuery(() => {
    const uid = this.context.uid();
    return uid ? myEscalationsQuery(uid) : null;
  });
  /** Escalations acknowledged here, hidden until the live read catches up. */
  private readonly acknowledged = signal<ReadonlySet<string>>(new Set());
  readonly escalations = computed((): readonly TodayEscalationLike[] => {
    const done = this.acknowledged();
    return (this.escalated.value() ?? [])
      .filter((row) => !row.ackAt && !done.has(row.id))
      .map((row) => ({ id: row.id, matterId: row.matterId, title: row.title }));
  });
  private readonly dueDeadlines = deadlineGroupRepository().watchQuery(
    () => {
      const uid = this.context.uid();
      return uid ? myDeadlinesThisWeekQuery(uid, this.window()) : null;
    },
    { live: false, cacheFirst: true },
  );
  private readonly dueTasks = taskGroupRepository().watchQuery(
    () => {
      const uid = this.context.uid();
      return uid ? myTasksThisWeekQuery(uid, this.window()) : null;
    },
    { live: false, cacheFirst: true },
  );
  private readonly nextTasks = taskGroupRepository().watchQuery(
    () => {
      const uid = this.context.uid();
      return uid ? myNextTasksQuery(uid, TODAY_TASKS_SHOWN) : null;
    },
    { live: false, cacheFirst: true },
  );
  private readonly recents = recentMattersRepository().watchQuery(
    () => {
      const orgId = this.context.orgId();
      return orgId ? recentMattersQuery(orgId) : null;
    },
    { live: false, cacheFirst: true },
  );
  /** My figures for a month (`metrics/month-YYYY-MM/byMember`), by month, for WIP this month. */
  private readonly injector = inject(Injector);
  private readonly memberMonths = new Map<string, ReturnType<typeof periodMetricsRepository>>();
  private readonly oneShot: readonly QueryResource<unknown>[] = [
    this.dueDeadlines,
    this.dueTasks,
    this.nextTasks,
    this.recents,
  ];

  // ---------- matters ----------

  /** Every row's matter id and copy of its matter, whatever its section. */
  private readonly rows = computed(() => [
    ...this.overdue.value(),
    ...this.changes.value(),
    ...(this.escalated.value() ?? []),
    ...this.dueDeadlines.value(),
    ...this.dueTasks.value(),
    ...this.nextTasks.value(),
    ...this.recents.value(),
  ]);
  /**
   * The matters the rows' copies name (SEC-07e). A copy that leaves its rows out (deleted, or
   * privileged and not for this person) wins over one that names the matter.
   */
  private readonly copied = computed((): MatterLookup => {
    const privilegedVisible = this.privilegedVisible();
    const map = new Map<string, TodayMatterRef | null>();
    for (const row of this.rows()) {
      if (!row.matterId) continue;
      const ref = copiedRef(row.matterId, row.matter, privilegedVisible);
      if (ref === null) map.set(row.matterId, null);
      else if (ref && !map.has(row.matterId)) map.set(row.matterId, ref);
    }
    return map;
  });
  private readonly matterRepo = todayMatterRepository();
  /** Matters looked up because no row's copy could name them. */
  private readonly lookup = signal<MatterLookup>(new Map());
  readonly matters = computed((): MatterLookup => {
    const matters = new Map(this.copied());
    for (const [id, ref] of this.lookup()) if (!matters.has(id)) matters.set(id, ref);
    return matters;
  });
  private readonly requested = new Set<string>();
  /** The matters to look up: those no row's copy names. */
  private readonly matterIds = computed(() => {
    const copied = this.copied();
    const ids = this.rows().map((row) => row.matterId);
    return [...new Set(ids.filter((id): id is string => !!id && !copied.has(id)))];
  });

  // ---------- counts ----------

  private readonly matterCounts = todayMatterRepository();
  private readonly memberCounts = memberCountRepository();
  private readonly deadlineCounts = deadlineGroupRepository();
  private readonly taskCounts = taskGroupRepository();
  private readonly countState = signal<TodayCounts>(NO_COUNTS);
  readonly counts = this.countState.asReadonly();
  private readonly countsAnswered = signal(false);

  // ---------- the first paint ----------

  /** Every source has its first answer: the rows, the matters looked up, and (online) the counts. */
  private readonly answered = computed(() => {
    if ([this.overdue, this.changes, ...this.oneShot].some((source) => source.status() === 'loading')) return false;
    const lookup = this.lookup();
    if (this.matterIds().some((id) => !lookup.has(id))) return false;
    return this.countsAnswered() || !this.online();
  });
  private readonly settledOnce = signal(false);
  /**
   * The sections are drawn together once every source has answered (from this device's cache when
   * it has one), or after `SETTLE_MS` at most, so nothing on the page moves as each answer lands.
   * Stays true from then on.
   */
  readonly settled = this.settledOnce.asReadonly();

  // ---------- what the screen shows ----------

  /** Overdue deadlines, changes and escalations, in `needsAttention` order. */
  readonly attention = computed(() => {
    const matters = this.matters();
    const section = needsAttention(
      {
        overdue: visibleRows(this.overdue.value(), matters),
        changes: visibleRows(this.changes.value(), matters),
        escalations: visibleRows(this.escalations(), matters),
      },
      this.today(),
    );
    const items = section.items.map((item): AttentionVm => {
      switch (item.kind) {
        case 'change':
          return { kind: 'change', key: item.key, change: this.changeVm(item.row, item.key, item.urgent, matters) };
        case 'overdue':
          return { kind: 'overdue', key: item.key, deadline: this.deadlineVm(item.row, item.key, matters) };
        case 'escalation':
          return {
            kind: 'escalation',
            key: item.key,
            escalation: item.row,
            matter: item.row.matterId ? (matters.get(item.row.matterId) ?? null) : null,
          };
      }
    });
    return {
      items,
      truncated: section.truncated || this.overdue.hasMore() || this.changes.hasMore() || this.escalated.hasMore(),
    };
  });
  readonly attentionStatus = combinedStatus([this.overdue, this.changes, this.escalated]);

  /** Deadlines and tasks due from today to Sunday, merged (`dueThisWeek`). */
  readonly due = computed(() => {
    const matters = this.matters();
    const section = dueThisWeek(
      {
        deadlines: visibleRows(this.dueDeadlines.value(), matters),
        tasks: visibleRows(this.dueTasks.value(), matters),
      },
      this.window(),
    );
    const items = section.items.map((item): DueVm =>
      item.kind === 'deadline'
        ? {
            kind: 'deadline',
            key: item.key,
            dueDate: item.dueDate,
            deadline: this.deadlineVm(item.row, item.key, matters),
          }
        : { kind: 'task', key: item.key, dueDate: item.dueDate, entry: this.taskEntry(item.row, matters) },
    );
    return {
      items,
      truncated: section.truncated || this.dueDeadlines.hasMore() || this.dueTasks.hasMore(),
    };
  });
  readonly dueStatus = combinedStatus([this.dueDeadlines, this.dueTasks]);

  /** My next open tasks with a date (most overdue first), for the short My tasks list. */
  readonly myTasks = computed(() => {
    const matters = this.matters();
    return [...visibleRows(this.nextTasks.value(), matters)].sort(compareMyTasks).map((task) => ({
      key: todayItemKey('task', task),
      entry: this.taskEntry(task, matters),
    }));
  });
  readonly myTasksStatus = this.nextTasks.status;

  /** The matters I opened lately that I can still read. */
  readonly recentMatters = computed(() => {
    const matters = this.matters();
    return this.recents
      .value()
      .map((row) => (row.matterId ? matters.get(row.matterId) : undefined))
      .filter((matter): matter is TodayMatterRef => !!matter);
  });
  readonly recentStatus = this.recents.status;

  /**
   * WIP this month: the value of my billable time dated this month that isn't billed yet, in cents
   * (`wipThisMonth`'s figure: `time.recordedCents` less `time.billedCents` in my month rollup, kept
   * by the metrics triggers a second or two behind a write); null for roles that don't record time.
   * Its cents are null while unknown (loading, refused or offline), like the counts.
   */
  readonly wip = computed(() => {
    if (!this.canRecordTime()) return null;
    return { cents: this.online() ? this.counts().wipCents : null };
  });

  /** The checklist for a practice without matters; null once it has one (or while unknown). */
  readonly onboarding = computed(() => {
    const { orgMatters, activeMembers } = this.counts();
    if (orgMatters !== 0) return null;
    return onboardingSteps({
      matterCount: orgMatters,
      memberCount: activeMembers ?? 1,
      canCreateMatter: this.canCreateMatter(),
      canInvite: this.canInvite(),
    });
  });

  /** Every task on screen by its Today key (Space completes the focused one). */
  readonly taskEntries = computed(() => {
    const map = new Map<string, TaskEntry>();
    for (const item of this.due().items) if (item.kind === 'task') map.set(item.key, item.entry);
    for (const item of this.myTasks()) map.set(item.key, item.entry);
    return map;
  });

  private lastRefresh = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);

    // The org's time zone, read once per org (the day boundary).
    effect(() => {
      const orgId = this.context.orgId();
      if (!orgId) return;
      untracked(() => void this.loadTimeZone(orgId));
    });

    effect(() => {
      const missing = this.matterIds().filter((id) => !this.requested.has(id));
      if (!missing.length) return;
      untracked(() => void this.lookUp(missing));
    });

    effect(() => {
      const uid = this.context.uid();
      const orgId = this.context.orgId();
      this.window();
      if (!uid || !orgId) return;
      untracked(() => void this.loadCounts(uid));
    });

    // A task changed here (completed, undone): read the task lists again.
    let seen = untracked(this.tasks.writes);
    effect(() => {
      const writes = this.tasks.writes();
      if (writes === seen) return;
      seen = writes;
      untracked(() => {
        this.dueTasks.refresh();
        this.nextTasks.refresh();
      });
    });

    // The app isn't stable until the sections are drawn, so whatever waits for it sees them.
    const firstPaint = inject(PendingTasks).add();
    effect(() => {
      if (!this.settledOnce() && this.answered()) this.settledOnce.set(true);
      if (this.settledOnce()) firstPaint();
    });
    destroyRef.onDestroy(firstPaint);

    // Back to the tab: move the clock on and read the one-shot sections again.
    const document = inject(DOCUMENT);
    const view = document.defaultView;
    const settle = view?.setTimeout(() => this.settledOnce.set(true), SETTLE_MS);
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') this.refresh();
    };
    view?.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const tick = view?.setInterval(() => this.now.set(this.clock()), TICK_MS);
    destroyRef.onDestroy(() => {
      view?.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (tick !== undefined) view?.clearInterval(tick);
      if (settle !== undefined) view?.clearTimeout(settle);
    });
  }

  /** Reads the one-shot sections, the counts and the matters again (on focus, at most every 10 s). */
  refresh(force = false): void {
    const now = this.clock();
    this.now.set(now);
    if (!this.online() || (!force && now - this.lastRefresh < REFRESH_GAP_MS)) return;
    this.lastRefresh = now;
    for (const resource of this.oneShot) resource.refresh();
    const uid = this.context.uid();
    if (uid) void this.loadCounts(uid);
    const ids = [...this.requested];
    if (ids.length) void this.lookUp(ids);
  }

  /**
   * Acknowledges an escalated deadline (`deadlines-acknowledge`), which stops it escalating and
   * takes it off the list. A failure is a toast; the row stays.
   */
  async acknowledge(row: TodayEscalationLike): Promise<boolean> {
    if (!row.matterId) return false;
    try {
      await this.deadlineApi.acknowledge({ matterId: row.matterId, deadlineId: row.id });
    } catch (error) {
      this.toasts.show({
        title: 'Couldn’t acknowledge the deadline',
        description: deadlineErrorCopy(error),
        tone: 'danger',
      });
      return false;
    }
    this.acknowledged.update((ids) => new Set(ids).add(row.id));
    this.toasts.show({ title: 'Deadline acknowledged', tone: 'success' });
    return true;
  }

  /** After a deadline closed from Today: the one-shot due list reads again (the rest is live). */
  refreshDeadlines(): void {
    this.dueDeadlines.refresh();
  }

  private async loadTimeZone(orgId: string): Promise<void> {
    try {
      const org = await this.orgs.get(orgId);
      if (this.context.orgId() === orgId && org?.timezone) this.orgZone.set(org.timezone);
    } catch {
      // Unreadable or offline without a cache: the default time zone stands.
    }
  }

  private async lookUp(ids: readonly string[]): Promise<void> {
    ids.forEach((id) => this.requested.add(id));
    const found = await Promise.all(
      ids.map((id) =>
        this.matterRepo.get(id).then(
          (matter) => lookupEntry(id, { matter }),
          (error: unknown) => lookupEntry(id, { error }),
        ),
      ),
    );
    this.lookup.update((map) => {
      const next = new Map(map);
      ids.forEach((id, i) => next.set(id, found[i] ?? null));
      return next;
    });
  }

  private async loadCounts(uid: string): Promise<void> {
    if (!this.online()) return;
    const ask = (work: () => Promise<number>) => work().catch(() => null);
    const privilegedVisible = this.privilegedVisible();
    const [openMatters, deadlinesThisWeek, openTasks, orgMatters, activeMembers, wipCents] = await Promise.all([
      ask(() => this.matterCounts.count(matterCountQuery({ privilegedVisible, responsibleUid: uid, status: 'open' }))),
      ask(() => this.deadlineCounts.count(myDeadlinesThisWeekQuery(uid, this.window()))),
      ask(() => this.taskCounts.count(myOpenTaskCountQuery(uid))),
      ask(() => this.matterCounts.count(matterCountQuery({ privilegedVisible }))),
      ask(() => this.memberCounts.count(ACTIVE_MEMBERS_QUERY)),
      this.canRecordTime() ? ask(() => this.loadWip(uid)) : Promise.resolve(null),
    ]);
    if (this.context.uid() !== uid) return;
    this.countState.set({ openMatters, deadlinesThisWeek, openTasks, orgMatters, activeMembers, wipCents });
    this.countsAnswered.set(true);
  }

  /**
   * WIP this month from my month rollup (INS-01): what I recorded less what was billed, as
   * `wipThisMonth` adds up my entries. No document yet means no time this month.
   */
  private async loadWip(uid: string): Promise<number> {
    const period = metricPeriods(this.month().start).month;
    let months = this.memberMonths.get(period);
    if (!months) {
      months = runInInjectionContext(this.injector, () => periodMetricsRepository(period, 'byMember'));
      this.memberMonths.set(period, months);
    }
    const values = (await months.get(uid))?.values ?? {};
    return (values['time.recordedCents'] ?? 0) - (values['time.billedCents'] ?? 0);
  }

  private deadlineVm(deadline: TodayDeadlineVm['deadline'], key: string, matters: MatterLookup): TodayDeadlineVm {
    const matterId = deadline.matterId ?? '';
    return {
      key,
      rowKey: `${matterId}/${deadline.id}`,
      matterId,
      deadline,
      matter: matters.get(matterId) ?? { id: matterId, number: '', title: '' },
    };
  }

  private changeVm(
    change: TodayChangeVm['change'],
    key: string,
    urgent: boolean,
    matters: MatterLookup,
  ): TodayChangeVm {
    return {
      key,
      rowKey: `${change.matterId}/${change.id}`,
      matterId: change.matterId,
      change,
      matter: matters.get(change.matterId) ?? { id: change.matterId, number: '', title: '' },
      urgent,
    };
  }

  private taskEntry(task: TaskRecord, matters: MatterLookup): TaskEntry {
    const matterId = task.matterId ?? null;
    const matter = matterId ? (matters.get(matterId) ?? { id: matterId, number: '', title: '' }) : null;
    // They're all mine: no avatar on each row.
    const me = { uid: this.context.uid() ?? '', name: 'You', status: 'active' };
    const entry = taskEntry(task, { members: [me], canEdit: this.canEditTasks(), matter });
    return { ...entry, vm: { ...entry.vm, assignee: null } };
  }
}

/** One status for a section read from several sources: loading until all have answered. */
function combinedStatus(
  resources: readonly QueryResource<unknown>[],
): Signal<'loading' | 'ready' | 'error' | 'offline'> {
  return computed(() => {
    const statuses = resources.map((resource) => resource.status());
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('loading')) return 'loading';
    if (statuses.includes('offline')) return 'offline';
    return 'ready';
  });
}
