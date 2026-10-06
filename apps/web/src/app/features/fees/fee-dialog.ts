import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { feeCallables } from '@materia/data-access/repository';
import type { FeeArrangement, FeeTerms, UpdateFeeResult } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtNote, MtSelect, MtTextarea, MtTextField } from '@materia/ui';

import { feeFieldsFor, feeFormOf, feeFromForm, type FeeForm } from './fee-form';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FEE_ARRANGEMENT_OPTIONS } from '../intake/intake-state';

export interface FeeDialogData {
  matterId: string;
  /** The matter's number, for the title. */
  number: string;
  fee: Partial<FeeTerms> | undefined;
  /** Some time or disbursements are already billed: the change applies from now on. */
  billed: boolean;
}

const MONEY_LABELS = {
  amount: { label: 'Fixed fee', description: undefined },
  cap: { label: 'Cap', description: 'Recorded value over the cap is not billed.' },
  estimate: { label: 'Estimate', description: 'The single figure given to the client, if any.' },
  estimateLow: { label: 'Estimate from', description: undefined },
  estimateHigh: { label: 'Estimate to', description: 'The budget is measured against this.' },
  rateOverride: { label: 'Hourly rate override', description: 'Replaces the responsible lawyer’s rate.' },
} as const;

/**
 * "Edit fee arrangement" (BILL-05; lawyer and above): the arrangement, its amounts and the
 * estimate range, with a required reason. Saves through `fees-update` itself, so problems show in
 * place; closes with the result, or `undefined` when cancelled.
 */
@Component({
  selector: 'mt-fee-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSelect, MtTextarea, MtTextField],
  template: `
    @let f = form();
    @let e = shownErrors();
    <mt-dialog
      size="md"
      [title]="'Fee arrangement for ' + data.number"
      description="A revision applies from now on and re-arms the budget alerts."
    >
      <form id="mt-fee-form" class="mt-col" style="gap: var(--space-16)" (submit)="$event.preventDefault(); save()">
        <mt-select
          label="Arrangement"
          name="arrangement"
          [native]="true"
          [options]="arrangements"
          [ngModel]="f.arrangement"
          (ngModelChange)="setArrangement($event)"
        />
        @if (f.arrangement === 'pro_bono') {
          <p class="caption t-2" style="margin: 0">
            No fees are charged. Recorded time is still tracked for reporting, with no budget alerts.
          </p>
        } @else {
          <div class="grid">
            @for (field of fields(); track field) {
              <mt-text-field
                [name]="field"
                [label]="labels[field].label"
                [description]="labels[field].description"
                [optional]="field !== 'amount' && field !== 'cap'"
                inputmode="decimal"
                autocomplete="off"
                placeholder="0.00"
                iconStart="billing"
                [error]="e[field]"
                [ngModel]="f[field]"
                (ngModelChange)="setField(field, $event)"
              />
            }
            @if (f.arrangement === 'conditional') {
              <mt-text-field
                name="upliftPct"
                label="Uplift"
                suffix="%"
                inputmode="decimal"
                autocomplete="off"
                description="At most 25%."
                [error]="e.upliftPct"
                [ngModel]="f.upliftPct"
                (ngModelChange)="set({ upliftPct: $event ?? '' })"
              />
            }
          </div>
          @if (f.arrangement === 'conditional') {
            <mt-textarea
              name="condition"
              label="Success means"
              description="What the client must achieve for the fee to be payable."
              [rows]="2"
              [error]="e.condition"
              [ngModel]="f.condition"
              (ngModelChange)="set({ condition: $event ?? '' })"
            />
          }
        }
        <mt-textarea
          name="reason"
          label="Reason for the change"
          description="Kept in the matter’s fee history. A revised estimate may need an updated costs disclosure."
          [rows]="2"
          [error]="e.reason"
          [ngModel]="f.reason"
          (ngModelChange)="set({ reason: $event ?? '' })"
        />
        @if (data.billed) {
          <mt-note tone="info">Some work is already billed. Invoices already issued are not changed.</mt-note>
        }
        @if (failure(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="cancel()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-fee-form" [loading]="saving()">Save fee</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--space-12);
      align-items: start;
    }
  `,
})
export class FeeDialog {
  private readonly ref = injectDialogRef<FeeDialogData, UpdateFeeResult | undefined>();
  private readonly api = feeCallables(inject(CALLABLES));
  protected readonly data = this.ref.data;
  protected readonly arrangements = FEE_ARRANGEMENT_OPTIONS;
  protected readonly labels = MONEY_LABELS;

  protected readonly form = signal<FeeForm>(feeFormOf(this.data.fee));
  protected readonly fields = computed(() => feeFieldsFor(this.form().arrangement));
  private readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly failure = signal<string | null>(null);
  private readonly result = computed(() => feeFromForm(this.form()));
  /** Problems show once the person has tried to save. */
  protected readonly shownErrors = computed(() => (this.submitted() ? this.result().errors : {}));

  protected set(patch: Partial<FeeForm>): void {
    this.form.update((form) => ({ ...form, ...patch }));
  }

  protected setField(field: keyof FeeForm, value: string | null): void {
    this.set({ [field]: value ?? '' });
  }

  protected setArrangement(arrangement: FeeArrangement | null): void {
    if (arrangement) this.set({ arrangement });
  }

  protected cancel(): void {
    void this.ref.close(undefined);
  }

  protected async save(): Promise<void> {
    this.submitted.set(true);
    const { fee, reason } = this.result();
    if (!fee || !reason || this.saving()) return;
    this.saving.set(true);
    this.failure.set(null);
    try {
      const result = await this.api.update({ matterId: this.data.matterId, fee, reason });
      void this.ref.close(result);
    } catch (error) {
      this.failure.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}
