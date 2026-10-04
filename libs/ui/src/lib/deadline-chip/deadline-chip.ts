import { ChangeDetectionStrategy, Component, computed, inject, input, ViewEncapsulation } from '@angular/core';
import { NgpTooltipTrigger } from 'ng-primitives/tooltip';

import type { DateOnly } from '@materia/domain';

import { type DeadlineTone, deadlineLabel, deadlineTone } from './tone';
import type { MtIconName } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { MT_ORG_TIMEZONE, MT_TODAY, toDateOnly, type MtDateInput, formatDateOnly } from '../pipes/format';
import { mtTooltipBinding } from '../tooltip/tooltip';

/** What a DeadlineChip shows. */
export interface DeadlineVm {
  due: DateOnly;
  completed?: boolean;
  /** A critical deadline (a limitation period, a court date) gets a flag. */
  critical?: boolean;
  /** How the engine got the date ("UCPR r 78.3 · 14 days after notice"), shown in a tooltip. */
  trace?: string;
}

const TONE_ICONS: Record<DeadlineTone, MtIconName> = {
  overdue: 'alert',
  today: 'clock',
  soon: 'clock',
  upcoming: 'calendar',
  done: 'check',
};

/**
 * DeadlineChip (`mt-deadline-chip`): when something is due. The tone comes from the due date against
 * the injected `MT_TODAY` (org timezone): overdue red, today brand, within 3 days amber, otherwise
 * neutral, done green. The label is relative within a week (`Overdue 2d`, `In 5 days`), otherwise a
 * short date. `trace` shows the engine's working in a tooltip; `critical` adds a flag.
 */
@Component({
  selector: 'mt-deadline-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/deadline.css',
  imports: [MtIcon],
  hostDirectives: [NgpTooltipTrigger],
  host: {
    class: 'mt-deadline',
    '[attr.data-urgency]': 'tone()',
    '[attr.data-critical]': 'critical() ? "" : null',
    '[attr.tabindex]': 'trace() ? 0 : null',
  },
  template: `
    <mt-icon [name]="icon()" />
    <span class="mt-sr">{{ prefix() }}</span
    >{{ text() }}
    @if (critical()) {
      <mt-icon name="flag" /><span class="mt-sr">, critical</span>
    }
  `,
})
export class MtDeadlineChip {
  readonly due = input.required<MtDateInput>();
  readonly completed = input(false);
  readonly critical = input(false);
  readonly trace = input<string>();
  /** Overrides the computed label ("Filed 1 Oct"). */
  readonly label = input<string>();

  private readonly today = inject(MT_TODAY);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);

  private readonly date = computed(() => toDateOnly(this.due(), this.timeZone));
  readonly tone = computed<DeadlineTone>(() => {
    const date = this.date();
    return date ? deadlineTone(date, this.today(), this.completed()) : 'upcoming';
  });
  protected readonly icon = computed(() => TONE_ICONS[this.tone()]);
  protected readonly prefix = computed(() => (this.tone() === 'done' ? 'Deadline: ' : 'Due: '));
  protected readonly text = computed(() => {
    const override = this.label();
    if (override) return override;
    const date = this.date();
    return date ? deadlineLabel(date, this.today(), this.completed()) : formatDateOnly(null);
  });

  constructor() {
    mtTooltipBinding(() => {
      const trace = this.trace();
      return trace ? { text: trace } : null;
    });
  }
}
