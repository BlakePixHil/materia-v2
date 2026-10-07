import { ChangeDetectionStrategy, Component, computed, input, output, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { deadlineTraceText, monthCalendar, type DateOnly, type DeadlineLike } from '@materia/domain';
import { MtButton, MtIconButton } from '@materia/ui';

import { dayLabel, monthLabel, shiftMonth, WEEKDAYS, type DeadlineRowVm } from './deadline-view';

type CalendarRow = DeadlineLike & { row: DeadlineRowVm };

/**
 * The month calendar view of the Deadlines screen (CORE-10): Monday-first weeks as a table, each
 * day listing its deadlines as links to their matter (the trace in the link's title). Previous and
 * next month, and back to this month; today is marked `aria-current="date"`.
 */
@Component({
  selector: 'mt-deadline-calendar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtIconButton, RouterLink],
  host: { class: 'mt-deadline-calendar' },
  template: `
    <div class="nav">
      <button mtIconButton icon="chevron-left" size="sm" label="Previous month" (click)="go(-1)"></button>
      <h3 class="heading month" aria-live="polite">{{ label() }}</h3>
      <button mtIconButton icon="chevron-right" size="sm" label="Next month" (click)="go(1)"></button>
      @if (month() !== thisMonth()) {
        <button mtButton size="sm" variant="ghost" (click)="monthChange.emit(thisMonth())">This month</button>
      }
    </div>
    <div class="scroll">
      <table>
        <caption class="mt-sr">
          Deadlines in
          {{
            label()
          }}
        </caption>
        <thead>
          <tr>
            @for (day of weekdays; track day.short) {
              <th scope="col">
                <abbr [title]="day.long">{{ day.short }}</abbr>
              </th>
            }
          </tr>
        </thead>
        <tbody>
          @for (week of weeks(); track week[0]?.date) {
            <tr>
              @for (day of week; track day.date) {
                <td
                  [attr.data-date]="day.date"
                  [attr.data-out]="day.inMonth ? null : ''"
                  [attr.aria-current]="day.isToday ? 'date' : null"
                >
                  <span class="num" aria-hidden="true">{{ dayNumber(day.date) }}</span>
                  <span class="mt-sr">{{ dayName(day.date) }}{{ day.isToday ? ', today' : '' }}</span>
                  @if (day.deadlines.length) {
                    <ul>
                      @for (item of day.deadlines; track item.id) {
                        <li [attr.data-critical]="item.critical ? '' : null">
                          <a [routerLink]="['/matters', item.row.matterId, 'deadlines']" [title]="trace(item)">
                            {{ item.title }}
                            @if (item.critical) {
                              <span class="mt-sr">, critical</span>
                            }
                            @if (item.row.matter; as matter) {
                              <span class="mt-sr">, {{ matter.number }}</span>
                            }
                          </a>
                        </li>
                      }
                    </ul>
                  }
                </td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .mt-deadline-calendar {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-width: 0;
    }
    .mt-deadline-calendar .nav {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-deadline-calendar .month {
      margin: 0;
      min-width: 9em;
      text-align: center;
    }
    .mt-deadline-calendar .scroll {
      overflow-x: auto;
      max-width: 100%;
    }
    .mt-deadline-calendar table {
      width: 100%;
      min-width: 320px;
      table-layout: fixed;
      border-collapse: collapse;
      background: var(--bg-surface);
      font: 400 12px/16px var(--font-sans);
    }
    .mt-deadline-calendar th {
      padding: var(--space-4);
      color: var(--text-secondary);
      font-weight: 500;
      text-align: left;
    }
    .mt-deadline-calendar abbr {
      text-decoration: none;
    }
    .mt-deadline-calendar td {
      vertical-align: top;
      height: 84px;
      padding: var(--space-4);
      border: 1px solid var(--border-subtle);
    }
    .mt-deadline-calendar td[data-out] {
      background: var(--bg-sunken);
      color: var(--text-tertiary);
    }
    .mt-deadline-calendar td[aria-current='date'] .num {
      background: var(--bg-brand);
      color: var(--text-on-brand);
      border-radius: var(--radius-full);
      padding: 0 6px;
    }
    .mt-deadline-calendar .num {
      display: inline-block;
      font-weight: 500;
    }
    .mt-deadline-calendar ul {
      list-style: none;
      margin: var(--space-4) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .mt-deadline-calendar li a {
      display: block;
      padding: 1px 4px;
      border-radius: var(--radius-sm);
      background: var(--bg-selected);
      color: var(--text-primary);
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mt-deadline-calendar li[data-critical] a {
      box-shadow: inset 3px 0 0 var(--status-danger);
    }
    .mt-deadline-calendar li a:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
  `,
})
export class DeadlineCalendar {
  readonly month = input.required<string>();
  readonly rows = input.required<readonly DeadlineRowVm[]>();
  readonly today = input.required<DateOnly>();
  readonly monthChange = output<string>();

  protected readonly weekdays = WEEKDAYS;
  protected readonly label = computed(() => monthLabel(this.month()));
  protected readonly thisMonth = computed(() => this.today().slice(0, 7));
  protected readonly weeks = computed(() =>
    monthCalendar<CalendarRow>(
      this.month(),
      this.rows().map((row) => ({ ...row.deadline, id: row.key, row })),
      this.today(),
    ),
  );

  protected go(delta: number): void {
    this.monthChange.emit(shiftMonth(this.month(), delta));
  }

  protected dayNumber(date: DateOnly): number {
    return Number(date.slice(8));
  }

  protected dayName(date: DateOnly): string {
    return dayLabel(date);
  }

  protected trace(item: CalendarRow): string {
    return deadlineTraceText(item.row.deadline);
  }
}
