import {
  computed,
  effect,
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';

import { Connectivity, OrgContext } from '@materia/data-access';
import {
  archiveNotifications,
  burstMembersQuery,
  deadlineCallables,
  markNotificationsRead,
  matterDeadlineChangeRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  myInboxQuery,
  notificationsRepo,
  todayMatterRepository,
  type NotificationItem,
} from '@materia/data-access/repository';
import { INBOX_FILTERS, inInboxFilter, type DateOnly, type InboxFilter } from '@materia/domain';
import { MT_ORG_TIMEZONE, MT_TODAY, ToastService } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { dayKey, dayLabel, notificationMatterId, notificationTime } from '../../core/notifications/notification-view';
import { DeadlineActions } from '../deadlines/deadline-actions';
import { deadlineErrorCopy } from '../deadlines/deadline-view';
import { lookupEntry, type TodayMatterRef } from '../today/today-view';

/** The action a notification offers in its row (CORE-22). */
export type InboxAction = 'acknowledge' | 'resolve' | 'review' | 'reconnect';

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  all: 'All',
  mentions: 'Mentions',
  assigned: 'Assigned to me',
  deadlines: 'Deadlines',
  clerk: 'Clerk',
  system: 'System',
};

/** The action in a notification's row: Acknowledge, Accept/Reject, Review or Reconnect. */
export function inboxAction(item: NotificationItem): InboxAction | null {
  switch (item.kind) {
    case 'deadline_escalation':
      return 'acknowledge';
    case 'deadline_changed':
      return item.changeId ? 'resolve' : null;
    case 'suggestion':
    case 'suggestion_ready':
      return 'review';
    case 'integration_error':
      return 'reconnect';
    default:
      return null;
  }
}

/** One row of the list: a notification, or a burst member shown under its summary. */
export interface InboxRow {
  item: NotificationItem;
  /** A member of an expanded burst. */
  member: boolean;
}

export interface InboxDay {
  day: DateOnly;
  label: string;
  rows: InboxRow[];
}

/**
 * The Inbox's data and actions (CORE-22): my in-app notifications, live for the newest 100 and a
 * page at a time after that; the filters and the unread-only switch; the matters they are about
 * (looked up once each, so one I can no longer read says "No longer available"); bursts, expanded
 * on demand; selection; and what each row's action does. Provide it on the page.
 */
@Injectable()
export class InboxData {
  private readonly injector = inject(Injector);
  private readonly context = inject(OrgContext);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly deadlineActions = inject(DeadlineActions);
  private readonly deadlineApi = deadlineCallables(inject(CALLABLES));
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly todayFn = inject(MT_TODAY);
  private readonly repo = notificationsRepo();
  private readonly matterRepo = todayMatterRepository();
  readonly online = inject(Connectivity).online;

