import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import type { MtIconName } from '../../generated/icons';
import { MtIcon } from '../icon/icon';

export type MtNoteTone = 'info' | 'warning' | 'danger';

const NOTE_ICONS: Record<MtNoteTone, MtIconName> = { info: 'info', warning: 'alert', danger: 'alert' };

/**
 * Note (`mt-note`): an inline callout in a panel ("Superannuation sits outside the estate"). Not for
 * transient feedback (use a toast) or errors on a field (use the field's error).
 */
@Component({
  selector: 'mt-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/note.css',
  imports: [MtIcon],
  host: {
    class: 'mt-note',
    '[attr.data-tone]': 'tone() === "info" ? null : tone()',
    '[attr.role]': 'tone() === "danger" ? "alert" : "note"',
  },
  template: `<mt-icon [name]="iconName()" /><span><ng-content /></span>`,
})
export class MtNote {
  readonly tone = input<MtNoteTone>('info');
  readonly icon = input<MtIconName>();
  protected readonly iconName = computed(() => this.icon() ?? NOTE_ICONS[this.tone()]);
}
