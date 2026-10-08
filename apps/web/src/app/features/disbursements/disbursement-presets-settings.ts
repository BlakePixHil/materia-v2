import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { disbursementPresetsRepository } from '@materia/data-access/repository';
import {
  DISBURSEMENT_PRESETS_DOC,
  DISBURSEMENT_PRESETS_MAX,
  DisbursementPresetsSchema,
  presetId,
  presetsOrDefault,
  type DisbursementCategory,
  type DisbursementPreset,
  type GstTreatment,
} from '@materia/domain';
import { MtButton, MtIconButton, MtNote, MtSelect, MtSettingsSection, MtTextField, ToastService } from '@materia/ui';

import { DISBURSEMENT_CATEGORY_OPTIONS, GST_TREATMENT_OPTIONS } from './disbursements-view';
import { errorCopy } from '../../core/error-copy';
import { dollarsText, parseDollars } from '../settings/money';

interface PresetRow {
  id: string;
  label: string;
  category: DisbursementCategory;
  gstTreatment: GstTreatment;
  payee: string;
  amount: string;
}

const rowOf = (preset: DisbursementPreset): PresetRow => ({
  id: preset.id,
  label: preset.label,
  category: preset.category,
  gstTreatment: preset.gstTreatment,
  payee: preset.payee ?? '',
  amount: dollarsText(preset.defaultAmountCents),
});

/** The presets the rows describe, or the first problem in words. */
function presetsOf(rows: readonly PresetRow[]): { value?: DisbursementPreset[]; problem?: string } {
  const value: DisbursementPreset[] = [];
  for (const row of rows) {
    const label = row.label.trim();
    if (!label) return { problem: 'Every preset needs a name.' };
    const amount = parseDollars(row.amount);
    if (amount === undefined || amount === 0)
      return { problem: `Enter the amount for “${label}” in dollars, or leave it blank.` };
    const payee = row.payee.trim();
    value.push({
      id: row.id,
      label,
      category: row.category,
      gstTreatment: row.gstTreatment,
      ...(payee ? { payee } : {}),
      ...(amount !== null ? { defaultAmountCents: amount } : {}),
    });
  }
  const parsed = DisbursementPresetsSchema.safeParse(value);
  return parsed.success ? { value: parsed.data } : { problem: parsed.error.issues[0]?.message ?? 'Check the presets.' };
}

/**
 * Settings → Billing and rates → Disbursement presets (BILL-04; owners and admins, while
 * `billing.disbursements` is on): the common W&E outlays that prefill a new disbursement. Until the
 * org saves its own, the starting presets show (signed off in BILL-04a; amounts blank because fees
 * change each financial year). Saved client-direct to
 * `orgs/{orgId}/settings/disbursementPresets`; the audit trigger records the change.
 */
