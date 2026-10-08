import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import { DISCLOSURE_WAIVER_REASON_LABELS, type DisclosureWaiverReason, type FeeArrangement } from '@materia/domain';
import { MtBadge, MtCheckbox, MtRadioGroup, MtSelect, MtTextField, MtTextarea, type MtOption } from '@materia/ui';

import { costsDisclosureFor, FEE_ARRANGEMENT_OPTIONS } from './intake-state';
import { IntakeStore } from './intake-store';

const WAIVER_REASONS: MtOption<DisclosureWaiverReason>[] = (
  Object.entries(DISCLOSURE_WAIVER_REASON_LABELS) as [DisclosureWaiverReason, string][]
).map(([value, label]) => ({ value, label }));

/**
 * Step 5: the fee arrangement (amount, estimate, cap, a rate override, a conditional uplift) and
 * the costs disclosure it implies under the jurisdiction's rules (BILL-06), marked illustrative
 * where a practitioner hasn't signed the rules off (VIC's are, BILL-06a). Lawyers and above can
 * record that no disclosure is needed, with the reason.
 */
@Component({
  selector: 'mt-intake-fees-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, MtBadge, MtCheckbox, MtRadioGroup, MtSelect, MtTextField, MtTextarea],
  template: `
    @let f = store.state().fees;
    <section class="mt-col block" aria-labelledby="intake-fees-h">
      <h2 id="intake-fees-h" class="heading">Fee arrangement</h2>
      <mt-radio-group
        label="Arrangement"
        orientation="horizontal"
        [options]="arrangements"
        [ngModel]="f.arrangement"
        (ngModelChange)="arrangement($event)"
      />
      <div class="grid">
        @if (f.arrangement === 'fixed') {
          <ng-container *ngTemplateOutlet="money; context: { field: 'amount', label: 'Fixed fee', optional: false }" />
        }
        @if (f.arrangement === 'capped') {
          <ng-container *ngTemplateOutlet="money; context: { field: 'cap', label: 'Cap', optional: false }" />
        }
        @if (f.arrangement !== 'pro_bono') {
          <ng-container
            *ngTemplateOutlet="money; context: { field: 'estimate', label: 'Estimate of total costs', optional: true }"
          />
        }
        @if (f.arrangement === 'hourly' || f.arrangement === 'capped' || f.arrangement === 'conditional') {
          <ng-container
            *ngTemplateOutlet="
              money;
              context: {
                field: 'rateOverride',
                label: 'Hourly rate override',
                optional: true,
                description: 'Replaces the responsible lawyer’s rate on this matter.',
              }
            "
          />
        }
        @if (f.arrangement === 'conditional') {
          <mt-text-field
            label="Uplift"
            suffix="%"
            inputmode="decimal"
            autocomplete="off"
            description="At most 25%."
            [error]="store.error('upliftPct') ?? store.error('conditional')"
            [ngModel]="f.upliftPct"
            (ngModelChange)="store.fees({ upliftPct: $event ?? '' })"
          />
        }
      </div>
      @if (f.arrangement === 'conditional') {
        <mt-textarea
          label="Condition"
          description="What the client must achieve for the fee to be payable."
          [rows]="2"
          [error]="store.error('condition')"
          [ngModel]="f.condition"
          (ngModelChange)="store.fees({ condition: $event ?? '' })"
        />
      }
      @if (f.arrangement === 'pro_bono') {
        <p class="caption t-2">No fees are charged on a pro bono matter.</p>
      }
    </section>

    <section class="mt-col block disclosure" aria-labelledby="intake-disclosure-h" data-testid="costs-disclosure">
      <div class="mt-row" style="gap: var(--space-8); align-items: center">
        <h2 id="intake-disclosure-h" class="heading">Costs disclosure</h2>
        @if (disclosure()?.illustrative) {
          <mt-badge tone="warning">Illustrative</mt-badge>
        }
      </div>
      @if (disclosure(); as d) {
        <p class="label" aria-live="polite" data-testid="disclosure-need">{{ d.text }}</p>
      }
      @if (canWaive() || f.waived) {
        <mt-checkbox
          label="No disclosure is needed (an exception applies)"
          [disabled]="!canWaive()"
          [ngModel]="f.waived"
          (ngModelChange)="store.fees({ waived: !!$event })"
        />
        @if (f.waived) {
          <div class="grid">
            <mt-select
              label="Why no disclosure is needed"
              [native]="true"
              [options]="waiverReasons"
              placeholder="Choose a reason"
              [error]="store.error('waiver.reason')"
              [ngModel]="f.waiverReason || null"
              (ngModelChange)="store.fees({ waiverReason: $event ?? '' })"
            />
            <mt-text-field
              label="Note"
              [optional]="f.waiverReason !== 'other'"
              autocomplete="off"
              [error]="store.error('waiver.note')"
              [ngModel]="f.waiverNote"
              (ngModelChange)="store.fees({ waiverNote: $event ?? '' })"
            />
          </div>
        }
      }
      <p class="caption t-3">
        Worked out from the estimate (the top of a range) under the {{ jurisdiction }} disclosure rules.
        @if (disclosure()?.illustrative) {
          The rules are illustrative until a practitioner reviews them: this is not legal advice.
        }
      </p>
    </section>

    <ng-template #money let-field="field" let-label="label" let-optional="optional" let-description="description">
      <mt-text-field
        [label]="label"
        [optional]="optional"
        [description]="description"
        inputmode="decimal"
        autocomplete="off"
        placeholder="0.00"
        [iconStart]="'billing'"
        [error]="store.error(field)"
        [ngModel]="$any(store.state().fees)[field]"
        (ngModelChange)="setMoney(field, $event)"
      />
    </ng-template>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-24);
    }
    .block {
      gap: var(--space-12);
    }
    .block h2,
    .block p {
      margin: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-12);
      align-items: start;
    }
    .disclosure {
      padding: var(--space-16);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      background: var(--bg-canvas);
    }
  `,
})
export class IntakeFeesStep {
  protected readonly store = inject(IntakeStore);
  protected readonly arrangements = FEE_ARRANGEMENT_OPTIONS;
  protected readonly waiverReasons = WAIVER_REASONS;
  /** Recording that no disclosure is needed is for lawyers and above (the server checks too). */
  protected readonly canWaive = can('matter.fee');
  /** New matters are Victorian for now (the type step). */
  protected readonly jurisdiction = 'VIC';

  protected readonly disclosure = computed(() => costsDisclosureFor(this.store.state().fees, this.jurisdiction));

  protected setMoney(field: 'amount' | 'estimate' | 'cap' | 'rateOverride', value: string | null): void {
    this.store.fees({ [field]: value ?? '' });
  }

  protected arrangement(value: FeeArrangement | null): void {
    if (value) this.store.fees({ arrangement: value });
  }
}
