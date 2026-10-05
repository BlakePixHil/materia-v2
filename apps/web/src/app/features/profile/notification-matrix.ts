import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import {
  notificationMatrix,
  setKindChannel,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPrefs,
} from '@materia/domain';
import { MtIcon } from '@materia/ui';

const CHANNEL_LABELS: Record<NotificationChannel, string> = { inapp: 'In-app', email: 'Email', push: 'Push' };

/**
 * Notification kinds × channels (CORE-20): a checkbox per cell. Locked cells (deadline escalations
 * by email and in-app) are checked and can't be changed; the server sends them whatever is stored.
 * A channel switched off for everything shows its cells unchecked and disabled. Emits the whole
 * new preferences on each change.
 */
@Component({
  selector: 'mt-notification-matrix',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtIcon],
  template: `
    <div class="matrix-scroll">
      <table class="matrix">
        <caption class="mt-sr">
          Which notifications you get, and how
        </caption>
        <thead>
          <tr>
            <th scope="col">Notification</th>
            @for (channel of channels; track channel) {
              <th scope="col" class="cell">{{ channelLabels[channel] }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.kind) {
            <tr [attr.data-kind]="row.kind">
              <th scope="row">
                <span class="mt-row" style="gap: 6px; align-items: center">
                  {{ row.label }}
                  @if (hasLocked(row.kind)) {
                    <mt-icon name="lock" [size]="14" aria-hidden="true" />
                    <span class="mt-sr">(always sent in-app and by email)</span>
                  }
                </span>
              </th>
              @for (cell of row.cells; track cell.channel) {
                <td class="cell">
                  <input
                    type="checkbox"
                    [checked]="cell.on && !cell.masterOff"
                    [disabled]="cell.locked || cell.masterOff || disabled()"
                    [attr.aria-label]="
                      row.label + ' ' + channelLabels[cell.channel] + (cell.locked ? ' (always on)' : '')
                    "
                    (change)="toggle(row.kind, cell.channel, $any($event.target).checked)"
                  />
                </td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .matrix-scroll {
      overflow-x: auto;
    }
    .matrix {
      width: 100%;
      border-collapse: collapse;
      font: 400 13px/18px var(--font-sans);
    }
    .matrix th,
    .matrix td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border-subtle, var(--border));
      text-align: left;
      font-weight: 400;
    }
    .matrix thead th {
      font-weight: 600;
      color: var(--text-secondary);
    }
    .matrix .cell {
      width: 72px;
      text-align: center;
    }
    .matrix input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent, currentColor);
    }
  `,
})
export class NotificationMatrix {
  readonly prefs = input.required<NotificationPrefs>();
  readonly disabled = input(false);
  readonly changed = output<NotificationPrefs>();

  protected readonly channels = ['inapp', 'email', 'push'] as const;
  protected readonly channelLabels = CHANNEL_LABELS;
  protected readonly rows = computed(() => notificationMatrix(this.prefs()));

  protected hasLocked(kind: NotificationKind): boolean {
    return !!this.rows()
      .find((r) => r.kind === kind)
      ?.cells.some((c) => c.locked);
  }

  protected toggle(kind: NotificationKind, channel: NotificationChannel, on: boolean): void {
    const next = setKindChannel(this.prefs(), kind, channel, on);
    if (next !== this.prefs()) this.changed.emit(next);
  }
}
