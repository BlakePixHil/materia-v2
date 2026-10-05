import { computed, DestroyRef, effect, inject, Injectable, InjectionToken, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { Connectivity, OrgContext } from '@materia/data-access';
import {
  markNotificationsRead,
  myUnreadNotificationsQuery,
  notificationsRepo,
  UNREAD_BADGE_LIMIT,
  type NotificationItem,
} from '@materia/data-access/repository';
import { ToastService } from '@materia/ui';

/**
 * How long after the shell starts the unread listener attaches: the page's own reads go first, and
 * the badge follows a moment later.
 */
export const NOTIFICATIONS_START_DELAY_MS = new InjectionToken<number>('NOTIFICATIONS_START_DELAY_MS', {
  providedIn: 'root',
  factory: () => 1500,
});

/** At most this many urgent notifications get their own toast at once; the rest are summed up. */
export const URGENT_TOASTS_AT_ONCE = 2;

const isUrgent = (item: NotificationItem) => item.priority === 'high' || item.priority === 'critical';

/**
 * The signed-in person's unread in-app notifications (FND-20), for the shell: the count on the
 * Inbox nav item and the bell, and a toast when a high-priority or critical one arrives while
 * online. The inbox itself is CORE-22. Provided by the app shell, so the listener lives as long as it does
 * and follows the active org and account.
 */
@Injectable()
export class NotificationsStore {
  private readonly context = inject(OrgContext);
  private readonly online = inject(Connectivity).online;
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  /** Set once the page has had its own first reads (`NOTIFICATIONS_START_DELAY_MS`). */
  private readonly started = signal(false);

  private readonly repo = notificationsRepo();
  private readonly unread = this.repo.watchQuery(() => {
    const uid = this.context.uid();
    return this.started() && uid && this.context.orgId() ? myUnreadNotificationsQuery(uid) : null;
  });

  /**
   * Unread in-app notifications for the Inbox badge: exact up to `UNREAD_BADGE_LIMIT`, one more
   * than that when there are more (the nav item shows "99+").
   */
  readonly count = computed(() => {
    if (this.unread.status() === 'error') return 0;
    const shown = this.unread.value().length;
    return this.unread.hasMore() ? Math.max(shown, UNREAD_BADGE_LIMIT) + 1 : shown;
  });

  /** The newest unread ones, for the bell's popover (CORE-22). */
  readonly latest = computed(() => (this.unread.status() === 'error' ? [] : this.unread.value()));

  /** Marks the unread ones the badge counts read (the bell's Mark all read). */
  markAllRead(): Promise<void> {
    return markNotificationsRead(
      this.repo,
      this.latest().map((item) => item.id),
      true,
    );
  }

  /** Marks one read (opened from the bell). */
  markRead(item: NotificationItem): Promise<void> {
    return markNotificationsRead(this.repo, [item.id], true);
  }

  /** Ids already seen for the current account and org; `null` until the first answer. */
  private seen: Set<string> | null = null;
  private scope = '';

  constructor() {
    const delay = inject(NOTIFICATIONS_START_DELAY_MS);
    if (delay <= 0) this.started.set(true);
    else {
      const timer = setTimeout(() => this.started.set(true), delay);
      inject(DestroyRef).onDestroy(() => clearTimeout(timer));
    }
    effect(() => {
      const scope = `${this.context.generation()}`;
      const items = this.unread.value();
      const ready = this.unread.status() === 'ready' && !this.unread.fromCache();
      untracked(() => this.arrived(scope, items, ready));
    });
  }

  /**
   * Toasts what is new since the last answer. The first answer for an account and org is the
   * baseline (nothing toasts on sign-in or reload); answers from the cache never toast.
   */
  private arrived(scope: string, items: readonly NotificationItem[], ready: boolean): void {
    if (scope !== this.scope) {
      this.scope = scope;
      this.seen = null;
    }
    if (!ready) return;
    const fresh = this.seen ? items.filter((item) => !this.seen?.has(item.id)) : [];
    this.seen = new Set([...(this.seen ?? []), ...items.map((item) => item.id)]);
    if (!this.online()) return;
    const urgent = fresh.filter(isUrgent);
    for (const item of urgent.slice(0, URGENT_TOASTS_AT_ONCE)) {
      this.toasts.show({
        title: item.title,
        ...(item.body ? { description: item.body } : {}),
        tone: item.priority === 'critical' ? 'danger' : 'neutral',
        action: { label: 'Open', run: () => void this.router.navigateByUrl(item.link) },
        // A critical one stays until dismissed.
        ...(item.priority === 'critical' ? { duration: 0 } : { duration: 8000 }),
      });
    }
    const rest = urgent.length - URGENT_TOASTS_AT_ONCE;
    if (rest > 0) {
      this.toasts.show({
        title: `${rest} more urgent ${rest === 1 ? 'notification' : 'notifications'}`,
        action: { label: 'Open inbox', run: () => void this.router.navigateByUrl('/inbox') },
        duration: 8000,
      });
    }
  }
}
