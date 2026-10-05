import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import { clerkMetricsRepository, MEMBER_LIST_QUERY, membersRepository } from '@materia/data-access/repository';
import {
  clerkUsageFromMetrics,
  formatUsdCents,
  microsToCents,
  ORG_CLERK_FEATURES,
  suggestionAcceptance,
  type ClerkUsageRow,
} from '@materia/domain';
import { MtMeter, MtSelect, MtStat, type MtOption } from '@materia/ui';
import { type ChartDatum, MtBarChart } from '@materia/ui/charts';

/** Gateway feature names as people know them; others (the connectivity check, OCR) as they are. */
const FEATURE_LABELS: Record<string, string> = {
  hello: 'Connection check',
  ocr: 'Reading scans',
  willExtraction: 'Read wills',
  ...Object.fromEntries(ORG_CLERK_FEATURES.map((f) => [f.key, f.label])),
};

/** `clerk-2026-10` → "October 2026". */
function monthLabel(period: string): string {
  const [year, month] = period.replace('clerk-', '').split('-').map(Number);
  return new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1, 1)).toLocaleDateString('en-AU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The last `count` metering periods, newest first, from the current one. */
export function recentPeriods(current: string, count = 6): string[] {
  const [year, month] = current.replace('clerk-', '').split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1 - i, 1));
    return `clerk-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

const cents = (micros: number) => formatUsdCents(microsToCents(micros));
const compact = (value: number) =>
  value.toLocaleString('en-AU', { notation: value >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 });

/**
 * Clerk usage for owners and admins (AI-13), from the month's metering document
 * (`metrics/clerk-{YYYY-MM}`): spend against the monthly limit, tokens and requests, the share of
 * suggestions people accepted, and cost by feature and by person. Anthropic bills the firm in US
 * dollars; these figures are Materia's estimate from the published prices.
 */
@Component({
  selector: 'mt-clerk-usage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtBarChart, MtMeter, MtSelect, MtStat],
  host: { class: 'mt-col', style: 'gap: 16px' },
  template: `
    <div class="mt-row" style="gap: 12px; align-items: end; flex-wrap: wrap">
      <h2 class="title-s mt-grow" style="margin: 0">Usage</h2>
      <mt-select
        name="clerk-usage-month"
        label="Month"
        [native]="true"
        [options]="months()"
        [ngModel]="selected()"
        (ngModelChange)="period.set($event ?? currentPeriod())"
      />
    </div>

    @if (metrics.status() === 'error') {
      <p class="t-danger" role="alert" style="margin: 0">Usage couldn’t be loaded.</p>
    } @else {
      @if (budgetCents() !== null) {
        <mt-meter
          [label]="'Spend against the ' + budgetText() + ' monthly limit'"
          [value]="spentCents()"
          [max]="budgetCents() || 1"
          [tone]="spentCents() >= (budgetCents() ?? 0) ? 'warning' : 'brand'"
          data-budget-meter
        />
        @if (spentCents() >= (budgetCents() ?? 0)) {
          <p class="caption t-danger" style="margin: 0" data-budget-reached>
            The limit is reached. Clerk is off until next month or until the limit is raised.
          </p>
        }
      }
      <div class="stats">
        <mt-stat label="Estimated cost" [value]="cost()" />
        <mt-stat label="Requests" [value]="usage().calls" />
        <mt-stat label="Tokens" [value]="tokens()" />
        <mt-stat label="Suggestions accepted" [value]="acceptance()" />
      </div>
      @if (usage().estimatedCostCalls) {
        <p class="caption t-3" style="margin: 0">
          {{ usage().estimatedCostCalls }} request(s) used a model without a published price, so their cost is
          estimated.
        </p>
      }
      <mt-bar-chart
        label="Cost by feature"
        categoryLabel="Feature"
        valueLabel="Cost"
        orientation="horizontal"
        [chartHeight]="chartHeight(byFeature().length)"
        [data]="byFeature()"
        [format]="usd"
        [loading]="metrics.status() === 'loading'"
        emptyText="No Clerk use this month"
      />
      <mt-bar-chart
        label="Cost by person"
        categoryLabel="Person"
        valueLabel="Cost"
        orientation="horizontal"
        [chartHeight]="chartHeight(byUser().length)"
        [data]="byUser()"
        [format]="usd"
        [loading]="metrics.status() === 'loading'"
        emptyText="No Clerk use this month"
      />
      <p class="caption t-3" style="margin: 0">
        Estimated from Anthropic’s published prices. Your firm’s Anthropic invoice is the final amount.
      </p>
    }
  `,
  styles: `
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
    }
  `,
})
export class ClerkUsage {
  private readonly context = inject(OrgContext);

  /** The month now (`clerk-YYYY-MM`, Melbourne). */
  readonly currentPeriod = input.required<string>();
  /** The org's monthly limit in US cents, or null for none. */
  readonly budgetCents = input<number | null>(null);

  protected readonly period = signal<string | null>(null);
  protected readonly selected = computed(() => this.period() ?? this.currentPeriod());
  protected readonly months = computed((): MtOption<string>[] =>
    recentPeriods(this.currentPeriod()).map((p) => ({ value: p, label: monthLabel(p) })),
  );

  protected readonly metrics = clerkMetricsRepository().watch(() => (this.context.orgId() ? this.selected() : null));
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });

  protected readonly usage = computed(() => clerkUsageFromMetrics(this.metrics.value()?.values));
  protected readonly cost = computed(() => cents(this.usage().costMicros));
  protected readonly tokens = computed(() => compact(this.usage().tokens));
  protected readonly spentCents = computed(() => microsToCents(this.usage().costMicros));
  protected readonly budgetText = computed(() => formatUsdCents(this.budgetCents() ?? 0));
  protected readonly acceptance = computed(() => {
    const rate = suggestionAcceptance(this.usage().suggestions);
    return rate === null ? '—' : `${Math.round(rate * 100)}%`;
  });

  private readonly names = computed(
    () => new Map(this.members.value().map((m) => [m.id, m.displayName || 'Former member'])),
  );
  protected readonly byFeature = computed(() => this.bars(this.usage().byFeature, (key) => FEATURE_LABELS[key] ?? key));
  protected readonly byUser = computed(() =>
    this.bars(this.usage().byUser, (key) => this.names().get(key) ?? 'Former member'),
  );

  protected readonly usd = (cents: number) => formatUsdCents(cents);
  protected chartHeight(rows: number): number {
    return Math.max(120, rows * 36 + 40);
  }

  private bars(rows: readonly ClerkUsageRow[], label: (key: string) => string): ChartDatum[] {
    return rows.map((row) => ({
      label: label(row.key),
      value: microsToCents(row.costMicros),
      meta: `${row.calls.toLocaleString('en-AU')} request(s)`,
    }));
  }
}
