import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';

import { can } from '@materia/data-access';
import { insightsNarrativeCallables } from '@materia/data-access/repository';
import type {
  ExplainInsightsResult,
  InsightsComparison,
  InsightsNarrativeView,
  InsightsRange,
  ShownCitation,
} from '@materia/domain';
import { MtButton, MtClerkMark } from '@materia/ui';

import type { InsightsView } from './insights-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';

/** The Insights selection Clerk explains: the screen's URL parameters. */
export interface NarrativeSelection {
  range: InsightsRange;
  from: string | null;
  to: string | null;
  compare: InsightsComparison;
}

/** Where on the Insights screen a cited figure is shown. */
export type NarrativeSection =
  | 'hero'
  | 'collected'
  | 'wip'
  | 'utilisation'
  | 'opened'
  | 'deadlines'
  | 'types'
  | 'deadline-results'
  | 'grant'
  | 'referrers';

/** A section, and for a chart the bar (a matter type, a deadline result) to pick out. */
export interface NarrativeTarget {
  section: NarrativeSection;
  key?: string;
}

const SECTIONS: Readonly<Record<string, NarrativeSection>> = {
  'billing.invoicedCents': 'hero',
  'billing.collectedCents': 'collected',
  wip: 'wip',
  'time.billable.minutes': 'utilisation',
  'matters.opened': 'opened',
  'matters.closed': 'opened',
  'deadlines.due': 'deadlines',
  'deadlines.metOnTimePct': 'deadlines',
  'cycle.probate.instructionsToGrant': 'grant',
  'matters.opened.referred': 'referrers',
  'referrals.netBilledCents': 'referrers',
};
const DEADLINE_RESULTS = new Set(['metOnTime', 'metLate', 'missed', 'waived']);

/**
 * Where a citation's figure is on screen: the hero, a Stat, or a chart (with its bar when the
 * chart has one for it). Null for figures the screen doesn't show (time recorded, write-offs,
 * money owed), whose chips stay plain.
 */
export function narrativeTarget(citation: ShownCitation, view: InsightsView | null): NarrativeTarget | null {
  if (!view) return null;
  if (citation.metric === 'matters.opened.type') {
    const key = citation.dimension;
    return key && view.matterTypes.includes(key) ? { section: 'types', key } : { section: 'types' };
  }
  const result = citation.metric.startsWith('deadlines.') ? citation.metric.slice('deadlines.'.length) : '';
  if (DEADLINE_RESULTS.has(result))
    return (view.deadlineKeys as readonly string[]).includes(result)
      ? { section: 'deadline-results', key: result }
      : { section: 'deadlines' };
  const section = SECTIONS[citation.metric];
  return section ? { section } : null;
}

const PROBLEM_COPY = {
  failed: 'Clerk couldn’t explain these figures this time. Try again in a moment.',
  unverified:
    'Clerk’s explanation didn’t match the figures, so it isn’t shown. Try again, and contact support if it keeps happening.',
} as const;

const writtenFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

type Busy = 'explain' | 'refresh' | null;

/**
 * "What changed" on Insights (INS-04, ADR-054): Clerk's plain-English explanation of the period
 * against its comparison, from the practice's figures only. Each paragraph lists the figures it
 * uses as chips (label and value); a chip whose figure is on screen picks it out (`cite`).
 * Opening a selection shows the explanation kept for it (24 hours), if any; Explain asks Clerk for
 * one, and Refresh asks again once it is 10 minutes old. Shown when Clerk and the feature are on
 * and the role may use Clerk; hidden when the practice has turned it off.
 */
