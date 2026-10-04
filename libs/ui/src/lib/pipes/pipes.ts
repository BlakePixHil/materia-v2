import { inject, Pipe, type PipeTransform } from '@angular/core';

import type { Cents, RoundingMode } from '@materia/domain';

import {
  formatAud,
  formatDateOnly,
  formatMinutes,
  formatRelativeDate,
  MT_ORG_TIMEZONE,
  MT_TODAY,
  type MtDateInput,
  type MtUnitsFormat,
} from './format';

/** `{{ entry.amount | aud }}`: cents → `$1,234.50`, credit → `-$12.00`, null → `—`. */
@Pipe({ name: 'aud' })
export class MtAudPipe implements PipeTransform {
  transform(value: Cents | number | null | undefined): string {
    return formatAud(value);
  }
}

/** `{{ entry.minutes | units }}` → `0.4`; `{{ entry.minutes | units: 'hm' }}` → `0h 24m`. */
@Pipe({ name: 'units' })
export class MtUnitsPipe implements PipeTransform {
  transform(
    value: number | null | undefined,
    format: MtUnitsFormat = 'decimal',
    rounding: RoundingMode = 'up',
  ): string {
    return formatMinutes(value, format, { rounding });
  }
}

/** `{{ deadline.dueDate | dateOnly }}` → `3 Oct 2026`, in the org timezone for instants. */
@Pipe({ name: 'dateOnly' })
export class MtDateOnlyPipe implements PipeTransform {
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  transform(value: MtDateInput): string {
    return formatDateOnly(value, this.timeZone);
  }
}

/**
 * `{{ task.dueDate | relativeDate }}` → `Today`, `in 3 days`, `3 Oct`. Impure so it updates when the
 * day changes; it's cheap (no allocation beyond the string).
 */
@Pipe({ name: 'relativeDate', pure: false })
export class MtRelativeDatePipe implements PipeTransform {
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly today = inject(MT_TODAY);
  transform(value: MtDateInput): string {
    return formatRelativeDate(value, this.today(), this.timeZone);
  }
}

export const MT_PIPES = [MtAudPipe, MtUnitsPipe, MtDateOnlyPipe, MtRelativeDatePipe] as const;
