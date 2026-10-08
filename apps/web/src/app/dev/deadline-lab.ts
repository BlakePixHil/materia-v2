import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

import {
  compute,
  type ComputedDeadline,
  DeadlineEngineError,
  type EngineEvent,
  explain,
  VIC_CALENDARS,
  VIC_RULESET_V1,
} from '@materia/deadlines';
import { type DateOnly, type EventKind, isDateOnly, type MatterType, today } from '@materia/domain';
import {
  MT_TODAY,
  MtBadge,
  MtCheckbox,
  MtDeadlineChip,
  MtNote,
  MtSelect,
  MtTextField,
  type MtOption,
} from '@materia/ui';

const MATTER_TYPES: MtOption<MatterType>[] = [
  { value: 'probate', label: 'Probate' },
  { value: 'loa', label: 'Letters of administration' },
  { value: 'admin', label: 'Estate administration' },
  { value: 'fp', label: 'Family provision' },
  { value: 'contest', label: 'Will dispute' },
  { value: 'will', label: 'Will' },
];

const LOCALITIES: MtOption[] = [
  { value: 'VIC_MELBOURNE', label: 'Melbourne' },
  { value: 'VIC_GREATER_GEELONG', label: 'Greater Geelong' },
];

const PRECISIONS: MtOption[] = [
  { value: 'day', label: 'Exact day' },
  { value: 'month', label: 'Month only' },
  { value: 'year', label: 'Year only' },
];

/** The anchor events the lab can enter, in the order a matter usually meets them. */
const EVENTS: { kind: EventKind; label: string }[] = [
  { kind: 'date_of_death', label: 'Date of death' },
  { kind: 'notice_published', label: 'Probate notice published' },
  { kind: 'grant_issued', label: 'Grant issued' },
  { kind: 'statutory_notice_published', label: 'Statutory (s 33) notice published' },
  { kind: 'caveat_lodged', label: 'Caveat lodged' },
  { kind: 'offer_made', label: 'Offer of compromise made' },
  { kind: 'order_made', label: 'Order made' },
];

/**
 * Deadline lab (`/__dev/deadlines`, dev builds only): enter a matter's events and see what the
 * Victorian rule set v1 computes, with every trace. For practitioners reviewing the rules (CORE-09).
 */
@Component({
  selector: 'mt-deadline-lab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MtTextField, MtSelect, MtCheckbox, MtDeadlineChip, MtBadge, MtNote],
  providers: [
    { provide: MT_TODAY, useFactory: (lab: DeadlineLabPage) => () => lab.todayDate(), deps: [DeadlineLabPage] },
  ],
  styles: `
    :host {
      display: block;
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px 16px 64px;
    }
    h1 {
      margin: 0 0 4px;
      font: 600 22px/28px var(--font-sans);
    }
    h2 {
      margin: 24px 0 8px;
      font: 600 15px/20px var(--font-sans);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px 16px;
    }
    .results {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .result {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      padding: 12px;
      background: var(--bg-surface);
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .title {
      font: 500 14px/20px var(--font-sans);
      flex: 1 1 240px;
    }
    .cite {
      font: 400 12px/16px var(--font-sans);
      color: var(--text-tertiary);
      margin: 4px 0 0;
    }
    ol {
      margin: 8px 0 0;
      padding-left: 20px;
      font: 400 12px/18px var(--font-mono);
      color: var(--text-secondary);
    }
  `,
  template: `
    <h1>Deadline lab</h1>
    <mt-note tone="warning"
      >{{ ruleSet.disclaimer }} Rule set {{ ruleSet.ruleSetId }} v{{ ruleSet.version }}; the calendars are checked
      (CORE-09a), but a date marked provisional can still move.</mt-note
    >

    <form [formGroup]="form">
      <h2>Matter</h2>
      <div class="grid">
        <mt-select label="Matter type" [options]="matterTypes" formControlName="matterType" />
        <mt-select label="Firm locality (reminders)" [options]="localities" formControlName="locality" />
        <mt-text-field label="Today" placeholder="YYYY-MM-DD" formControlName="today" />
        <mt-text-field label="Months before the filing reminder" type="number" formControlName="promptFilingMonths" />
        <mt-checkbox label="Estate has a main residence" formControlName="hasMainResidence" />
        <mt-checkbox label="Application for a grant filed" formControlName="grantFiled" />
      </div>
      <h2>Events</h2>
      <div class="grid">
        @for (event of events; track event.kind) {
          <mt-text-field [label]="event.label" placeholder="YYYY-MM-DD" [formControlName]="event.kind" />
        }
        <mt-select label="Date of death precision" [options]="precisions" formControlName="precision" />
        <mt-text-field label="Offer period (days)" type="number" formControlName="offerDays" />
        <mt-text-field label="Order: comply within (days)" type="number" formControlName="orderDays" />
      </div>
    </form>

    <h2>Computed deadlines</h2>
    @if (outcome().error; as error) {
      <mt-note tone="danger">{{ error }}</mt-note>
    } @else {
      <ul class="results" aria-label="Computed deadlines">
        @for (deadline of outcome().deadlines; track deadline.ruleId) {
          <li class="result">
            <div class="head">
              <span class="title">{{ deadline.title }}</span>
              @if (deadline.critical) {
                <mt-badge tone="danger">Critical</mt-badge>
              }
              @if (deadline.verify) {
                <mt-badge tone="warning">Verify</mt-badge>
              }
              @if (deadline.approximate) {
                <mt-badge tone="info">Approximate</mt-badge>
              }
              @if (deadline.pastOnCreation) {
                <mt-badge tone="warning">Past: review</mt-badge>
              }
              @if (deadline.dueDate; as due) {
                <mt-deadline-chip [due]="due" [critical]="deadline.critical" />
                <span>{{ due }}{{ deadline.dueTime ? ' ' + deadline.dueTime : '' }}</span>
              } @else {
                <mt-badge [tone]="deadline.status === 'invalid' ? 'danger' : 'neutral'"
                  >{{ deadline.status }}: {{ deadline.reason }}</mt-badge
                >
              }
            </div>
            <p class="cite">{{ deadline.ruleId }} · {{ deadline.citation }}</p>
            <ol aria-label="Trace">
              @for (line of trace(deadline); track $index) {
                <li>{{ line }}</li>
              }
            </ol>
          </li>
        } @empty {
          <li>No rules apply to this matter type.</li>
        }
      </ul>
    }
  `,
})
export class DeadlineLabPage {
  protected readonly ruleSet = VIC_RULESET_V1;
  protected readonly matterTypes = MATTER_TYPES;
  protected readonly localities = LOCALITIES;
  protected readonly precisions = PRECISIONS;
  protected readonly events = EVENTS;

