import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  Injector,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import type { NotificationItem } from '@materia/data-access/repository';
import { INBOX_FILTERS, type InboxFilter } from '@materia/domain';
import { DialogService, MtButton, MtEmptyState, MtIcon, MtKbd, MtMatterTag, MtNote, MtSwitch } from '@materia/ui';

import { INBOX_FILTER_LABELS, InboxData, inboxSuggestion } from './inbox-data';
import { InboxSuggestion, InboxSuggestionDialog, type InboxSuggestionDialogData } from './inbox-suggestion';
import { MtNotificationRow } from '../../core/notifications/notification-row';
import { isEditable, ShortcutService } from '../../core/shortcuts/shortcut.service';
import { MtPageActions } from '../../shell/page-header';
import { DeadlineActions } from '../deadlines/deadline-actions';
import type { SuggestionResolved } from '../suggestions/suggestion-card';

/** At this width and up the selected notification shows beside the list. */
export const INBOX_DETAIL_QUERY = '(min-width: 1100px)';

const FILTER_ICONS: Partial<Record<InboxFilter, 'at-sign' | 'user-plus' | 'clock' | 'sparkle' | 'bell'>> = {
  mentions: 'at-sign',
  assigned: 'user-plus',
  deadlines: 'clock',
  clerk: 'sparkle',
  system: 'bell',
};

/**
 * The Inbox (`/inbox`, CORE-22, DES-01): every notification I get, grouped by day, filtered by
 * kind and read state, with each one's action in its row (Acknowledge, Accept or Reject, Review,
 * Reconnect), selection and bulk mark read or archive, and the selected one beside the list on a
 * wide screen. Notification settings leads to Settings → Preferences, where the notifications are.
 *
 * Keyboard: j/k move, Enter opens, e marks read, u unread, a acknowledges, x selects, y archives,
 * Esc clears the selection, Shift+E marks everything listed read.
 */
