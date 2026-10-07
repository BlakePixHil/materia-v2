import { ChangeDetectionStrategy, Component, computed, inject, signal, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TimeEntryItem, WithId } from '@materia/data-access/repository';
import {
  dayTotals,
  fyBoundaryIn,
  fyLabel,
  sentBack,
  timeByDay,
  timeTotals,
  weekStartOf,
  type DateOnly,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  MtButton,
  MtEmptyState,
  MtIconButton,
  MtNote,
  MtProgress,
  MtTimeEntry,
  ToastService,
  type TimeEntryVm,
} from '@materia/ui';

import { BillingScreen } from './billing-screen';
import {
  byMatter,
  expectedUpdatedAt,
  hoursText,
  mergeResults,
  reviewSummary,
  shiftWeek,
  stripDay,
  weekLabel,
} from './billing-view';
import { errorCopy } from '../../core/error-copy';
import { dayHeading, TIME_STATUS_LABELS } from '../time/time-view';

type Entry = WithId<TimeEntryItem>;

/**
 * My time (BILL-03): my entries for a week, a calendar strip of the days against the org's daily
 * target (a week across 30 June and 1 July marks where the new financial year starts), drafts sent
 * back with their notes, and Finalise week for people who approve their own time. People whose
 * time is approved by someone else see their drafts as waiting. Entries are edited on their
 * matter's Time tab.
 */
