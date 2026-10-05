import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  checkDuration,
  DURATION_PROBLEM_COPY,
  formatUnits,
  type DateOnly,
  type TimeEntryValues,
} from '@materia/domain';
import { formatAud, MT_TODAY, MtButton, MtCheckbox, MtNote, MtTextField } from '@materia/ui';

import { NarrativeField } from './narrative-field';
import { dayHeading, dayLimitWarning, formatEntryDate, overDayLimit, parseEntryDate } from './time-view';

/** What the form saves. */
export interface TimeEntryFormValue {
  date: DateOnly;
  minutes: number;
  narrative: string;
  billable: boolean;
}

/** What the form starts with (an entry being edited, or the defaults for a new one). */
export interface TimeEntryFormInitial {
  date?: string | undefined;
  minutes?: number | undefined;
  narrative?: string | undefined;
  billable: boolean;
}

/** Minutes shown in the duration field for an existing entry: whole minutes read best (`18m`). */
function durationText(minutes: number | undefined): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * The time entry form (BILL-01): date (today by default; `y` for yesterday, DD/MM), duration
 * (`0.3`, `18m`, `1h 12m` or `1:12`), narrative (with `/` phrases) and billable, with a preview of
 * the units and value. Enter saves from any field and Esc cancels, so an entry needs no mouse.
 * Over 24 hours on the day asks once more before saving. `row` lays it out on one line (the Time
 * tab's add row), `stack` as a column (the quick entry dialog).
 */
@Component({
  selector: 'mt-time-entry-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, MtButton, MtCheckbox, MtNote, MtTextField, NarrativeField],
  host: { class: 'mt-time-entry-form', '[attr.data-layout]': 'layout()', '(keydown.escape)': 'onEscape($event)' },
  template: `
    <form class="fields" [attr.aria-label]="formLabel()" (submit)="$event.preventDefault(); save()">
      <mt-text-field
        #dateField
        class="date"
        name="date"
        label="Date"
        size="sm"
        placeholder="DD/MM/YYYY"
        [error]="dateError() ?? undefined"
        [ngModel]="dateText()"
        (ngModelChange)="dateText.set($event ?? ''); dateError.set(null); confirming.set(false)"
      />
      <mt-text-field
        #durationField
        class="duration"
        name="duration"
        label="Time"
        size="sm"
        placeholder="0.3, 18m, 1:12"
        [error]="durationError() ?? undefined"
        [suffix]="previewUnits()"
        [ngModel]="durationText()"
        (ngModelChange)="durationText.set($event ?? ''); durationError.set(null); confirming.set(false)"
      />
      <mt-narrative-field class="narrative" size="sm" [(value)]="narrative" (submitted)="save()" />
      <mt-checkbox
        class="billable"
        name="billable"
        label="Billable"
        [ngModel]="billable()"
        (ngModelChange)="billable.set(!!$event)"
      />
      <span class="value caption t-3" aria-live="polite">{{ previewValue() }}</span>
      <span class="actions">
        <button mtButton variant="ghost" size="sm" type="button" (click)="cancelled.emit()">Cancel</button>
        <button mtButton variant="primary" size="sm" type="submit" [loading]="saving()">
          {{ confirming() ? 'Save anyway' : submitLabel() }}
        </button>
      </span>
    </form>
    @if (confirming()) {
      <mt-note tone="warning" role="alert">{{ warning() }}</mt-note>
    }
    @if (fixedFee() && billable()) {
      <p class="caption t-3 hint">This matter is on a fixed fee: time is usually recorded against it, not billed.</p>
    }
  `,
  styles: `
    .mt-time-entry-form {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-time-entry-form .fields {
      display: grid;
      gap: var(--space-8) var(--space-12);
      align-items: end;
    }
    .mt-time-entry-form[data-layout='row'] .fields {
      grid-template-columns: 120px 110px minmax(0, 1fr) auto auto auto;
    }
    .mt-time-entry-form[data-layout='stack'] .fields {
      grid-template-columns: 1fr 1fr;
    }
    .mt-time-entry-form[data-layout='stack'] .narrative,
    .mt-time-entry-form[data-layout='stack'] .actions {
      grid-column: 1 / -1;
    }
    .mt-time-entry-form .billable,
    .mt-time-entry-form .value {
      align-self: center;
      padding-top: var(--space-16);
    }
    .mt-time-entry-form[data-layout='stack'] .billable,
    .mt-time-entry-form[data-layout='stack'] .value {
      padding-top: 0;
    }
    .mt-time-entry-form .actions {
      display: flex;
      gap: var(--space-8);
      justify-content: flex-end;
    }
    .mt-time-entry-form .hint {
      margin: 0;
    }
    /* Small screens (a 13" laptop with the sidebar open, tablets): two rows. */
    @media (max-width: 1100px) {
      .mt-time-entry-form[data-layout='row'] .fields {
        grid-template-columns: 120px 110px minmax(0, 1fr);
      }
      .mt-time-entry-form[data-layout='row'] .billable,
      .mt-time-entry-form[data-layout='row'] .value {
        padding-top: 0;
      }
      .mt-time-entry-form[data-layout='row'] .actions {
        grid-column: 3;
      }
    }
    @media (max-width: 640px) {
      .mt-time-entry-form .fields,
      .mt-time-entry-form[data-layout='row'] .fields {
        grid-template-columns: 1fr 1fr;
      }
      .mt-time-entry-form .narrative,
      .mt-time-entry-form .actions,
      .mt-time-entry-form[data-layout='row'] .actions {
        grid-column: 1 / -1;
      }
    }
  `,
})
export class TimeEntryForm {
  readonly initial = input<TimeEntryFormInitial>({ billable: true });
  /** The units, rate and amount the entry would get (the server's values replace it). */
  readonly preview = input<(minutes: number, date: DateOnly) => TimeEntryValues | null>(() => null);
  /** Minutes already on a day (leaving out the entry being edited), for the 24-hour check. */
  readonly dayMinutes = input<(date: DateOnly) => number | Promise<number>>(() => 0);
  readonly unitMinutes = input(6);
  readonly fixedFee = input(false, { transform: booleanAttribute });
  readonly saving = input(false, { transform: booleanAttribute });
  readonly layout = input<'row' | 'stack'>('row');
  readonly submitLabel = input('Add time');
  readonly formLabel = input('Record time');
  readonly saved = output<TimeEntryFormValue>();
  readonly cancelled = output();

  private readonly today = inject(MT_TODAY);
  private readonly durationField = viewChild('durationField', { read: ElementRef<HTMLElement> });

  protected readonly dateText = signal('');
  protected readonly durationText = signal('');
  protected readonly narrative = signal('');
  protected readonly billable = signal(true);
  protected readonly dateError = signal<string | null>(null);
  protected readonly durationError = signal<string | null>(null);
  protected readonly confirming = signal(false);
  protected readonly warning = signal('');

  private readonly parsed = computed(() => {
    const date = parseEntryDate(this.dateText(), this.today());
    const duration = checkDuration(this.durationText());
    return { date, minutes: duration.minutes };
  });
  private readonly values = computed(() => {
    const { date, minutes } = this.parsed();
    return date && minutes ? this.preview()(minutes, date) : null;
  });
  protected readonly previewUnits = computed(() => {
    const values = this.values();
    return values ? `${formatUnits(values.units, this.unitMinutes())} h` : '';
  });
  protected readonly previewValue = computed(() => {
    const values = this.values();
    if (!values) return '';
    if (!this.billable()) return this.fixedFee() ? 'Fixed fee' : 'Non-billable';
    return formatAud(values.amountCents);
  });

  constructor() {
    queueMicrotask(() => this.reset());
  }

  /** Puts the initial values back (after a save, the add row starts again from today). */
  reset(keepDate = false): void {
    const initial = this.initial();
    if (!keepDate) this.dateText.set(formatEntryDate(initial.date ?? this.today()));
    this.durationText.set(durationText(initial.minutes));
    this.narrative.set(initial.narrative ?? '');
    this.billable.set(initial.billable);
    this.dateError.set(null);
    this.durationError.set(null);
    this.confirming.set(false);
  }

  /** Focuses the duration (the field typed first; the date is usually today). */
  focus(): void {
    this.durationField()?.nativeElement.querySelector('input')?.focus();
  }

  private checking = false;

  protected async save(): Promise<void> {
    if (this.saving() || this.checking) return;
    const date = parseEntryDate(this.dateText(), this.today());
    const duration = checkDuration(this.durationText());
    this.dateError.set(date ? null : 'Enter a date such as 01/10/2026, or y for yesterday');
    this.durationError.set(duration.problem ? DURATION_PROBLEM_COPY[duration.problem] : null);
    if (!date || duration.minutes === null) {
      if (duration.minutes === null) this.focus();
      return;
    }
    if (!this.confirming()) {
      this.checking = true;
      const existing = await Promise.resolve(this.dayMinutes()(date)).finally(() => (this.checking = false));
      if (overDayLimit(existing, duration.minutes)) {
        this.warning.set(dayLimitWarning(existing, duration.minutes, dayHeading(date, this.today())));
        this.confirming.set(true);
        return;
      }
    }
    this.confirming.set(false);
    this.saved.emit({ date, minutes: duration.minutes, narrative: this.narrative().trim(), billable: this.billable() });
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }
}
