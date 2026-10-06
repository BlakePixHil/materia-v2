import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import {
  comparisonPeriod,
  comparisonText,
  DEFAULT_DAILY_TARGET_MINUTES,
  DEFAULT_ORG_TIMEZONE,
  fyStartYear,
  INSIGHTS_COMPARISON_LABELS,
  INSIGHTS_COMPARISONS,
  INSIGHTS_MAX_MONTHS,
  INSIGHTS_RANGE_LABELS,
  INSIGHTS_RANGES,
  insightsPeriod,
  isMonthId,
  MatterTypeSchema,
  monthLabel,
  shiftMonth,
  type InsightsComparison,
  type InsightsPeriod,
  type InsightsRange,
  type Role,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  MATTER_TYPE_LABELS,
  MT_TODAY,
  MtButton,
  MtDelta,
  MtEmptyState,
  MtMeter,
  MtSelect,
  MtStat,
  type MtOption,
} from '@materia/ui';
import { type ChartDatum, MtBarChart, MtLineChart } from '@materia/ui/charts';

import { InsightsCard } from './insights-card';
import { InsightsData } from './insights-data';
import { InsightsDrill, type InsightsDrillData } from './insights-drill';
import {
  buildInsights,
  chartCsv,
  DEADLINE_DRILL,
  pctText,
  trendMonthsOf,
  visibleMembers,
  type InsightsChart,
  type InsightsView,
} from './insights-view';
import { InsightsVisibility } from './insights-visibility';
import { downloadText } from '../billing/download';

interface Selection {
  range: InsightsRange;
  from: string | null;
  to: string | null;
  compare: InsightsComparison;
}

const isRange = (value: string | null): value is InsightsRange =>
  (INSIGHTS_RANGES as readonly string[]).includes(value ?? '');
const isComparison = (value: string | null): value is InsightsComparison =>
  (INSIGHTS_COMPARISONS as readonly string[]).includes(value ?? '');

/**
 * Insights (`/insights`, INS-02): how the practice is doing, from the INS-01 metrics documents
 * only. One row of filters (the period first, then what it is compared with) above the hero
 * (billed, with the FY budget when the period is a financial year), the overview Stats with their
 * change against the comparison, and the charts: billed and collected by month, median days to
 * grant, matters opened by type, utilisation by fee earner, deadline performance, referrers by fees
 * and FY budget by fee earner. Every chart has its table view and a CSV; matters by type and
 * deadline performance drill into the records, referrers into the contact. The period is in the URL
 * (`?period=this_fy&compare=previous`, `?period=custom&from=2026-03&to=2026-06`).
 */