@Component({
  selector: 'mt-my-time',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MtButton, MtEmptyState, MtIconButton, MtNote, MtProgress, MtTimeEntry],
  host: { class: 'mt-col mt-my-time' },
  template: `
    <div class="mt-row week-nav">
      <button mtIconButton icon="chevron-left" size="sm" label="Previous week" (click)="move(-1)"></button>
      <h2 class="title-m" data-testid="week-label">{{ weekText() }}</h2>
      <button mtIconButton icon="chevron-right" size="sm" label="Next week" (click)="move(1)"></button>
      @if (!isThisWeek()) {
        <button mtButton size="sm" variant="ghost" (click)="thisWeek()">This week</button>
      }
      <span class="mt-ml caption t-3" data-testid="week-summary">{{ summary() }}</span>
    </div>

    <div class="strip" role="group" aria-label="Days of the week">
      @for (day of days(); track day.date) {
        <button
          type="button"
          class="day"
          [attr.data-date]="day.date"
          [attr.data-selected]="selected() === day.date ? '' : null"
          [attr.data-today]="day.date === screen.today() ? '' : null"
          [attr.aria-pressed]="selected() === day.date"
          [attr.aria-label]="dayLabel(day)"
          (click)="toggle(day.date)"
        >
          @if (day.date === boundary()) {
            <span class="fy caption" data-testid="fy-boundary">{{ newFyLabel() }}</span>
          }
          <span class="caption t-3">{{ strip(day.date).weekday }}</span>
          <span class="title-m">{{ strip(day.date).day }}</span>
          <span class="mono-s">{{ hours(day.minutes) }} h</span>
          @if (day.targetMinutes) {
            <mt-progress
              [value]="day.minutes"
              [max]="day.targetMinutes"
              [label]="'Against the ' + hours(day.targetMinutes) + '-hour target'"
              [tone]="day.minutes >= day.targetMinutes ? 'success' : 'brand'"
            />
          }
        </button>
      }
    </div>

    @for (entry of returned(); track entry.id) {
      <mt-note tone="warning" data-testid="sent-back">
        <b>{{ screen.memberName(entry.rejection?.by ?? '') }}</b> sent back “{{ entry.narrative || 'No narrative' }}”:
        {{ entry.rejection?.note }}
        <a class="mt-ml" [routerLink]="['/matters', entry.matterId, 'time']">Change it</a>
      </mt-note>
    }

    @if (drafts().length) {
      <div class="mt-row drafts">
        <span class="body-s t-2 mt-grow">
          <b class="t-1">{{ drafts().length }} {{ drafts().length === 1 ? 'draft' : 'drafts' }}</b>
          @if (screen.canApprove()) {
            this week to finalise.
          } @else {
            this week waiting for approval{{ supervisorText() }}.
          }
        </span>
        @if (screen.canApprove()) {
          <button
            mtButton
            size="sm"
            variant="primary"
            iconStart="check-circle"
            [loading]="busy()"
            (click)="finaliseWeek()"
          >
            Finalise week
          </button>
        }
      </div>
    }

    @switch (screen.weekEntries.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading your time…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
      @default {
        @for (day of shownDays(); track day.date) {
          <section class="day-list" [attr.aria-labelledby]="'my-time-' + day.date">
            <h3 class="mt-row day-head" [id]="'my-time-' + day.date">
              <span class="label">{{ heading(day.date) }}</span>
              <span class="mt-ml caption t-3">{{ screen.unitsText(day.units) }} · {{ amount(day.amountCents) }}</span>
            </h3>
            <ul class="rows" role="list">
              @for (entry of day.entries; track entry.id) {
                <li>
                  <mt-time-entry [entry]="row(entry)" [attr.data-status]="entry.status">
                    <a
                      mtIconButton
                      icon="arrow-right"
                      size="sm"
                      [label]="'Open ' + screen.matter(entry.matterId ?? '').number + ' time'"
                      [routerLink]="['/matters', entry.matterId, 'time']"
                    ></a>
                  </mt-time-entry>
                </li>
              }
            </ul>
          </section>
        } @empty {
          <mt-empty-state
            icon="timer"
            [title]="selected() ? 'No time on ' + heading(selected() ?? '') : 'No time this week'"
            description="Press t anywhere to record time: a duration such as 0.3, 18m or 1:12, then what you did."
            [headingLevel]="3"
          />
        }
      }
    }
    <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>
  `,
  styles: `
    .mt-my-time {
      gap: var(--space-12);
    }
    .mt-my-time h2,
    .mt-my-time h3 {
      margin: 0;
    }
    .mt-my-time .week-nav {
      align-items: center;
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-my-time .strip {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: var(--space-8);
    }
    .mt-my-time .day {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: var(--space-8);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      color: var(--text-primary);
      font: inherit;
      text-align: left;
      cursor: pointer;
      min-width: 0;
    }
    .mt-my-time .day:hover {
      border-color: var(--border-strong);
    }
    .mt-my-time .day[data-today] {
      border-color: var(--border-focus);
    }
    .mt-my-time .day[data-selected] {
      background: var(--bg-selected);
      border-color: var(--border-focus);
    }
    .mt-my-time .day:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .mt-my-time .day .mt-progress {
      width: 100%;
    }
    .mt-my-time .day .fy {
      position: absolute;
      top: -9px;
      left: var(--space-8);
      padding: 0 4px;
      border-radius: var(--radius-sm);
      background: var(--bg-canvas);
      color: var(--text-brand);
    }
    .mt-my-time .drafts {
      align-items: center;
      gap: var(--space-12);
      padding: var(--space-8) var(--space-12);
      border-radius: var(--radius-md);
      background: var(--bg-canvas);
    }
    .mt-my-time .day-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-my-time .day-head {
      align-items: baseline;
      padding: 0 var(--space-4);
      font: inherit;
    }
    .mt-my-time .rows {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    @media (max-width: 640px) {
      .mt-my-time .strip {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
  `,
})
export class MyTime {
  protected readonly screen = inject(BillingScreen);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly selected = signal<DateOnly | null>(null);
  protected readonly busy = signal(false);
  protected readonly announcement = signal('');