@Component({
  selector: 'mt-insights-narrative',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtClerkMark],
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/card.css',
    '../../../../../../libs/ui/src/generated/components/cite.css',
  ],
  host: { class: 'mt-insights-narrative' },
  template: `
    @if (visible()) {
      <section
        class="mt-card"
        data-pad
        aria-labelledby="insights-narrative-title"
        data-testid="insights-narrative"
        [attr.aria-busy]="busy() !== null"
      >
        <div class="mt-card-h">
          <mt-clerk-mark size="xs" />
          <h2 class="mt-card-title" id="insights-narrative-title">What changed</h2>
          @if (narrative(); as n) {
            <span class="caption t-3" data-testid="narrative-written">Written {{ written(n) }}</span>
          }
          <span class="mt-ml">
            @if (narrative()) {
              <button
                mtButton
                variant="ghost"
                size="sm"
                iconStart="refresh"
                [loading]="busy() === 'refresh'"
                [disabled]="busy() !== null || !canRefresh()"
                [attr.title]="
                  canRefresh() ? null : 'Clerk can explain these figures again 10 minutes after it last did.'
                "
                (click)="run('refresh')"
              >
                Refresh
              </button>
            } @else {
              <button
                mtButton
                variant="secondary"
                size="sm"
                iconStart="sparkle"
                [loading]="busy() === 'explain'"
                [disabled]="busy() !== null"
                (click)="run('explain')"
              >
                Explain with Clerk
              </button>
            }
          </span>
        </div>

        @if (problem(); as p) {
          <p class="caption t-2" role="alert" data-testid="narrative-problem">{{ p }}</p>
        }
        @if (narrative(); as n) {
          @if (n.stale) {
            <p class="caption t-2" data-testid="narrative-stale">
              The figures have changed since Clerk wrote this. Refresh to explain them again.
            </p>
          }
          @if (n.insufficientData && !n.paragraphs.length) {
            <p class="body-m">There isn’t enough recorded for {{ n.periodLabel }} yet to say what changed.</p>
          }
          @for (paragraph of n.paragraphs; track $index) {
            <div class="para">
              <p class="body-m">{{ paragraph.text }}</p>
              @if (paragraph.citations.length) {
                <ul class="cites" aria-label="Figures used">
                  @for (citation of paragraph.citations; track $index) {
                    <li>
                      @if (targetOf()(citation); as target) {
                        <button
                          type="button"
                          class="mt-cite"
                          [attr.title]="chipText(citation, n)"
                          [attr.aria-label]="'Show ' + chipText(citation, n)"
                          (click)="cite.emit(target)"
                        >
                          {{ citation.label }} <span class="n">{{ citation.value }}</span
                          >{{ periodOf(citation, n) }}
                        </button>
                      } @else {
                        <span class="mt-cite plain" [attr.title]="chipText(citation, n)">
                          {{ citation.label }} <span class="n">{{ citation.value }}</span
                          >{{ periodOf(citation, n) }}
                        </span>
                      }
                    </li>
                  }
                </ul>
              }
            </div>
          }
          @if (n.omitted) {
            <p class="caption t-3" data-testid="narrative-omitted">
              Clerk left out {{ n.omitted === 1 ? 'a paragraph' : n.omitted + ' paragraphs' }} whose numbers didn’t
              match the figures.
            </p>
          }
          <p class="caption t-3">
            Written by Clerk from this page’s totals only, never clients or matters. Every number is checked against the
            figure it cites, but Clerk can still miss what matters most.
          </p>
        } @else if (busy() === null) {
          <p class="caption t-3">
            Clerk can describe what changed in {{ periodText() }}, from this page’s totals only.
          </p>
        }
        <p class="mt-sr" aria-live="polite">{{ announcement() }}</p>
      </section>
    }
  `,
  styles: `
    .mt-insights-narrative .mt-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-insights-narrative .mt-card-h {
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-insights-narrative p {
      margin: 0;
    }
    .mt-insights-narrative .para {
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
      max-width: 72ch;
    }
    .mt-insights-narrative .cites {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
      min-width: 0;
    }
    .mt-insights-narrative .cites li {
      max-width: 100%;
      min-width: 0;
    }
    .mt-insights-narrative .mt-cite.plain {
      cursor: default;
    }
    .mt-insights-narrative .mt-cite.plain:hover {
      border-color: var(--border-subtle);
      color: var(--text-secondary);
    }
  `,
})
export class InsightsNarrative {
  private readonly flags = inject(FeatureFlagService);
  private readonly api = insightsNarrativeCallables(inject(CALLABLES));

