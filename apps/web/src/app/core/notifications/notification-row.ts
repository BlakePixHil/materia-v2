import { ChangeDetectionStrategy, Component, computed, input, output, ViewEncapsulation } from '@angular/core';

import type { NotificationItem } from '@materia/data-access/repository';
import { MtIcon } from '@materia/ui';

import { notificationGlyph } from './notification-view';

/**
 * One notification (DES-01 NotificationRow, CORE-22): the unread dot, the glyph by kind, the title,
 * the matter and body, then any inline action and the time. Used by the Inbox (selectable, with
 * its keyboard) and the bell's popover. The host is the row; its parent handles focus and keys.
 */
@Component({
  selector: 'mt-notification-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/notif.css'],
  imports: [MtIcon],
  host: {
    class: 'mt-notif',
    role: 'listitem',
    '[attr.data-id]': 'item().id',
    '[attr.data-unread]': 'unread() ? "" : null',
    '[attr.data-selectable]': 'selectable() ? "" : null',
    '[attr.data-selected]': 'selected() ? "" : null',
    '[attr.data-active]': 'active() ? "" : null',
  },
  template: `
    @if (selectable()) {
      <input
        type="checkbox"
        class="select"
        tabindex="-1"
        [checked]="selected()"
        [attr.aria-label]="'Select: ' + item().title"
        (click)="$event.stopPropagation()"
        (change)="toggled.emit()"
      />
    }
    <span class="dot">
      @if (unread()) {
        <span class="mt-sr">Unread</span>
      }
    </span>
    <span class="ic" [attr.data-kind]="glyph().tone" aria-hidden="true"><mt-icon [name]="glyph().icon" /></span>
    <div class="mt-grow body">
      <div class="tt">{{ item().title }}</div>
      <div class="ts">
        @if (gone()) {
          <span class="gone">No longer available</span>
        } @else if (matter()) {
          <span class="ref">{{ matter() }}</span>
        }
        @if (detail(); as text) {
          @if (gone() || matter()) {
            ·
          }
          {{ text }}
        }
      </div>
    </div>
    <div class="side">
      <ng-content />
      <span class="when">{{ time() }}</span>
    </div>
  `,
  styles: `
    .mt-notif {
      cursor: pointer;
      outline: none;
    }
    .mt-notif:focus-visible,
    .mt-notif[data-active]:focus-within {
      box-shadow: inset 2px 0 0 var(--border-focus);
    }
    .mt-notif:focus-visible {
      box-shadow: var(--focus-ring);
    }
    .mt-notif > .select {
      width: 14px;
      height: 14px;
      margin: 7px 0 0;
      accent-color: var(--border-focus);
    }
    .mt-notif .body {
      min-width: 0;
    }
    .mt-notif .tt,
    .mt-notif .ts {
      overflow-wrap: anywhere;
    }
    .mt-notif[data-unread] .tt {
      font-weight: 600;
    }
    .mt-notif .ref {
      font: 500 11px/16px var(--font-mono);
      color: var(--text-secondary);
    }
    .mt-notif .gone {
      color: var(--text-warning);
    }
    @media (max-width: 767px) {
      .mt-notif .side {
        flex-direction: column-reverse;
        align-items: flex-end;
      }
    }
  `,
})
export class MtNotificationRow {
  readonly item = input.required<NotificationItem>();
  /** "WE-142 · Estate of Margaret Whitfield", or nothing for a notification about no matter. */
  readonly matter = input<string | null>(null);
  /** Its matter can no longer be read (access removed, or deleted). */
  readonly gone = input(false);
  /** The second line after the matter: the body, or what happened to it ("Acknowledged by …"). */
  readonly detail = input<string | null>(null);
  readonly time = input.required<string>();
  readonly selectable = input(false);
  readonly selected = input(false);
  readonly active = input(false);
  /** The checkbox was clicked. */
  readonly toggled = output();

  protected readonly unread = computed(() => !this.item().readAt);
  protected readonly glyph = computed(() => notificationGlyph(this.item()));
}