@Component({
  selector: 'mt-insights-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    InsightsCard,
    InsightsVisibility,
    MtBarChart,
    MtButton,
    MtDelta,
    MtEmptyState,
    MtLineChart,
    MtMeter,
    MtSelect,
    MtStat,
  ],
  providers: [InsightsData],
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/card.css',
    '../../../../../../libs/ui/src/generated/components/hero.css',
    '../../../../../../libs/ui/src/generated/components/skel.css',
    '../../../../../../libs/ui/src/generated/components/tableview.css',
    '../../../../../../libs/ui/src/generated/components/table.css',
  ],
  host: { class: 'mt-col mt-insights' },
  template: `
    <div class="mt-row head">
      <h1 class="title-l">Insights</h1>
      <span class="body-s t-3" data-testid="insights-subtitle">{{ subtitle() }}</span>
    </div>

    <div class="toolbar">
      <div class="filters" role="group" aria-label="Period">
        <mt-select
          name="insights-period"
          label="Period"
          [native]="true"
          [options]="rangeOptions"
          [ngModel]="selection().range"
          (ngModelChange)="choose({ range: $event ?? 'this_month' })"
        />
        @if (selection().range === 'custom') {
          <mt-select
            name="insights-from"
            label="From"
            [native]="true"
            [options]="monthOptions()"
            [ngModel]="period().months[0]"
            (ngModelChange)="choose({ from: $event })"
          />
          <mt-select
            name="insights-to"
            label="To"
            [native]="true"
            [options]="monthOptions()"
            [ngModel]="period().months.at(-1)"
            (ngModelChange)="choose({ to: $event })"
          />
        }
        <mt-select
          name="insights-compare"
          label="Compare with"
          [native]="true"
          [options]="comparisonOptions"
          [ngModel]="selection().compare"
          (ngModelChange)="choose({ compare: $event ?? 'none' })"
        />
      </div>
      <mt-insights-visibility class="visibility" />
    </div>

    @if (figures.error()) {
      <div class="mt-card load-error" role="alert">
        <p>Insights couldn’t be loaded. Check your connection and try again.</p>
        <button mtButton variant="secondary" size="sm" iconStart="refresh" (click)="retry()">Try again</button>
      </div>
    } @else if (view(); as v) {
      @if (!v.hasFigures) {
        <mt-empty-state
          icon="insights"
          title="Insights appear after your first month"
          [description]="
            'Nothing has been recorded for ' +
            period().label +
            ' yet. The figures build up as the firm records time, opens matters and sends invoices.'
          "
          data-testid="insights-empty"
        />
      } @else {
        <div class="grid" [attr.aria-busy]="figures.isLoading()">
          <section class="mt-card hero-card" aria-labelledby="insights-hero" data-testid="insights-hero">
            <div class="mt-card-h">
              <h2 class="mt-card-title" id="insights-hero">Billed in {{ period().label }}</h2>
              <span class="mt-ml caption t-3">Excluding GST</span>
            </div>
            <div class="mt-hero" data-testid="hero-billed">{{ money(v.summary.billedCents) }}</div>
            @if (v.heroBudget; as budget) {
              <div class="mt-col" style="gap: 8px">
                <mt-meter
                  [value]="v.summary.billedCents"
                  [max]="budget.budgetCents"
                  [target]="(budget.budgetCents * v.fyElapsedPct) / 100"
                  [label]="'Billed against the ' + v.fyLabel + ' budget'"
                />
                <div class="mt-row caption t-3 meter-caption">
                  <span data-testid="hero-budget">{{ budget.pct }}% of the {{ money(budget.budgetCents) }} budget</span>
                  <span class="mt-ml">Tick: where the year should be today ({{ v.fyElapsedPct }}%)</span>
                </div>
              </div>
            }
            @if (v.deltas.billed; as d) {
              <span class="caption t-3"
                ><mt-delta [value]="d.text" [direction]="d.direction" [good]="d.good" /> {{ versus() }}</span
              >
            }
          </section>

          <div class="stats">
            <mt-stat label="Collected" [value]="money(v.summary.collectedCents)" data-testid="stat-collected">
              @if (v.deltas.collected; as d) {
                <span class="caption t-3"
                  ><mt-delta [value]="d.text" [direction]="d.direction" [good]="d.good" /> {{ versus() }}</span
                >
              } @else {
                <span class="caption t-3">Payments received</span>
              }
            </mt-stat>
            <mt-stat
              label="Work in progress"
              [value]="v.summary.wipCents === null ? '—' : money(v.summary.wipCents)"
              data-testid="stat-wip"
            >
              @if (v.deltas.wip; as d) {
                <span class="caption t-3"
                  ><mt-delta [value]="d.text" [direction]="d.direction" [good]="d.good" /> {{ versus() }}</span
                >
              } @else {
                <span class="caption t-3">Unbilled time and disbursements</span>
              }
            </mt-stat>
            <mt-stat label="Utilisation" [value]="pct(v.summary.utilisationPct)" data-testid="stat-utilisation">
              @if (v.deltas.utilisation; as d) {
                <span class="caption t-3"
                  ><mt-delta [value]="d.text" [direction]="d.direction" [good]="d.good" /> {{ versus() }}</span
                >
              } @else {
                <span class="caption t-3">Billable hours against the daily target</span>
              }
            </mt-stat>
            <mt-stat label="Matters opened" [value]="v.summary.mattersOpened" data-testid="stat-opened">
              @if (v.deltas.opened; as d) {
                <span class="caption t-3"
                  ><mt-delta [value]="d.text" [direction]="d.direction" [good]="d.good" /> {{ versus() }}</span
                >
              } @else {
                <span class="caption t-3">{{ v.summary.mattersClosed }} closed</span>
              }
            </mt-stat>
            <mt-stat
              label="Deadlines met on time"
              [value]="pct(v.summary.deadlinesMetPct)"
              data-testid="stat-deadlines"
            >
              @if (v.deltas.deadlines; as d) {
                <span class="caption t-3"
                  ><mt-delta [value]="d.text" [direction]="d.direction" [good]="d.good" /> {{ versus() }}</span
                >
              } @else {
                <span class="caption t-3">{{ v.summary.deadlinesDue }} due</span>
              }
            </mt-stat>
          </div>

          <mt-insights-card class="span-8" title="Billed by month" [caption]="v.trendLabel" (download)="csv('billed')">
            <mt-bar-chart
              label="Billed by month"
              categoryLabel="Month"
              valueLabel="Billed"
              [data]="v.billedByMonth"
              [format]="money"
              [tickFormat]="compactMoney"
              [labelPoints]="lastPoint(v.billedByMonth)"
              emptyText="Nothing billed in these months"
            />
          </mt-insights-card>
          <mt-insights-card
            class="span-4"
            title="Collected by month"
            [caption]="v.trendLabel"
            (download)="csv('collected')"
          >
            <mt-bar-chart
              label="Collected by month"
              categoryLabel="Month"
              valueLabel="Collected"
              [data]="v.collectedByMonth"
              [format]="money"
              [tickFormat]="compactMoney"
              emptyText="Nothing collected in these months"
            />
          </mt-insights-card>

          <mt-insights-card
            class="span-6"
            title="Matters opened by type"
            [caption]="period().label"
            (download)="csv('types')"
          >
            <mt-bar-chart
              label="Matters opened by type"
              categoryLabel="Matter type"
              valueLabel="Matters opened"
              orientation="horizontal"
              drill
              [chartHeight]="rowsHeight(v.mattersByType.length)"
              [data]="v.mattersByType"
              (pointSelect)="drillType($event)"
              emptyText="No matters opened in this period"
            />
            @if (v.mattersByType.length) {
              <span class="caption t-3">Choose a bar to list those matters.</span>
            }
          </mt-insights-card>
          <mt-insights-card
            class="span-6"
            title="Median days to grant"
            caption="Probate, by month of grant"
            (download)="csv('grant')"
          >
            <mt-line-chart
              label="Median days from instructions to grant"
              categoryLabel="Month of grant"
              valueLabel="Median days"
              [data]="v.grantDays"
              [comparison]="v.grantDaysComparison"
              comparisonLabel="A year earlier"
              [format]="days"
              emptyText="No grants in these months"
            />
          </mt-insights-card>

          <mt-insights-card
            class="span-6"
            title="Utilisation by fee earner"
            [caption]="period().label"
            (download)="csv('utilisation')"
          >
            <mt-bar-chart
              label="Utilisation by fee earner"
              categoryLabel="Fee earner"
              valueLabel="Utilisation"
              orientation="horizontal"
              [chartHeight]="rowsHeight(v.utilisation.length)"
              [data]="v.utilisation"
              [format]="percent"
              [target]="{ value: 100, label: 'Target' }"
              emptyText="No time recorded in this period"
            />
            <span class="caption t-3">
              Billable hours against {{ dailyTargetHours() }} hours a working day.
              @if (v.ownFiguresOnly) {
                Only your own figures: your firm shows everyone’s to {{ visibilityText() }}.
              }
            </span>
          </mt-insights-card>
          <mt-insights-card
            class="span-6"
            title="Deadline performance"
            [caption]="'Due ' + period().label"
            (download)="csv('deadlines')"
          >
            <mt-bar-chart
              label="Deadlines by how they ended"
              categoryLabel="Result"
              valueLabel="Deadlines"
              drill
              [data]="v.deadlines"
              (pointSelect)="drillDeadlines($event)"
              emptyText="No deadlines due in this period"
            />
          </mt-insights-card>

          <mt-insights-card
            class="span-6"
            title="Referrers by fees"
            [caption]="period().label"
            (download)="csv('referrers')"
          >
            <mt-bar-chart
              label="Fees billed on referred matters, by referrer"
              categoryLabel="Referrer"
              valueLabel="Billed"
              orientation="horizontal"
              drill
              [chartHeight]="rowsHeight(v.referrers.length)"
              [data]="v.referrers"
              [format]="money"
              [tickFormat]="compactMoney"
              (pointSelect)="openReferrer($event)"
              emptyText="No referred matters in this period"
            />
          </mt-insights-card>
          <mt-insights-card
            class="span-6"
            [title]="v.fyLabel + ' budget by fee earner'"
            [caption]="v.fyElapsedPct + '% of the year gone'"
            [csv]="v.budgets.length > 0"
            (download)="csv('budgets')"
          >
            @if (v.budgets.length) {
              <ul class="budgets" data-testid="insights-budgets">
                @for (row of v.budgets; track row.uid) {
                  <li>
                    <span class="name">{{ row.name }}</span>
                    <mt-meter
                      class="mt-grow"
                      [value]="row.recordedCents"
                      [max]="row.budgetCents"
                      [target]="row.expectedCents"
                      [tone]="row.behind ? 'warning' : 'brand'"
                      [label]="row.name + ': recorded against the ' + v.fyLabel + ' budget'"
                    />
                    <span class="mono-s pct">{{ row.pct }}%</span>
                  </li>
                }
              </ul>
              <details class="mt-tableview">
                <summary>View as table</summary>
                <table class="mt-table">
                  <caption class="mt-sr">
                    {{
                      v.fyLabel
                    }}
                    budget by fee earner
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Fee earner</th>
                      <th scope="col" class="num">Recorded</th>
                      <th scope="col" class="num">Budget</th>
                      <th scope="col" class="num">Recorded (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of v.budgets; track row.uid) {
                      <tr>
                        <td>{{ row.name }}</td>
                        <td class="num">{{ money(row.recordedCents) }}</td>
                        <td class="num">{{ money(row.budgetCents) }}</td>
                        <td class="num">{{ row.pct }}%</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </details>
              <span class="caption t-3">Time recorded at its value. The tick marks where each should be today.</span>
            } @else {
              <p class="caption t-3" style="margin: 0">
                No budgets set for {{ v.fyLabel }}. Owners set them in Settings → Team.
              </p>
            }
          </mt-insights-card>
        </div>
      }
    } @else {
      <div class="grid" aria-busy="true" data-testid="insights-loading">
        <span class="mt-sr">Loading insights</span>
        @for (span of skeletons; track $index) {
          <div class="mt-card skeleton" [class]="'span-' + span" aria-hidden="true">
            <span class="mt-skel" style="width: 40%"></span>
            <span class="mt-skel" style="height: 120px"></span>
          </div>
        }
      </div>
    }
  `,
  styles: `
    .mt-insights {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-insights h1 {
      margin: 0;
    }
    .mt-insights .head {
      align-items: baseline;
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-insights .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--space-12);
    }
    .mt-insights .filters mt-select {
      width: 200px;
    }
    .mt-insights .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      justify-content: space-between;
      gap: var(--space-12);
    }
    .mt-insights .visibility mt-select {
      width: 240px;
    }
    .mt-insights .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: var(--space-16);
      align-items: start;
    }
    .mt-insights .hero-card {
      grid-column: span 5;
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
      align-self: stretch;
    }
    .mt-insights .meter-caption {
      flex-wrap: wrap;
      gap: var(--space-8);
    }
    .mt-insights .stats {
      grid-column: span 7;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-12);
    }
    .mt-insights .span-4 {
      grid-column: span 4;
    }
    .mt-insights .span-5 {
      grid-column: span 5;
    }
    .mt-insights .span-6 {
      grid-column: span 6;
    }
    .mt-insights .span-7 {
      grid-column: span 7;
    }
    .mt-insights .span-8 {
      grid-column: span 8;
    }
    .mt-insights .skeleton {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
    }
    .mt-insights .load-error {
      display: flex;
      align-items: center;
      gap: var(--space-12);
      flex-wrap: wrap;
      padding: var(--space-16);
    }
    .mt-insights .load-error p {
      margin: 0;
    }
    .mt-insights .budgets {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-insights .budgets li {
      display: flex;
      align-items: center;
      gap: var(--space-12);
    }
    .mt-insights .budgets .name {
      flex: 0 0 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 500 13px/18px var(--font-sans);
    }
    .mt-insights .budgets .pct {
      flex: 0 0 44px;
      text-align: right;
    }
    @media (max-width: 1180px) {
      .mt-insights .hero-card,
      .mt-insights .stats {
        grid-column: span 12;
      }
      .mt-insights .span-4,
      .mt-insights .span-8 {
        grid-column: span 6;
      }
    }
    @media (max-width: 860px) {
      .mt-insights .grid > * {
        grid-column: span 12;
      }
      .mt-insights .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 480px) {
      .mt-insights .stats {
        grid-template-columns: minmax(0, 1fr);
      }
      .mt-insights .filters mt-select,
      .mt-insights .visibility,
      .mt-insights .visibility mt-select {
        width: 100%;
      }
    }
  `,
})
export class InsightsPage {
  private readonly context = inject(OrgContext);
  private readonly data = inject(InsightsData);
  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly today = inject(MT_TODAY);