  readonly selection = input.required<NarrativeSelection>();
  /** "September 2026 compared with August 2026", for the prompt to explain. */
  readonly periodText = input.required<string>();
  /** Where a citation's figure is on screen (null: the chip stays plain). */
  readonly targetOf = input<(citation: ShownCitation) => NarrativeTarget | null>(() => null);
  /** A chip was chosen: pick out its figure. */
  readonly cite = output<NarrativeTarget>();

  private readonly canUse = can('clerk.use');
  /** The practice has turned Clerk or this feature off (a kept explanation is refused too). */
  private readonly off = signal(false);
  protected readonly visible = computed(
    () =>
      this.flags.isOn('clerk.enabled') &&
      this.flags.isOn('clerk.features.insightsNarrative') &&
      this.canUse() &&
      !this.off(),
  );

  protected readonly narrative = signal<InsightsNarrativeView | null>(null);
  protected readonly problem = signal<string | null>(null);
  protected readonly busy = signal<Busy>(null);
  protected readonly announcement = signal('');
  private readonly now = signal(Date.now());
  protected readonly canRefresh = computed(() => {
    const n = this.narrative();
    return !!n && Date.parse(n.refreshAfter) <= this.now();
  });
  /** The latest call; an answer to an earlier one (a selection since changed) is dropped. */
  private seq = 0;

  constructor() {
    // Each selection: the explanation kept for it, if any.
    effect(() => {
      const selection = this.selection();
      if (!this.visible()) return;
      untracked(() => void this.load(selection));
    });
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected written(n: InsightsNarrativeView): string {
    return writtenFormat.format(new Date(n.generatedAt));
  }

  /** " (August 2026)" on a comparison period's chip. */
  protected periodOf(citation: ShownCitation, n: InsightsNarrativeView): string {
    return citation.period === 'comparison' && n.comparisonLabel ? ` (${n.comparisonLabel})` : '';
  }

  protected chipText(citation: ShownCitation, n: InsightsNarrativeView): string {
    const period = citation.period === 'comparison' ? n.comparisonLabel : n.periodLabel;
    return `${citation.label}: ${citation.value}${period ? `, ${period}` : ''}`;
  }

  protected async run(mode: 'explain' | 'refresh'): Promise<void> {
    const seq = ++this.seq;
    this.busy.set(mode);
    this.problem.set(null);
    this.announcement.set('Clerk is explaining the figures…');
    try {
      const result = await this.api.explain({ ...this.input(), mode });
      if (seq !== this.seq) return;
      this.show(result);
      this.announcement.set(result.problem ? (this.problem() ?? '') : 'Clerk’s explanation is ready.');
    } catch (error) {
      if (seq !== this.seq) return;
      this.problem.set(errorCopy(error));
      this.announcement.set('');
    } finally {
      if (seq === this.seq) this.busy.set(null);
    }
  }

  private async load(selection: NarrativeSelection): Promise<void> {
    const seq = ++this.seq;
    this.narrative.set(null);
    this.problem.set(null);
    this.busy.set(null);
    try {
      const result = await this.api.explain({ ...this.inputOf(selection), mode: 'cached' });
      if (seq === this.seq) this.show(result);
    } catch (error) {
      if (seq !== this.seq) return;
      // Turned off by the practice (or on Materia's side): no card. Anything else: Explain still works.
      if (errorCodeOf(error) === 'CLERK_DISABLED') this.off.set(true);
    }
  }

  private show(result: ExplainInsightsResult): void {
    if (result.narrative || !result.problem) this.narrative.set(result.narrative);
    this.problem.set(result.problem ? PROBLEM_COPY[result.problem] : null);
    this.now.set(Date.now());
  }

  private input() {
    return this.inputOf(this.selection());
  }

  private inputOf(selection: NarrativeSelection) {
    return {
      range: selection.range,
      compare: selection.compare,
      ...(selection.range === 'custom' && selection.from ? { from: selection.from } : {}),
      ...(selection.range === 'custom' && selection.to ? { to: selection.to } : {}),
    };
  }
}