  private readonly entries = computed(() => this.screen.weekEntries.value().filter((entry) => !entry.deletedAt));
  protected readonly days = computed(() =>
    dayTotals(this.entries(), this.screen.weekDates(), this.screen.dailyTargetMinutes()),
  );
  protected readonly shownDays = computed(() => {
    const day = this.selected();
    return timeByDay(this.entries().filter((entry) => !day || entry.date === day));
  });
  protected readonly drafts = computed(() => this.entries().filter((entry) => entry.status === 'draft'));
  protected readonly returned = computed(() => this.entries().filter((entry) => sentBack(entry)));
  protected readonly boundary = computed(() => fyBoundaryIn(this.screen.weekDates(), this.screen.fyStartMonth()));
  protected readonly newFyLabel = computed(() => {
    const day = this.boundary();
    return day ? `${fyLabel(Number(day.slice(0, 4)), this.screen.fyStartMonth())} starts` : '';
  });
  protected readonly weekText = computed(() => weekLabel(this.screen.weekDates()));
  protected readonly isThisWeek = computed(() => this.screen.weekDates().includes(this.screen.today()));
  protected readonly summary = computed(() => {
    const totals = timeTotals(this.entries());
    const target = this.days().reduce((sum, day) => sum + day.targetMinutes, 0);
    return `${hoursText(totals.minutes)} of ${hoursText(target)} h target · ${formatAud(totals.amountCents)} billable`;
  });
  protected readonly loadError = computed(() => errorCopy(this.screen.weekEntries.error()));
  protected readonly supervisorText = computed(() => {
    const supervisor = this.screen.myMember()?.supervisorUid;
    return supervisor ? ` from ${this.screen.memberName(supervisor)}` : '';
  });

  protected strip(date: DateOnly) {
    return stripDay(date);
  }

  protected hours(minutes: number): string {
    return hoursText(minutes);
  }

  protected amount(cents: number): string {
    return formatAud(cents);
  }

  protected heading(date: string): string {
    return dayHeading(date, this.screen.today());
  }

  protected dayLabel(day: { date: DateOnly; minutes: number; targetMinutes: number }): string {
    const target = day.targetMinutes ? ` of ${hoursText(day.targetMinutes)}` : '';
    return `${this.heading(day.date)}: ${hoursText(day.minutes)}${target} hours`;
  }

  protected row(entry: Entry): TimeEntryVm {
    const matter = this.screen.matter(entry.matterId ?? '');
    const meta = [matter.number, matter.title, entry.status === 'draft' ? null : TIME_STATUS_LABELS[entry.status]];
    return {
      id: entry.id,
      description: entry.narrative.trim() || 'No narrative',
      meta: meta.filter(Boolean).join(' · '),
      minutes: entry.minutes,
      units: entry.units,
      amountCents: entry.amountCents,
      source: 'manual',
      unit: this.screen.unitMinutes(),
      ...(entry.billable ? {} : { valueLabel: 'Non-billable' }),
    };
  }

  protected move(weeks: number): void {
    this.selected.set(null);
    this.screen.weekOf.set(shiftWeek(this.screen.weekOf(), weeks));
  }

  protected thisWeek(): void {
    this.selected.set(null);
    this.screen.weekOf.set(weekStartOf(this.screen.today()));
  }

  protected toggle(date: DateOnly): void {
    this.selected.update((current) => (current === date ? null : date));
  }

  /** Marks every draft this week final, one call per matter (`time-setStatus`). */
  protected async finaliseWeek(): Promise<void> {
    const drafts = this.drafts();
    const confirmed = await this.dialogs.confirm({
      title: `Finalise ${drafts.length} ${drafts.length === 1 ? 'entry' : 'entries'}?`,
      body: 'Final time is priced at the rate in force on each day and counts as work in progress. Approvers can still write it down.',
      confirmLabel: 'Finalise week',
    });
    if (!confirmed) return;
    this.busy.set(true);
    try {
      const results = await Promise.all(
        [...byMatter(drafts)].map(([matterId, entries]) =>
          this.screen.api.setStatus({
            matterId,
            entryIds: entries.map((entry) => entry.id),
            status: 'final',
            expectedUpdatedAt: expectedUpdatedAt(entries),
          }),
        ),
      );
      const text = reviewSummary(mergeResults(results), 'Finalised');
      this.announcement.set(text);
      this.toasts.show({ title: 'Week finalised', description: text, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The week wasn’t finalised', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(false);
    }
  }
}
