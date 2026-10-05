import { ChangeDetectionStrategy, Component, computed, inject, output, ViewEncapsulation } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import type { NotificationItem } from '@materia/data-access/repository';
import { MT_ORG_TIMEZONE, MT_TODAY, MtButton, MtEmptyState, ToastService } from '@materia/ui';

import { MtNotificationRow } from './notification-row';
import { notificationTime } from './notification-view';
import { NotificationsStore } from './notifications-store';
import { errorCopy } from '../error-copy';

/** The popover lists at most this many; the Inbox has the rest. */
export const BELL_LIMIT = 5;

/**
 * The bell's popover (CORE-22, DES-01 "Notifications"): my newest unread notifications, Mark all
 * read, and the way into the Inbox. Choosing one opens what it is about and marks it read.
 */
@Component({
  selector: 'mt-notifications-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/menu.css'],
  imports: [MtButton, MtEmptyState, MtNotificationRow, RouterLink],
  host: { class: 'mt-menu mt-bell', role: 'dialog', 'aria-label': 'Notifications' },
  template: `
    <div class="head">
      <span class="label mt-grow">Notifications</span>
      <button
        mtButton
        variant="ghost"
        size="sm"
        iconStart="check-check"
        [disabled]="!items().length"
        (click)="markAll()"
      >
        Mark all read
      </button>
    </div>
    @if (shown().length) {
      <div role="list">
        @for (item of shown(); track item.id) {
          <mt-notification-row
            tabindex="0"
            [item]="item"
            [detail]="item.body || null"
            [time]="time(item)"
            (click)="open(item)"
            (keydown.enter)="open(item)"
          />
        }
      </div>
    } @else {
      <mt-empty-state icon="check-check" title="You’re all caught up" description="Nothing unread." />
    }
    <div class="foot">
      <span class="caption t-3 mt-grow">{{ summary() }}</span>
      <a mtButton variant="ghost" size="sm" iconEnd="arrow-right" routerLink="/inbox" (click)="closed.emit()"
        >Open Inbox</a
      >
    </div>
  `,
  styles: `
    .mt-bell {
      width: min(400px, calc(100vw - 32px));
      padding: 0;
      overflow: hidden;
    }
    .mt-bell .head,
    .mt-bell .foot {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-bell .head {
      height: 44px;
      padding: 0 8px 0 16px;
      border-bottom: 1px solid var(--border-default);
    }
    .mt-bell .foot {
      padding: 8px 12px;
      border-top: 1px solid var(--border-default);
    }
    .mt-bell mt-notification-row:last-child {
      border-bottom: none;
    }
  `,
})
export class MtNotificationsPopover {
  private readonly store = inject(NotificationsStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly today = inject(MT_TODAY);
  /** Something was chosen: the trigger closes the popover. */
  readonly closed = output();

  protected readonly items = this.store.latest;
  protected readonly shown = computed(() => this.items().slice(0, BELL_LIMIT));
  protected readonly summary = computed(() => {
    const total = this.store.count();
    const shown = this.shown().length;
    if (!total) return 'No unread notifications';
    const of = total > this.items().length ? `${this.items().length}+` : `${total}`;
    return shown < total ? `Showing the latest ${shown} of ${of} unread` : `${total} unread`;
  });

  protected time(item: NotificationItem): string {
    return notificationTime(item.createdAt, this.timeZone, this.today());
  }

  protected open(item: NotificationItem): void {
    this.closed.emit();
    this.store.markRead(item).catch(() => undefined);
    void this.router.navigateByUrl(item.link);
  }

  protected async markAll(): Promise<void> {
    try {
      await this.store.markAllRead();
    } catch (error) {
      this.toasts.show({ title: 'Not marked read', description: errorCopy(error), tone: 'danger' });
    }
  }
}
