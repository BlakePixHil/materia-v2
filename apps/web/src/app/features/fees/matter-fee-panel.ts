import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';

import { can } from '@materia/data-access';
import {
  budgetPct,
  capExcessCents,
  DEFAULT_BUDGET_ALERT_PCTS,
  FEE_ARRANGEMENT_LABELS,
  feeBasisCents,
  feeChanges,
  feeEstimateText,
  type FeeRevision,
  type UpdateFeeResult,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  formatDateOnly,
  MtButton,
  MtMeter,
  ToastService,
  type MtDateInput,
} from '@materia/ui';

import type { FeeDialogData } from './fee-dialog';
import { MatterScreen } from '../matter-detail/matter-screen';

const BASIS_LABEL = { fixed: 'fixed fee', capped: 'cap', hourly: 'estimate', conditional: 'estimate' } as const;

/**
 * The fee panel on a matter's Overview (BILL-05, flag `billing.feeBudgets`; `billing.view` roles):
 * the arrangement and its terms, a Meter of recorded value (all time at its rate plus
 * disbursements) against the fixed fee, cap or estimate, and the revision history. Lawyers and
 * above revise the fee through "Edit fee arrangement". The budget figures come from the matter
 * (`fees-budgetOn*` keep them); the basis is worked out from the fee too, so the Meter moves as
 * soon as a revision saves.
 */
@Component({
  selector: 'mt-matter-fee-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtMeter],
  host: { class: 'mt-matter-fee-panel' },
  template: `
    @let m = screen.value();
    <section class="mt-card" data-pad aria-labelledby="mt-ov-fee" data-testid="fee-panel">
      <div class="mt-card-h">
        <h2 class="mt-card-title" id="mt-ov-fee">Fees and budget</h2>
        @if (canRevise() && screen.editable()) {
          <button mtButton class="mt-ml" variant="ghost" size="sm" type="button" (click)="edit()">
            Edit fee arrangement
          </button>
        }
      </div>
      @if (fee(); as fee) {
        <dl class="terms">
          <div>
            <dt>Arrangement</dt>
            <dd data-testid="fee-arrangement">{{ arrangementLabel() }}</dd>
          </div>
          @for (term of terms(); track term.label) {
            <div>
              <dt>{{ term.label }}</dt>
              <dd>{{ term.value }}</dd>
            </div>
          }
        </dl>
        @if (basis() !== undefined) {
          <div class="budget">
            <mt-meter
              [value]="recorded()"
              [max]="basis() || 1"
              [tone]="warn() ? 'warning' : 'brand'"
              [label]="'Budget used against the ' + basisLabel()"
            />
            <p class="caption t-2 figures" data-testid="budget-figures">
              {{ money(recorded()) }} recorded of {{ money(basis()) }} {{ basisLabel() }}
              <strong>· {{ pct() }}%</strong>
            </p>
            @if (overBy(); as over) {
              <p class="caption over">
                @if (fee.arrangement === 'capped') {
                  {{ money(over) }} over the cap. It won’t be billed.
                } @else {
                  {{ money(over) }} over the {{ basisLabel() }}. Consider revising it and updating the costs disclosure.
                }
              </p>
            }
          </div>
        } @else {
          <p class="caption t-3 none" data-testid="budget-figures">
            {{ money(recorded()) }} recorded.
            @if (fee.arrangement === 'pro_bono') {
              Pro bono: no budget alerts.
            } @else {
              No estimate, so there’s no budget to track.
            }
          </p>
        }
        @if (billed()) {
          <p class="caption t-3 none">{{ money(billed()) }} billed so far.</p>
        }
        @if (history().length) {
          <details class="history">
            <summary class="caption">Revision history ({{ history().length }})</summary>
            <ol>
              @for (rev of history(); track $index) {
                <li>
                  <p class="caption t-3 who">{{ when(rev.at) }} · {{ screen.memberName(rev.by) }}</p>
                  @if (rev.reason) {
                    <p class="reason">{{ rev.reason }}</p>
                  }
                  @for (line of changes(rev); track line) {
                    <p class="caption t-2">{{ line }}</p>
                  }
                </li>
              }
            </ol>
          </details>
        }
      } @else if (m) {
        <p class="caption t-3 none">No fee arrangement recorded.</p>
      }
    </section>
  `,
  styles: `
    .mt-matter-fee-panel {
      display: block;
    }
    .mt-matter-fee-panel h2,
    .mt-matter-fee-panel p {
      margin: 0;
    }
    .mt-matter-fee-panel .terms {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--space-8) var(--space-16);
      margin: 0 0 var(--space-12);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-matter-fee-panel dt {
      color: var(--text-tertiary);
      font-size: 12px;
    }
    .mt-matter-fee-panel dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .mt-matter-fee-panel .budget {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-matter-fee-panel .over {
      color: var(--text-warning, var(--text-secondary));
    }
    .mt-matter-fee-panel .none {
      margin-top: var(--space-4);
    }
    .mt-matter-fee-panel .history {
      margin-top: var(--space-12);
    }
    .mt-matter-fee-panel .history summary {
      cursor: pointer;
    }
    .mt-matter-fee-panel .history ol {
      list-style: none;
      margin: var(--space-8) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-matter-fee-panel .history li + li {
      padding-top: var(--space-12);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-matter-fee-panel .reason {
      font: 400 13px/18px var(--font-sans);
    }
  `,
})
export class MatterFeePanel {
  protected readonly screen = inject(MatterScreen);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  protected readonly canRevise = can('matter.fee');