@Component({
  selector: 'mt-disbursement-presets-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtIconButton, MtNote, MtSelect, MtSettingsSection, MtTextField],
  host: { class: 'mt-col', style: 'gap: 12px' },
  template: `
    <mt-settings-section
      title="Disbursement presets"
      description="Common outlays that prefill a new disbursement on a matter's Time tab. The amount is always editable, so leave it blank for fees that change each year."
      [headingLevel]="2"
    >
      <form class="presets" (submit)="$event.preventDefault(); save()" aria-label="Disbursement presets">
        @for (row of rows(); track row.id; let i = $index) {
          <div class="preset" role="group" [attr.aria-label]="row.label || 'New preset'">
            <mt-text-field
              [name]="'label-' + i"
              label="Name"
              size="sm"
              [ngModel]="row.label"
              (ngModelChange)="patch(i, { label: $event ?? '' })"
            />
            <mt-select
              [name]="'category-' + i"
              label="Category"
              size="sm"
              [native]="true"
              [options]="categoryOptions"
              [ngModel]="row.category"
              (ngModelChange)="patch(i, { category: $event ?? 'other' })"
            />
            <mt-select
              [name]="'gst-' + i"
              label="GST"
              size="sm"
              [native]="true"
              [options]="treatmentOptions"
              [ngModel]="row.gstTreatment"
              (ngModelChange)="patch(i, { gstTreatment: $event ?? 'taxable' })"
            />
            <mt-text-field
              [name]="'payee-' + i"
              label="Paid to"
              size="sm"
              [optional]="true"
              [ngModel]="row.payee"
              (ngModelChange)="patch(i, { payee: $event ?? '' })"
            />
            <mt-text-field
              [name]="'amount-' + i"
              label="Amount ex GST"
              size="sm"
              inputmode="decimal"
              [optional]="true"
              [ngModel]="row.amount"
              (ngModelChange)="patch(i, { amount: $event ?? '' })"
            />
            <button
              mtIconButton
              type="button"
              icon="trash"
              size="sm"
              [label]="'Remove ' + (row.label || 'this preset')"
              (click)="removeRow(i)"
            ></button>
          </div>
        } @empty {
          <p class="caption t-3" style="margin: 0">No presets. New disbursements start blank.</p>
        }
        @if (problem(); as text) {
          <mt-note tone="danger" role="alert">{{ text }}</mt-note>
        }
        <div class="mt-row" style="gap: 8px; flex-wrap: wrap">
          <button
            mtButton
            variant="secondary"
            size="sm"
            type="button"
            iconStart="plus"
            [disabled]="rows().length >= max"
            (click)="addRow()"
          >
            Add preset
          </button>
          <span class="mt-ml mt-row" style="gap: 8px">
            <button mtButton variant="ghost" size="sm" type="button" [disabled]="!unsaved()" (click)="reset()">
              Discard changes
            </button>
            <button mtButton variant="primary" size="sm" type="submit" [loading]="saving()" [disabled]="!unsaved()">
              Save presets
            </button>
          </span>
        </div>
      </form>
    </mt-settings-section>
  `,
  styles: `
    .presets {
      display: flex;
      flex-direction: column;
      gap: var(--space-12, 12px);
      container-type: inline-size;
    }
    .preset {
      display: grid;
      grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1.2fr)) minmax(0, 1fr) auto;
      gap: var(--space-8, 8px);
      align-items: end;
    }
    /* Six fields fit on one line only on a wide settings column; otherwise two per line. */
    @container (max-width: 880px) {
      .preset {
        grid-template-columns: 1fr 1fr;
        padding-bottom: var(--space-12, 12px);
        border-bottom: 1px solid var(--border-subtle);
      }
    }
  `,
})
export class DisbursementPresetsSettings {
  private readonly repo = disbursementPresetsRepository();
  private readonly toasts = inject(ToastService);
  private readonly doc = this.repo.watch(DISBURSEMENT_PRESETS_DOC);

  protected readonly max = DISBURSEMENT_PRESETS_MAX;
  protected readonly categoryOptions = DISBURSEMENT_CATEGORY_OPTIONS;
  protected readonly treatmentOptions = GST_TREATMENT_OPTIONS;

  private readonly saved = computed(() => presetsOrDefault(this.doc.value()).map(rowOf));
  protected readonly rows = signal<PresetRow[]>([]);
  protected readonly problem = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly unsaved = computed(() => JSON.stringify(this.rows()) !== JSON.stringify(this.saved()));

  constructor() {
    // Follow the stored presets until the admin starts editing.
    effect(() => {
      const saved = this.saved();
      if (this.doc.status() === 'loading') return;
      untracked(() => {
        if (!this.saving()) this.rows.set(saved);
      });
    });
  }

  protected patch(index: number, change: Partial<PresetRow>): void {
    this.rows.update((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
    this.problem.set(null);
  }

  protected addRow(): void {
    const id = presetId(
      'preset',
      this.rows().map((row) => row.id),
    );
    this.rows.update((rows) => [
      ...rows,
      { id, label: '', category: 'other', gstTreatment: 'taxable', payee: '', amount: '' },
    ]);
  }

  protected removeRow(index: number): void {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
    this.problem.set(null);
  }

  protected reset(): void {
    this.rows.set(this.saved());
    this.problem.set(null);
  }

  protected async save(): Promise<void> {
    const { value, problem } = presetsOf(this.rows());
    this.problem.set(problem ?? null);
    if (!value) return;
    this.saving.set(true);
    try {
      if (this.doc.exists() && this.doc.value()) await this.repo.update(DISBURSEMENT_PRESETS_DOC, { presets: value });
      else await this.repo.create({ presets: value }, { id: DISBURSEMENT_PRESETS_DOC });
      this.toasts.show({ title: 'Presets saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The presets didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
