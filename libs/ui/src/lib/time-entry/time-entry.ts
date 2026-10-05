import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation,
} from '@angular/core';

import { BILLING_UNIT_MINUTES, formatUnits, type RoundingMode } from '@materia/domain';

import { MtButton } from '../button/button';
import { MtIcon } from '../icon/icon';
import { formatAud, formatMinutes } from '../pipes/format';
import { MtTooltip } from '../tooltip/tooltip';

/** What a TimeEntry shows. */
export interface TimeEntryVm {
  id: string;
  description: string;
  /** Secondary line, such as "WE-142 · Whitfield · 1 Oct" or "3 emails · 10:42–11:05". */
  meta?: string | undefined;
  minutes: number;
  /** Billing units already worked out (a recorded entry's snapshot); otherwise from `minutes`. */
  units?: number | undefined;
  /** Value in cents; null for no charge. Ignored when `fixedFee` or `valueLabel`. */
  amountCents?: number | null | undefined;
  fixedFee?: boolean | undefined;
  /** Shown instead of the value, such as "Non-billable". */
  valueLabel?: string | undefined;
  /** `captured` is a suggestion from email or calendar that a person accepts. */
  source: 'manual' | 'captured';
  /** Billing unit in minutes (default 6) and rounding, from the org settings. */
  unit?: number | undefined;
  rounding?: RoundingMode | undefined;
}

/**
 * TimeEntry (`mt-time-entry`): a recorded or captured time entry with units and value. Captured
 * entries (dashed, Clerk tone) show Accept, which emits `accept`; recorded entries take their actions
 * as projected content (a "More" menu button).
 */
@Component({
  selector: 'mt-time-entry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/time.css', '../../generated/components/layout.css'],
  imports: [MtIcon, MtButton, MtTooltip],
  host: { class: 'mt-time', '[attr.data-source]': 'entry().source', '[attr.data-id]': 'entry().id' },
  template: `
    <span class="src" aria-hidden="true"><mt-icon [name]="entry().source === 'captured' ? 'sparkle' : 'timer'" /></span>
    <div class="mt-grow">
      <div class="tt mt-ell" [mtTooltip]="entry().description">
        @if (entry().source === 'captured') {
          <span class="mt-sr">Captured by Clerk: </span>
        }
        {{ entry().description }}
      </div>
      @if (entry().meta; as meta) {
        <div class="ts mt-ell">{{ meta }}</div>
      }
    </div>
    <div class="amt">
      <span>{{ units() }} h</span>
      <span>{{ value() }}</span>
    </div>
    @if (entry().source === 'captured') {
      <button mtButton variant="clerk" size="sm" [disabled]="disabled()" (click)="accept.emit()">
        Accept<span class="mt-sr">: {{ entry().description }}</span>
      </button>
    } @else {
      <ng-content />
    }
  `,
})
export class MtTimeEntry {
  readonly entry = input.required<TimeEntryVm>();
  readonly disabled = input(false, { transform: booleanAttribute });
  /** A captured entry was accepted. */
  readonly accept = output();

  protected readonly units = computed(() => {
    const entry = this.entry();
    if (entry.units !== undefined) return formatUnits(entry.units, entry.unit ?? BILLING_UNIT_MINUTES);
    return formatMinutes(entry.minutes, 'decimal', {
      ...(entry.unit === undefined ? {} : { unit: entry.unit }),
      ...(entry.rounding === undefined ? {} : { rounding: entry.rounding }),
    });
  });
  protected readonly value = computed(() => {
    const entry = this.entry();
    if (entry.valueLabel) return entry.valueLabel;
    return entry.fixedFee ? 'Fixed fee' : formatAud(entry.amountCents);
  });
}