  protected readonly fee = computed(() => this.screen.value()?.fee);
  private readonly budget = computed(() => this.screen.value()?.budget);
  protected readonly arrangementLabel = computed(() => {
    const fee = this.fee();
    return fee ? FEE_ARRANGEMENT_LABELS[fee.arrangement] : '';
  });
  protected readonly terms = computed(() => {
    const fee = this.fee();
    if (!fee) return [];
    const terms: { label: string; value: string }[] = [];
    if (fee.amountCents !== undefined) terms.push({ label: 'Fixed fee', value: formatAud(fee.amountCents) });
    if (fee.capCents !== undefined) terms.push({ label: 'Cap', value: formatAud(fee.capCents) });
    const estimate = feeEstimateText(fee);
    if (estimate) terms.push({ label: 'Estimate', value: estimate });
    if (fee.rateOverrideCents !== undefined) {
      terms.push({ label: 'Hourly rate', value: `${formatAud(fee.rateOverrideCents)} / h` });
    }
    if (fee.conditional) {
      terms.push({ label: 'Uplift', value: `${fee.conditional.upliftPct}%` });
      terms.push({ label: 'Success means', value: fee.conditional.condition });
    }
    return terms;
  });
  protected readonly recorded = computed(() => this.budget()?.recordedCents ?? 0);
  protected readonly billed = computed(() => this.budget()?.billedCents ?? 0);
  /** From the fee itself, so a revision shows before the budget is recomputed. */
  protected readonly basis = computed(() => feeBasisCents(this.fee()));
  protected readonly pct = computed(() => budgetPct(this.recorded(), this.basis()) ?? 0);
  protected readonly warn = computed(() => this.pct() >= (DEFAULT_BUDGET_ALERT_PCTS[0] ?? 80));
  protected readonly basisLabel = computed(() => {
    const arrangement = this.fee()?.arrangement;
    return arrangement && arrangement !== 'pro_bono' ? BASIS_LABEL[arrangement] : 'estimate';
  });
  protected readonly overBy = computed(() => {
    const basis = this.basis();
    if (basis === undefined) return 0;
    const fee = this.fee();
    return fee?.arrangement === 'capped' ? capExcessCents(fee, this.recorded()) : Math.max(0, this.recorded() - basis);
  });
  /** Newest first. */
  protected readonly history = computed(() => [...(this.fee()?.history ?? [])].reverse() as FeeRevision[]);

  protected money(value: number | undefined): string {
    return formatAud(value);
  }

  protected when(value: unknown): string {
    return formatDateOnly(value as MtDateInput);
  }

  protected changes(rev: FeeRevision): string[] {
    return rev.to ? feeChanges(rev.from, rev.to) : rev.change ? [rev.change] : [];
  }

  protected async edit(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    const { FeeDialog } = await import('./fee-dialog');
    const result = await this.dialogs.open<FeeDialogData, UpdateFeeResult | undefined>(FeeDialog, {
      data: { matterId: matter.id, number: matter.number, fee: matter.fee, billed: this.billed() > 0 },
    }).result;
    if (!result) return;
    this.toasts.show({
      title: result.changed ? 'Fee arrangement saved' : 'The fee arrangement is unchanged',
      tone: result.changed ? 'success' : 'neutral',
    });
  }
}