  readonly query = this.repo.watchQuery(() => {
    const uid = this.context.uid();
    return uid && this.context.orgId() ? myInboxQuery(uid) : null;
  });
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });

  readonly filter = signal<InboxFilter>('all');
  readonly unreadOnly = signal(false);
  /** Archived here, hidden before the server confirms. */
  private readonly archived = signal<ReadonlySet<string>>(new Set());
  /** Read here while "Unread only" is on: they stay until the filters change, so the list doesn't jump. */
  private readonly keep = signal<ReadonlySet<string>>(new Set());
  /** What happened to a row here ("Acknowledged by Priya Shah"), shown in place of its body. */
  readonly outcomes = signal<ReadonlyMap<string, string>>(new Map());
  /** Expanded bursts and their members (`null` while loading). */
  readonly bursts = signal<ReadonlyMap<string, NotificationItem[] | null>>(new Map());
  /** Ids with a call on its way. */
  readonly busy = signal<ReadonlySet<string>>(new Set());
  readonly selection = signal<ReadonlySet<string>>(new Set());
  /** The row the keyboard and the detail pane are on. */
  readonly activeId = signal<string | null>(null);

  /** Matters looked up: a ref, `null` when it can no longer be read; missing while waiting. */
  private readonly matters = signal<ReadonlyMap<string, TodayMatterRef | null>>(new Map());
  private readonly requested = new Set<string>();

  readonly today = computed(() => this.todayFn());

  private readonly shown = computed(() => {
    const archived = this.archived();
    return this.query.value().filter((item) => !item.hiddenAt && !archived.has(item.id));
  });

  /** How many each chip holds (honouring "Unread only"). */
  readonly counts = computed(() => {
    const keep = this.keep();
    const unreadOnly = this.unreadOnly();
    const rows = this.shown().filter((item) => !unreadOnly || !item.readAt || keep.has(item.id));
    return Object.fromEntries(
      INBOX_FILTERS.map((filter) => [filter, rows.filter((item) => inInboxFilter(item.kind, filter)).length]),
    ) as Record<InboxFilter, number>;
  });

  /** The notifications the filters let through, newest first. */
  readonly visible = computed(() => {
    const filter = this.filter();
    const unreadOnly = this.unreadOnly();
    const keep = this.keep();
    return this.shown().filter(
      (item) => inInboxFilter(item.kind, filter) && (!unreadOnly || !item.readAt || keep.has(item.id)),
    );
  });

  /** The visible notifications by day (the org's time zone), with expanded bursts' members under them. */
  readonly days = computed<InboxDay[]>(() => {
    const today = this.today();
    const bursts = this.bursts();
    const archived = this.archived();
    const days: InboxDay[] = [];
    for (const item of this.visible()) {
      const day = dayKey(item.createdAt, this.timeZone);
      let group = days.at(-1);
      if (group?.day !== day) {
        group = { day, label: dayLabel(day, today), rows: [] };
        days.push(group);
      }
      group.rows.push({ item, member: false });
      for (const member of bursts.get(item.id) ?? []) {
        if (!member.hiddenAt && !archived.has(member.id)) group.rows.push({ item: member, member: true });
      }
    }
    return days;
  });

  /** Every row in order, for the keyboard. */
  readonly rows = computed(() => this.days().flatMap((day) => day.rows.map((row) => row.item)));

  readonly active = computed(() => {
    const id = this.activeId();
    return this.rows().find((item) => item.id === id) ?? null;
  });

  readonly selected = computed(() => {
    const ids = this.selection();
    return this.rows().filter((item) => ids.has(item.id));
  });

  private readonly names = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );

  constructor() {
    // Look up each matter the list mentions, once.
    effect(() => {
      const ids = [
        ...new Set(
          this.query
            .value()
            .map(notificationMatterId)
            .filter((id): id is string => !!id),
        ),
      ].filter((id) => !this.requested.has(id));
      if (ids.length) untracked(() => void this.lookUp(ids));
    });
    // A filter change lets rows read here go (under "Unread only") and drops a selection out of view.
    effect(() => {
      this.filter();
      this.unreadOnly();
      untracked(() => {
        this.keep.set(new Set());
        this.selection.set(new Set());
      });
    });
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
    this.matters.update((map) => {
      const next = new Map(map);
      ids.forEach((id, i) => next.set(id, found[i] ?? null));
      return next;
    });
  }

  // ---------- what a row shows ----------

  /** "WE-142 · Estate of Margaret Whitfield" for a notification about a matter, else `null`. */
  matterLabel(item: NotificationItem): string | null {
    const id = notificationMatterId(item);
    const ref = id ? this.matters().get(id) : undefined;
    if (!ref) return null;
    return [ref.number, ref.title].filter(Boolean).join(' · ') || null;
  }

  matterRef(item: NotificationItem): TodayMatterRef | null | undefined {
    const id = notificationMatterId(item);
    return id ? this.matters().get(id) : undefined;
  }

  /** Its matter can no longer be read (access removed, or the matter deleted). */
  gone(item: NotificationItem): boolean {
    const id = notificationMatterId(item);
    return !!id && this.matters().get(id) === null;
  }

  detail(item: NotificationItem): string | null {
    const outcome = this.outcomes().get(item.id);
    if (outcome) return outcome;
    if (item.collapsedCount) {
      const n = item.collapsedCount;
      return `${n} ${n === 1 ? 'notification' : 'notifications'} arrived together. ${
        this.bursts().has(item.id) ? 'Shown below.' : 'Open to list them.'
      }`;
    }
    return item.body || null;
  }

  time(item: NotificationItem): string {
    return notificationTime(item.createdAt, this.timeZone);
  }

  action(item: NotificationItem): InboxAction | null {
    return this.gone(item) ? null : inboxAction(item);
  }

  isBusy(item: NotificationItem): boolean {
    return this.busy().has(item.id);
  }

  // ---------- selection ----------

  toggle(item: NotificationItem): void {
    this.selection.update((ids) => {
      const next = new Set(ids);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  clearSelection(): void {
    this.selection.set(new Set());
  }

  // ---------- reading and archiving ----------

  /** Marks notifications read (or unread). Under "Unread only", ones read here stay put. */
  async markRead(items: readonly NotificationItem[], read: boolean): Promise<boolean> {
    const changing = items.filter((item) => !!item.readAt !== read);
    if (!changing.length) return true;
    if (read && this.unreadOnly()) this.keep.update((ids) => new Set([...ids, ...changing.map((item) => item.id)]));
    try {
      await markNotificationsRead(
        this.repo,
        changing.map((item) => item.id),
        read,
      );
      return true;
    } catch (error) {
      this.toasts.show({
        title: read ? 'Not marked read' : 'Not marked unread',
        description: errorCopy(error),
        tone: 'danger',
      });
      return false;
    }
  }

  /** Every visible notification read (Shift+E). */
  async markAllRead(): Promise<number> {
    const unread = this.rows().filter((item) => !item.readAt);
    if (!unread.length) return 0;
    const ok = await this.markRead(unread, true);
    if (ok) {
      this.toasts.show({
        title: `${unread.length} ${unread.length === 1 ? 'notification' : 'notifications'} marked read`,
        tone: 'success',
      });
    }
    return ok ? unread.length : 0;
  }

  /** Archives notifications (out of the inbox and the count), with Undo. */
  async archive(items: readonly NotificationItem[]): Promise<void> {
    if (!items.length) return;
    const ids = items.map((item) => item.id);
    this.archived.update((set) => new Set([...set, ...ids]));
    this.selection.update((set) => new Set([...set].filter((id) => !ids.includes(id))));
    const restore = () => this.archived.update((set) => new Set([...set].filter((id) => !ids.includes(id))));
    try {
      await archiveNotifications(this.repo, ids, true);
    } catch (error) {
      restore();
      this.toasts.show({ title: 'Not archived', description: errorCopy(error), tone: 'danger' });
      return;
    }
    const one = ids.length === 1;
    this.toasts.show({
      title: one ? 'Archived' : `${ids.length} notifications archived`,
      tone: 'success',
      action: {
        label: 'Undo',
        run: () => {
          restore();
          archiveNotifications(this.repo, ids, false).catch((error: unknown) =>
            this.toasts.show({ title: 'Not restored', description: errorCopy(error), tone: 'danger' }),
          );
        },
      },
    });
  }

  // ---------- opening ----------

  /** Goes to what it is about and marks it read; a burst summary lists its members instead. */
  async open(item: NotificationItem): Promise<void> {
    if (item.collapsedCount) {
      void this.markRead([item], true);
      await this.expand(item);
      return;
    }
    if (this.gone(item)) {
      this.toasts.show({
        title: 'No longer available',
        description: 'You can’t open the matter this is about any more. Ask an owner or admin if you need it.',
        tone: 'neutral',
      });
      void this.markRead([item], true);
      return;
    }
    void this.markRead([item], true);
    await this.router.navigateByUrl(item.link);
  }

  /** Shows a burst's members under it (once), or hides them again. */
  async expand(summary: NotificationItem): Promise<void> {
    if (this.bursts().has(summary.id)) {
      this.bursts.update((map) => {
        const next = new Map(map);
        next.delete(summary.id);
        return next;
      });
      return;
    }
    const uid = this.context.uid();
    if (!uid) return;
    this.bursts.update((map) => new Map(map).set(summary.id, null));
    try {
      const members = await this.repo.query(burstMembersQuery(uid, summary.id));
      this.bursts.update((map) => (map.has(summary.id) ? new Map(map).set(summary.id, members) : map));
    } catch (error) {
      this.bursts.update((map) => {
        const next = new Map(map);
        next.delete(summary.id);
        return next;
      });
      this.toasts.show({ title: 'Couldn’t list them', description: errorCopy(error), tone: 'danger' });
    }
  }

  // ---------- inline actions ----------

  private async working<T>(item: NotificationItem, work: () => Promise<T>): Promise<T> {
    this.busy.update((ids) => new Set(ids).add(item.id));
    try {
      return await work();
    } finally {
      this.busy.update((ids) => {
        const next = new Set(ids);
        next.delete(item.id);
        return next;
      });
    }
  }

  private say(item: NotificationItem, outcome: string): void {
    this.outcomes.update((map) => new Map(map).set(item.id, outcome));
  }

  /**
   * Acknowledges an escalated deadline (`deadlines-acknowledge`, as on Today and the deadline
   * lists). Already acknowledged by someone else: says who, and when.
   */
  async acknowledge(item: NotificationItem): Promise<void> {
    if (item.kind !== 'deadline_escalation' || this.isBusy(item)) return;
    try {
      const result = await this.working(item, () =>
        this.deadlineApi.acknowledge({ matterId: item.matterId, deadlineId: item.deadlineId }),
      );
      if (result.acknowledged) {
        this.say(item, 'You acknowledged it');
        this.toasts.show({ title: 'Deadline acknowledged', tone: 'success' });
      } else {
        const who = result.ackBy === this.context.uid() ? 'you' : (this.names().get(result.ackBy) ?? 'someone else');
        const when = notificationTime(new Date(result.ackAt), this.timeZone, this.today());
        this.say(item, `Already acknowledged by ${who} (${when})`);
        this.toasts.show({ title: `Already acknowledged by ${who}`, tone: 'neutral' });
      }
      void this.markRead([item], true);
    } catch (error) {
      this.toasts.show({
        title: 'The deadline wasn’t acknowledged',
        description: deadlineErrorCopy(error),
        tone: 'danger',
      });
    }
  }

  /**
   * Accepts or rejects a proposed deadline change (`deadlines-resolveChange`) the way the deadline
   * lists do: a change to a critical deadline asks for the matter number first.
   */
  async resolve(item: NotificationItem, accept: boolean): Promise<void> {
    if (item.kind !== 'deadline_changed' || !item.changeId || this.isBusy(item)) return;
    const { matterId, changeId } = item;
    const done = await this.working(item, async () => {
      const changes = runInInjectionContext(this.injector, () => matterDeadlineChangeRepository(() => matterId));
      let change;
      try {
        change = await changes.get(changeId);
      } catch (error) {
        this.toasts.show({ title: 'Couldn’t read the change', description: deadlineErrorCopy(error), tone: 'danger' });
        return false;
      }
      if (!change || change.status !== 'pending') {
        this.say(item, change ? 'Already decided' : 'No longer applies');
        this.toasts.show({
          title: change ? 'That change was already decided' : 'That change no longer applies',
          tone: 'neutral',
        });
        return true;
      }
      const ref = this.matterRef(item);
      const ok = await this.deadlineActions.resolve(
        {
          key: item.id,
          matterId,
          change,
          matter: ref ? { id: ref.id, number: ref.number, title: ref.title } : undefined,
        },
        accept,
      );
      if (ok) this.say(item, accept ? 'You accepted the change' : 'You rejected the change');
      return ok;
    });
    if (done) void this.markRead([item], true);
  }

  /** Review: the suggestion on its matter (AI-07's review card), or the integration to reconnect. */
  async follow(item: NotificationItem): Promise<void> {
    await this.open(item);
  }
}