  protected readonly rangeOptions: MtOption<InsightsRange>[] = INSIGHTS_RANGES.map((range) => ({
    value: range,
    label: INSIGHTS_RANGE_LABELS[range],
  }));
  protected readonly comparisonOptions: MtOption<InsightsComparison>[] = INSIGHTS_COMPARISONS.map((mode) => ({
    value: mode,
    label: INSIGHTS_COMPARISON_LABELS[mode],
  }));
  protected readonly skeletons = [5, 7, 8, 4, 6, 6];

  protected readonly selection = signal<Selection>(this.fromUrl());

  /** The org's settings the figures depend on (FY start, daily target, time zone, visibility). */
  private readonly org = resource({
    params: () => this.context.orgId() ?? undefined,
    loader: () => this.data.loadOrg(),
  });
  /** The org's settings once read; null while loading or when they couldn't be (the figures show the error). */
  private readonly orgSettings = computed(() => (this.org.hasValue() ? this.org.value() : null));
  protected readonly fyStartMonth = computed(() => this.orgSettings()?.fy?.startMonth ?? 7);
  private readonly dailyTarget = computed(
    () => this.orgSettings()?.billing?.dailyTargetMinutes ?? DEFAULT_DAILY_TARGET_MINUTES,
  );
  private readonly timeZone = computed(() => this.orgSettings()?.timezone || DEFAULT_ORG_TIMEZONE);