@Component({
  selector: 'mt-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [DeadlineActions, InboxData],
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/chip.css',
    '../../../../../../libs/ui/src/generated/components/count.css',
    '../../../../../../libs/ui/src/generated/components/notif.css',
  ],
  imports: [
    FormsModule,
    InboxSuggestion,
    MtButton,
    MtEmptyState,
    MtIcon,
    MtKbd,
    MtMatterTag,
    MtNote,
    MtNotificationRow,
    MtPageActions,
    MtSwitch,
    NgTemplateOutlet,
    RouterLink,
  ],
  // Keys pressed on a notification bubble up to the page (see onKey).
  host: { class: 'mt-inbox', '(keydown)': 'onKey($event)' },
  template: `
    <ng-template mtPageActions>
      <a mtButton variant="ghost" size="sm" iconStart="settings" routerLink="/settings/preferences">
        Notification settings
      </a>
      <button
        mtButton
        variant="ghost"
        size="sm"
        iconStart="check-check"
        kbd="shift+e"
        [disabled]="!data.rows().length"
        (click)="markAllRead()"
      >
        Mark all read
      </button>
    </ng-template>

    <h1 class="mt-sr">Inbox</h1>
    <p class="mt-sr" aria-live="polite">{{ announcement() }}</p>

    <div class="list-pane">
      <div class="toolbar" role="group" aria-label="Filters">
        @for (f of filters; track f) {
          <button
            type="button"
            class="mt-chip"
            [attr.data-selected]="data.filter() === f ? '' : null"
            [attr.aria-pressed]="data.filter() === f"
            [attr.data-filter]="f"
            (click)="data.filter.set(f)"
          >
            @if (icons[f]; as icon) {
              <mt-icon [name]="icon" />
            }
            {{ labels[f] }}
            <span class="n">{{ data.counts()[f] }}</span>
          </button>
        }
        <span class="unread">
          <mt-switch label="Unread only" [ngModel]="data.unreadOnly()" (ngModelChange)="data.unreadOnly.set($event)" />
        </span>
      </div>

      @if (!data.online()) {
        <mt-note tone="warning" icon="wifi-off"
          >You’re offline. Showing the notifications on this device; changes sync when you reconnect.</mt-note
        >
      }

      @switch (data.query.status()) {
        @case ('loading') {
          <div class="state" role="status" aria-busy="true">
            <span class="mt-sr">Loading your notifications</span>
            @for (n of [1, 2, 3, 4, 5]; track n) {
              <div class="skeleton"><span></span><span></span></div>
            }
          </div>
        }
        @case ('error') {
          <mt-empty-state
            icon="alert"
            title="Couldn’t load your inbox"
            description="Your notifications are safe; this is a problem fetching them."
          >
            <button mtButton size="sm" iconStart="refresh" (click)="data.query.refresh()">Try again</button>
          </mt-empty-state>
        }
        @default {
          @if (data.query.newItems(); as fresh) {
            <button
              mtButton
              variant="secondary"
              size="sm"
              class="fresh"
              iconStart="arrow-up-right"
              (click)="data.query.refresh()"
            >
              {{ fresh === 1 ? '1 new notification' : fresh + ' new notifications' }}
            </button>
          }
          @if (data.days().length) {
            <div class="days">
              @for (day of data.days(); track day.day) {
                <section [attr.aria-label]="day.label">
                  <div class="mt-notif-day" aria-hidden="true">
                    <span class="t-1">{{ day.label }}</span
                    ><span class="mt-count">{{ day.rows.length }}</span>
                  </div>
                  <div role="list">
                    @for (row of day.rows; track row.item.id) {
                      <mt-notification-row
                        [class.member]="row.member"
                        [item]="row.item"
                        [matter]="data.matterLabel(row.item)"
                        [gone]="data.gone(row.item)"
                        [detail]="data.detail(row.item)"
                        [time]="data.time(row.item)"
                        [selectable]="true"
                        [selected]="data.selection().has(row.item.id)"
                        [active]="data.activeId() === row.item.id"
                        [attr.tabindex]="tabIndexOf(row.item)"
                        (toggled)="data.toggle(row.item)"
                        (click)="clicked(row.item)"
                        (focus)="data.activeId.set(row.item.id)"
                      >
                        <ng-container
                          [ngTemplateOutlet]="actionTpl"
                          [ngTemplateOutletContext]="{ $implicit: row.item }"
                        />
                      </mt-notification-row>
                    }
                  </div>
                </section>
              }
              @if (data.query.hasMore()) {
                <div class="more">
                  <button
                    mtButton
                    variant="ghost"
                    size="sm"
                    [loading]="data.query.loadingMore()"
                    (click)="data.query.loadMore()"
                  >
                    Show older notifications
                  </button>
                </div>
              }
            </div>
          } @else if (data.filter() !== 'all' || data.unreadOnly()) {
            <mt-empty-state icon="filter" title="Nothing matches" description="No notifications match these filters.">
              <button mtButton size="sm" (click)="clearFilters()">Clear filters</button>
            </mt-empty-state>
          } @else {
            <mt-empty-state
              icon="check-check"
              title="You’re all caught up"
              description="New mentions, assignments, deadlines and finished Clerk work land here."
            />
          }
        }
      }

      @if (data.selected().length; as n) {
        <div class="bulk" role="region" aria-label="Selected notifications">
          <span class="label" role="status">{{ n }} selected</span>
          <button mtButton variant="ghost" size="sm" iconStart="check" kbd="e" (click)="bulkRead(true)">
            Mark read
          </button>
          <button mtButton variant="ghost" size="sm" iconStart="mail" kbd="u" (click)="bulkRead(false)">
            Mark unread
          </button>
          <button mtButton variant="ghost" size="sm" iconStart="archive" kbd="y" (click)="bulkArchive()">
            Archive
          </button>
          <button mtButton variant="ghost" size="sm" iconStart="x" kbd="esc" (click)="data.clearSelection()">
            Clear
          </button>
        </div>
      }
    </div>

    @if (wide()) {
      <aside class="detail" aria-label="Selected notification">
        @if (data.active(); as item) {
          @if (data.matterRef(item); as matter) {
            <div class="matter">
              <span class="mono-s t-3">{{ matter.number }}</span>
              @if (matter.type) {
                <mt-matter-tag [type]="matter.type" />
              }
              <a
                class="mt-ml"
                mtButton
                variant="ghost"
                size="sm"
                iconEnd="arrow-right"
                [routerLink]="['/matters', matter.id]"
                >Open matter</a
              >
            </div>
            <div class="title-m">{{ matter.title }}</div>
          } @else if (data.gone(item)) {
            <mt-note tone="warning" icon="lock"
              >No longer available. You can’t open the matter this is about any more.</mt-note
            >
          }
          <div class="card">
            <div class="label">{{ item.title }}</div>
            @if (data.detail(item); as text) {
              <p class="body">{{ text }}</p>
            }
            <span class="caption t-3">{{ data.time(item) }} · {{ dayOf(item) }}</span>
          </div>
          @if (suggestionOf(item); as ref) {
            @for (key of [ref.suggestionId]; track key) {
              <mt-inbox-suggestion
                class="review"
                [matterId]="ref.matterId"
                [suggestionId]="ref.suggestionId"
                [names]="data.names()"
                (resolved)="data.reviewed(item, $event.outcome)"
              />
            }
          }
          <div class="actions">
            <ng-container [ngTemplateOutlet]="actionTpl" [ngTemplateOutletContext]="{ $implicit: item, wide: true }" />
            @if (!data.gone(item)) {
              <button mtButton size="sm" iconEnd="arrow-right" kbd="enter" (click)="data.open(item)">
                {{ item.collapsedCount ? (data.bursts().has(item.id) ? 'Hide them' : 'List them') : 'Open' }}
              </button>
            }
            @if (item.readAt) {
              <button
                mtButton
                variant="ghost"
                size="sm"
                iconStart="mail"
                kbd="u"
                (click)="data.markRead([item], false)"
              >
                Mark unread
              </button>
            } @else {
              <button
                mtButton
                variant="ghost"
                size="sm"
                iconStart="check"
                kbd="e"
                (click)="data.markRead([item], true)"
              >
                Mark read
              </button>
            }
            <button mtButton variant="ghost" size="sm" iconStart="archive" kbd="y" (click)="data.archive([item])">
              Archive
            </button>
          </div>
          <p class="caption t-3 hint">
            <mt-kbd keys="j" /> and <mt-kbd keys="k" /> move through the list. <mt-kbd keys="enter" /> opens the item;
            <mt-kbd keys="x" /> selects it.
          </p>
        } @else {
          <mt-empty-state
            icon="inbox"
            title="Nothing selected"
            description="Choose a notification, or press J to start at the top."
          />
        }
      </aside>
    }

    <ng-template #actionTpl let-item let-wide="wide">
      @switch (data.action(item)) {
        @case ('acknowledge') {
          @if (!data.outcomes().has(item.id)) {
            <button
              mtButton
              size="sm"
              [kbd]="wide ? 'a' : undefined"
              [loading]="data.isBusy(item)"
              (click)="$event.stopPropagation(); acknowledge(item)"
            >
              Acknowledge
            </button>
          }
        }
        @case ('resolve') {
          @if (!data.outcomes().has(item.id)) {
            <button
              mtButton
              size="sm"
              [disabled]="data.isBusy(item)"
              (click)="$event.stopPropagation(); data.resolve(item, true)"
            >
              Accept
            </button>
            <button
              mtButton
              variant="ghost"
              size="sm"
              [disabled]="data.isBusy(item)"
              (click)="$event.stopPropagation(); data.resolve(item, false)"
            >
              Reject
            </button>
          }
        }
        @case ('review') {
          @if (!data.outcomes().has(item.id) && !(wide && suggestionOf(item))) {
            <button mtButton variant="clerk" size="sm" (click)="$event.stopPropagation(); review(item)">Review</button>
          }
        }
        @case ('reconnect') {
          <button mtButton size="sm" iconStart="refresh" (click)="$event.stopPropagation(); data.follow(item)">
            Reconnect
          </button>
        }
      }
    </ng-template>
  `,
  styles: `
    /* Full-bleed: cancels the shell page's padding. */
    .mt-inbox {
      display: flex;
      flex: 1;
      min-height: 0;
      margin: calc(-1 * var(--space-24)) calc(-1 * var(--space-32)) calc(-1 * var(--space-32));
    }
    /* On a phone the shell page's padding is 16px all round; cancelling 32px made the Inbox wider than the screen. */
    @media (max-width: 767px) {
      .mt-inbox {
        margin: calc(-1 * (var(--space-16) + var(--space-20))) calc(-1 * var(--space-16)) calc(-1 * var(--space-16));
      }
    }
    .mt-inbox .list-pane {
      position: relative;
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .mt-inbox .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-6);
      padding: 10px var(--space-16);
      border-bottom: 1px solid var(--border-default);
    }
    .mt-inbox .mt-chip .n {
      font: 500 11px/14px var(--font-mono);
      color: var(--text-tertiary);
    }
    .mt-inbox .mt-chip[data-selected] .n {
      color: inherit;
    }
    .mt-inbox .mt-chip:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .mt-inbox .unread {
      margin-left: auto;
    }
    .mt-inbox .days {
      flex: 1;
    }
    .mt-inbox mt-notification-row.member {
      padding-left: var(--space-32, 32px);
      background: var(--bg-canvas);
    }
    .mt-inbox .mt-notif[data-active] {
      background: var(--bg-selected);
    }
    .mt-inbox .fresh {
      align-self: center;
      margin: var(--space-8) 0;
    }
    .mt-inbox .more {
      display: flex;
      justify-content: center;
      padding: var(--space-12);
    }
    .mt-inbox .state {
      padding: var(--space-8) var(--space-16);
    }
    .mt-inbox .skeleton {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-inbox .skeleton span {
      display: block;
      height: 10px;
      width: 60%;
      border-radius: var(--radius-sm, 4px);
      background: var(--bg-sunken);
    }
    .mt-inbox .skeleton span + span {
      width: 40%;
    }
    .mt-inbox .bulk {
      position: sticky;
      bottom: var(--space-16);
      z-index: 2;
      align-self: center;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-4);
      max-width: calc(100% - 32px);
      margin-top: var(--space-16);
      padding: var(--space-6) var(--space-6) var(--space-6) 14px;
      border-radius: 10px;
      background: var(--bg-inverse);
      color: var(--text-inverse);
      box-shadow: var(--shadow-dialog);
    }
    .mt-inbox .bulk .label {
      margin-right: var(--space-8);
      font: 500 13px/18px var(--font-sans);
    }
    /* Not while hovered: the ghost hover fill is light, so it keeps its dark hover text there. */
    .mt-inbox .bulk .mt-btn:not([data-hover]) {
      color: var(--text-inverse);
    }
    .mt-inbox .detail {
      width: 380px;
      flex: none;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 20px;
      border-left: 1px solid var(--border-default);
    }
    .mt-inbox .detail .matter {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-inbox .detail .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding: 12px;
      border-radius: 10px;
      background: var(--bg-canvas);
    }
    .mt-inbox .detail .card .body {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .mt-inbox .detail .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
    }
    .mt-inbox .detail .hint {
      margin: 0;
    }
  `,
})
export class InboxPage {
  protected readonly data = inject(InboxData);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  protected readonly filters = INBOX_FILTERS;
  protected readonly labels = INBOX_FILTER_LABELS;
  protected readonly icons = FILTER_ICONS;
  protected readonly announcement = signal('');
  protected readonly wide = signal(false);