  protected readonly form = new FormGroup({
    matterType: new FormControl<MatterType>('probate', { nonNullable: true }),
    locality: new FormControl('VIC_MELBOURNE', { nonNullable: true }),
    today: new FormControl<string>(today('Australia/Melbourne'), { nonNullable: true }),
    promptFilingMonths: new FormControl<string>('6', { nonNullable: true }),
    hasMainResidence: new FormControl(false, { nonNullable: true }),
    grantFiled: new FormControl(false, { nonNullable: true }),
    precision: new FormControl('day', { nonNullable: true }),
    offerDays: new FormControl<string>('', { nonNullable: true }),
    orderDays: new FormControl<string>('', { nonNullable: true }),
    ...Object.fromEntries(EVENTS.map((e) => [e.kind, new FormControl<string>('', { nonNullable: true })])),
  } as Record<string, FormControl>);

  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  private readonly fallbackToday = signal(today('Australia/Melbourne'));

  readonly todayDate = computed<DateOnly>(() => {
    const value = (this.value() as Record<string, unknown>)['today'];
    return typeof value === 'string' && isDateOnly(value) ? value : this.fallbackToday();
  });

  protected readonly outcome = computed<{ deadlines: ComputedDeadline[]; error?: string }>(() => {
    const v = this.value() as Record<string, string | boolean>;
    const num = (key: string) => {
      const n = Number(v[key]);
      return v[key] !== '' && Number.isInteger(n) && n >= 0 ? n : undefined;
    };
    const events: EngineEvent[] = EVENTS.flatMap(({ kind }) => {
      const date = v[kind];
      if (typeof date !== 'string' || !isDateOnly(date)) return [];
      const meta: Record<string, string | number> = {};
      if (kind === 'date_of_death' && v['precision'] !== 'day') meta['datePrecision'] = String(v['precision']);
      if (kind === 'offer_made' && num('offerDays') !== undefined) meta['periodDays'] = num('offerDays') as number;
      if (kind === 'order_made' && num('orderDays') !== undefined) meta['days'] = num('orderDays') as number;
      return [{ id: kind, kind, date, meta }];
    });
    try {
      const deadlines = compute({
        matter: {
          type: v['matterType'] as MatterType,
          jurisdiction: 'VIC',
          facts: {
            estate: { hasMainResidence: v['hasMainResidence'] === true },
            ...(v['grantFiled'] === true ? { grant: { filed: true } } : {}),
            ...(num('promptFilingMonths') !== undefined
              ? { org: { promptFilingMonths: num('promptFilingMonths') } }
              : {}),
          },
        },
        events,
        ruleSet: VIC_RULESET_V1,
        calendars: VIC_CALENDARS,
        localityCalendar: String(v['locality']),
        today: this.todayDate(),
      });
      return { deadlines };
    } catch (error) {
      return { deadlines: [], error: error instanceof DeadlineEngineError ? error.message : String(error) };
    }
  });

  protected trace(deadline: ComputedDeadline): string[] {
    return explain(deadline);
  }
}