  protected readonly period = computed(() => {
    const { range, from, to } = this.selection();
    return insightsPeriod({ range, from: from ?? undefined, to: to ?? undefined }, this.today(), this.fyStartMonth());
  });
  protected readonly comparison = computed(() =>
    comparisonPeriod(this.period(), this.selection().compare, this.today()),
  );

  /** Everything the charts read for the period, its comparison and the trend months. */
  protected readonly figures = resource({
    params: () => {
      const role = this.context.role();
      const uid = this.context.uid();
      if (!role || !uid || this.org.isLoading()) return undefined;
      return {
        period: this.period(),
        comparison: this.comparison(),
        me: { uid, role },
        org: this.orgSettings(),
      };
    },
    loader: ({ params }) => this.load(params.period, params.comparison, params.me),
  });
  protected readonly view = computed((): InsightsView | null => {
    if (this.figures.isLoading()) return null;
    return this.figures.hasValue() ? this.figures.value() : null;
  });

  protected readonly subtitle = computed(() => {
    const parts = [this.period().label];
    const cmp = comparisonText(this.comparison());
    if (cmp) parts.push(cmp);
    return parts.join(' · ');
  });
  protected readonly versus = computed(() => {
    const cmp = this.comparison();
    return cmp ? `vs ${cmp.label}` : '';
  });
  protected readonly dailyTargetHours = computed(() =>
    (this.dailyTarget() / 60).toLocaleString('en-AU', { maximumFractionDigits: 1 }),
  );
  protected readonly visibilityText = computed(() => {
    const visibility = this.orgSettings()?.settings?.insights?.memberVisibility ?? 'lawyers';
    return visibility === 'admins' ? 'owners and admins' : 'owners, admins and lawyers';
  });