  /** The row that takes Tab: the active one, else the first. */
  private readonly tabStop = computed(() => this.data.active()?.id ?? this.data.rows()[0]?.id ?? null);

  constructor() {
    const view = inject(DOCUMENT).defaultView;
    const media = view?.matchMedia?.(INBOX_DETAIL_QUERY);
    if (media) {
      this.wide.set(media.matches);
      const change = (event: MediaQueryListEvent) => this.wide.set(event.matches);
      media.addEventListener('change', change);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', change));
    }

    const shortcuts = inject(ShortcutService);
    const has = () => this.data.rows().length > 0;
    const cleanups = [
      // From outside the list, j and k jump into it.
      shortcuts.register({
        combo: 'j',
        description: 'Next notification',
        group: 'Inbox',
        scope: 'route',
        when: has,
        handler: () => this.focusAt(this.indexOfActive() + 1),
      }),
      shortcuts.register({
        combo: 'k',
        description: 'Previous notification',
        group: 'Inbox',
        scope: 'route',
        when: has,
        handler: () => this.focusAt(Math.max(this.indexOfActive() - 1, 0)),
      }),
      shortcuts.register({
        combo: 'shift+e',
        description: 'Mark everything listed read',
        group: 'Inbox',
        scope: 'route',
        when: has,
        handler: () => void this.markAllRead(),
      }),
      // Listed in the cheat sheet; the focused notification handles them.
      ...[
        ['enter', 'Open the notification'],
        ['e', 'Mark read'],
        ['u', 'Mark unread'],
        ['a', 'Acknowledge an escalation'],
        ['x', 'Select the notification'],
        ['y', 'Archive'],
      ].map(([combo, description]) =>
        shortcuts.register({
          combo: combo as string,
          description: description as string,
          group: 'Inbox',
          scope: 'route',
          when: () => false,
          handler: () => undefined,
        }),
      ),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));
  }

  protected tabIndexOf(item: NotificationItem): number {
    return this.tabStop() === item.id ? 0 : -1;
  }

  protected dayOf(item: NotificationItem): string {
    return this.data.days().find((day) => day.rows.some((row) => row.item.id === item.id))?.label ?? '';
  }

  private indexOfActive(): number {
    const id = this.data.activeId();
    return id ? this.data.rows().findIndex((item) => item.id === id) : -1;
  }

  /** Moves the keyboard to a row (and the detail pane with it). */
  private focusAt(index: number): void {
    const rows = this.data.rows();
    const item = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (!item) return;
    this.data.activeId.set(item.id);
    afterNextRender(
      () => {
        const row = [...this.host.nativeElement.querySelectorAll<HTMLElement>('mt-notification-row')].find(
          (el) => el.dataset['id'] === item.id,
        );
        row?.scrollIntoView?.({ block: 'nearest' });
        row?.focus();
      },
      { injector: this.injector },
    );
  }

  protected readonly suggestionOf = inboxSuggestion;

  /**
   * Review (CORE-22a): the suggestion in the detail pane on a wide screen, in a dialog on a narrow
   * one; a notification without its suggestion opens where it leads.
   */
  protected async review(item: NotificationItem): Promise<void> {
    const ref = inboxSuggestion(item);
    if (!ref) {
      await this.data.follow(item);
      return;
    }
    if (this.wide()) {
      this.focusAt(this.data.rows().findIndex((row) => row.id === item.id));
      void this.data.markRead([item], true);
      return;
    }
    const outcome = await this.dialogs.open<InboxSuggestionDialogData, SuggestionResolved | undefined>(
      InboxSuggestionDialog,
      { data: { ...ref, names: this.data.names() } },
    ).result;
    if (outcome) this.data.reviewed(item, outcome.outcome);
  }

  /** A click: beside the list on a wide screen (and read); straight to it on a narrow one. */
  protected clicked(item: NotificationItem): void {
    if (!this.wide()) {
      void this.data.open(item);
      return;
    }
    this.data.activeId.set(item.id);
    void this.data.markRead([item], true);
  }

  /** The selection, or else the focused notification. */
  private targets(): NotificationItem[] {
    const selected = this.data.selected();
    if (selected.length) return selected;
    const active = this.data.active();
    return active ? [active] : [];
  }

  protected async bulkRead(read: boolean): Promise<void> {
    const items = this.targets();
    if (await this.data.markRead(items, read)) {
      this.say(
        `${items.length === 1 ? '1 notification' : `${items.length} notifications`} marked ${read ? 'read' : 'unread'}.`,
      );
    }
  }

  protected async bulkArchive(): Promise<void> {
    const items = this.targets();
    const next = this.nextAfter(items);
    await this.data.archive(items);
    if (next) this.focusAt(this.data.rows().findIndex((item) => item.id === next.id));
  }

  /** The row to land on once these leave the list. */
  private nextAfter(items: readonly NotificationItem[]): NotificationItem | null {
    const gone = new Set(items.map((item) => item.id));
    const rows = this.data.rows();
    const at = this.indexOfActive();
    return (
      rows.slice(at + 1).find((item) => !gone.has(item.id)) ??
      rows
        .slice(0, at)
        .reverse()
        .find((item) => !gone.has(item.id)) ??
      null
    );
  }

  protected async markAllRead(): Promise<void> {
    const n = await this.data.markAllRead();
    if (n) this.say(`${n === 1 ? '1 notification' : `${n} notifications`} marked read.`);
  }

  protected async acknowledge(item: NotificationItem): Promise<void> {
    await this.data.acknowledge(item);
    const outcome = this.data.outcomes().get(item.id);
    if (outcome) this.say(`${outcome}.`);
  }

  protected clearFilters(): void {
    this.data.filter.set('all');
    this.data.unreadOnly.set(false);
  }

  private say(message: string): void {
    // Cleared first so the same words are announced again.
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(message));
  }

  /** Keys pressed on a notification (they bubble up from the row or its controls). */
  protected onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const rowEl = target?.closest?.<HTMLElement>('mt-notification-row');
    const id = rowEl?.dataset['id'];
    const item = id ? this.data.rows().find((row) => row.id === id) : undefined;
    if (!item) return;
    const onControl = target !== rowEl;
    if (onControl && (isEditable(target) || event.key === 'Enter' || event.key === ' ')) return;
    const at = this.data.rows().indexOf(item);
    let handled = true;
    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        this.focusAt(at + 1);
        break;
      case 'k':
      case 'ArrowUp':
        this.focusAt(at - 1);
        break;
      case 'Home':
        this.focusAt(0);
        break;
      case 'End':
        this.focusAt(this.data.rows().length - 1);
        break;
      case 'Enter':
        void this.data.open(item);
        break;
      case 'e':
        void this.bulkRead(true);
        break;
      case 'u':
        void this.bulkRead(false);
        break;
      case 'a':
        if (this.data.action(item) === 'acknowledge') void this.acknowledge(item);
        break;
      case 'x':
      case ' ':
        this.data.toggle(item);
        break;
      case 'y':
        void this.bulkArchive();
        break;
      case 'Escape':
        if (this.data.selection().size) this.data.clearSelection();
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }
}