  /** The 24 months before this one and this one, newest first, for a chosen range. */
  protected readonly monthOptions = computed((): MtOption<string>[] => {
    const now = this.today().slice(0, 7);
    return Array.from({ length: 36 }, (_, i) => shiftMonth(now, -i)).map((month) => ({
      value: month,
      label: monthLabel(month, 'long'),
    }));
  });

  protected readonly money = (cents: number) => formatAud(cents);
  protected readonly compactMoney = (cents: number) => {
    const dollars = cents / 100;
    return Math.abs(dollars) >= 1000
      ? `$${(dollars / 1000).toLocaleString('en-AU', { maximumFractionDigits: 1 })}k`
      : `$${Math.round(dollars).toLocaleString('en-AU')}`;
  };
  protected readonly percent = (value: number) => `${value}%`;
  protected readonly days = (value: number) => `${value} days`;
  protected readonly pct = pctText;

  protected rowsHeight(rows: number): number {
    return Math.max(120, rows * 36 + 40);
  }

  /** The latest bar's label on a month chart (the brand rules label the latest and the extreme). */
  protected lastPoint(data: readonly ChartDatum[]): number[] {
    return data.length ? [data.length - 1] : [];
  }

  protected choose(change: Partial<Selection>): void {
    const current = this.selection();
    let next: Selection = { ...current, ...change };
    if (change.range === 'custom' && !current.from) {
      // Start a chosen range from what is on screen.
      const months = this.period().months;
      next = { ...next, from: months[0] ?? null, to: months.at(-1) ?? null };
    }
    if (next.range === 'custom' && next.from && next.to && next.from > next.to) {
      next = change.from ? { ...next, to: next.from } : { ...next, from: next.to };
    }
    if (next.range === 'custom' && next.from && next.to) {
      const span = monthSpan(next.from, next.to);
      if (span > INSIGHTS_MAX_MONTHS) next = { ...next, from: shiftMonth(next.to, 1 - INSIGHTS_MAX_MONTHS) };
    }
    if (next.range !== 'custom') next = { ...next, from: null, to: null };
    this.selection.set(next);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        period: next.range === 'this_month' ? null : next.range,
        from: next.from,
        to: next.to,
        compare: next.compare === 'none' ? null : next.compare,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected retry(): void {
    this.data.reset();
    this.org.reload();
    this.figures.reload();
  }

  protected csv(chart: InsightsChart): void {
    const view = this.view();
    if (!view) return;
    const file = chartCsv(chart, view, this.period().label);
    downloadText(file.name, file.text, 'text/csv;charset=utf-8');
  }

  protected drillType(datum: ChartDatum): void {
    const view = this.view();
    const index = view?.mattersByType.indexOf(datum) ?? -1;
    const type = MatterTypeSchema.safeParse(view?.matterTypes[index]);
    if (!type.success) return;
    const period = this.period();
    this.openDrill({
      kind: 'matters',
      type: type.data,
      title: `${MATTER_TYPE_LABELS[type.data]} matters opened`,
      periodLabel: period.label,
      start: period.start,
      end: period.end,
      timeZone: this.timeZone(),
    });
  }

  protected drillDeadlines(datum: ChartDatum): void {
    const view = this.view();
    const index = view?.deadlines.indexOf(datum) ?? -1;
    const result = view?.deadlineKeys[index];
    if (!result || !(result in DEADLINE_DRILL)) return;
    const period = this.period();
    this.openDrill({
      kind: 'deadlines',
      result,
      title: `Deadlines ${datum.label.toLowerCase()}`,
      periodLabel: `Due ${period.label}`,
      start: period.start,
      end: period.end,
    });
  }

  protected openReferrer(datum: ChartDatum): void {
    const view = this.view();
    const id = view?.referrerIds[view.referrers.indexOf(datum)];
    if (id) void this.router.navigate(['/contacts'], { queryParams: { contact: id } });
  }

  private openDrill(data: InsightsDrillData): void {
    this.dialogs.open<InsightsDrillData, undefined>(InsightsDrill, { data });
  }

  private fromUrl(): Selection {
    const params = this.route.snapshot.queryParamMap;
    const range = params.get('period');
    const compare = params.get('compare');
    const from = params.get('from');
    const to = params.get('to');
    return {
      range: isRange(range) ? range : 'this_month',
      from: isMonthId(from) ? from : null,
      to: isMonthId(to) ? to : null,
      compare: isComparison(compare) ? compare : 'none',
    };
  }

  private async load(
    period: InsightsPeriod,
    comparison: InsightsPeriod | null,
    me: { uid: string; role: Role },
  ): Promise<InsightsView> {
    const org = await this.data.loadOrg();
    const members = await this.data.loadMembers();
    const sharded = InsightsData.sharded(members);
    const today = this.today();
    const fyStartMonth = org?.fy?.startMonth ?? 7;
    const visibility = org?.settings?.insights?.memberVisibility;

    const trendMonths = trendMonthsOf(period);
    const comparisonMonths = comparison?.months ?? [];
    const grantComparison = comparison ? trendMonths.map((month) => shiftMonth(month, -12)) : [];
    const allMonths = [...new Set([...period.months, ...trendMonths, ...comparisonMonths, ...grantComparison])];

    // A whole FY (or one to date) reads each member's FY document; other periods their months'.
    const budgetFy = period.fy ?? fyStartYear(period.end, fyStartMonth);
    const memberPeriods = period.fy !== null ? [`fy-${period.fy}`] : period.months.map((month) => `month-${month}`);
    const uids = visibleMembers(members, me, visibility).map((member) => member.uid);

    const [months, memberValues, fyMemberValues] = await Promise.all([
      this.data.loadMonths(allMonths, sharded),
      this.data.loadMemberValues(memberPeriods, uids),
      this.data.loadMemberValues([`fy-${budgetFy}`], uids),
    ]);

    const draft = {
      period,
      comparison,
      trendMonths,
      months,
      members,
      memberValues,
      fyMemberValues,
      referrerNames: new Map<string, string>(),
      me,
      visibility,
      dailyTargetMinutes: org?.billing?.dailyTargetMinutes ?? DEFAULT_DAILY_TARGET_MINUTES,
      fyStartMonth,
      today,
    };
    const first = buildInsights(draft);
    if (!first.referrerIds.length) return first;
    const referrerNames = await this.data.loadContactNames(first.referrerIds);
    return buildInsights({ ...draft, referrerNames });
  }
}

/** How many months from `from` to `to`, inclusive. */
function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return ((ty ?? 0) - (fy ?? 0)) * 12 + ((tm ?? 0) - (fm ?? 0)) + 1;
}
