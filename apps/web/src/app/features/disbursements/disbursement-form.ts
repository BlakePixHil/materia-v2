import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { DisbursementItem } from '@materia/data-access/repository';
import {
  disbursementAmountProblem,
  type DateOnly,
  type DisbursementCategory,
  type DisbursementPreset,
  type GstTreatment,
} from '@materia/domain';
import { MT_TODAY, MtButton, MtSegmentedControl, MtSelect, MtTextField, type MtOption } from '@materia/ui';

import {
  AMOUNT_ENTRY_OPTIONS,
  amountPreview,
  DISBURSEMENT_CATEGORY_OPTIONS,
  enteredAmounts,
  GST_TREATMENT_OPTIONS,
  rememberAmountEntry,
  storedAmountEntry,
  type AmountEntry,
} from './disbursements-view';
import { DocumentUploads } from '../documents/document-uploads';
import { UPLOAD_ACCEPT } from '../documents/documents-view';
import { dollarsText, parseDollars } from '../settings/money';
import { formatEntryDate, parseEntryDate } from '../time/time-view';

/** What the form saves: the fields a disbursement stores, with the client's preview amounts. */
export type DisbursementFormValue = {
  date: DateOnly;
  description: string;
  payee: string;
  category: DisbursementCategory;
  presetId: string | null;
  gstTreatment: GstTreatment;
  amountExGstCents: number;
  gstCents: number;
  amountIncGstCents: number | null;
  receiptDocumentId: string | null;
};

/** A document that can be the receipt. */
export interface ReceiptOption {
  id: string;
  name: string;
}

const NO_PRESET = '';
const NO_RECEIPT = '';

/**
 * The disbursement form (BILL-04): a preset (it only prefills: the amount stays editable), date,
 * description, payee, GST treatment, the amount paid in AUD (entered including or excluding GST;
 * the choice is remembered) with a live ex GST / GST / total preview, and the receipt, picked from
 * the matter's documents or uploaded here (CORE-12; Save waits until the upload is a document).
 */
@Component({
  selector: 'mt-disbursement-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, MtButton, MtSegmentedControl, MtSelect, MtTextField],
  host: { class: 'mt-disbursement-form', '(keydown.escape)': 'onEscape($event)' },
  template: `
    <form class="fields" [attr.aria-label]="formLabel()" (submit)="$event.preventDefault(); save()">
      @if (presetOptions().length > 1) {
        <mt-select
          class="preset"
          name="preset"
          label="Preset"
          size="sm"
          [native]="true"
          [options]="presetOptions()"
          [ngModel]="presetId()"
          (ngModelChange)="applyPreset($event ?? NO_PRESET)"
        />
      }
      <mt-text-field
        class="date"
        name="date"
        label="Date paid"
        size="sm"
        placeholder="DD/MM/YYYY"
        [error]="dateError() ?? undefined"
        [ngModel]="dateText()"
        (ngModelChange)="dateText.set($event ?? ''); dateError.set(null)"
      />
      <mt-text-field
        #descriptionField
        class="description"
        name="description"
        label="Description"
        size="sm"
        [error]="descriptionError() ?? undefined"
        [ngModel]="description()"
        (ngModelChange)="description.set($event ?? ''); descriptionError.set(null)"
      />
      <mt-text-field
        class="payee"
        name="payee"
        label="Paid to"
        size="sm"
        [optional]="true"
        [ngModel]="payee()"
        (ngModelChange)="payee.set($event ?? '')"
      />
      <mt-select
        class="category"
        name="category"
        label="Category"
        size="sm"
        [native]="true"
        [options]="categoryOptions"
        [ngModel]="category()"
        (ngModelChange)="category.set($event ?? 'other')"
      />
      <mt-select
        class="treatment"
        name="gstTreatment"
        label="GST"
        size="sm"
        [native]="true"
        [options]="treatmentOptions"
        [ngModel]="gstTreatment()"
        (ngModelChange)="gstTreatment.set($event ?? 'taxable')"
      />
      <div class="amount">
        <mt-text-field
          name="amount"
          label="Amount paid (AUD)"
          size="sm"
          inputmode="decimal"
          placeholder="0.00"
          description="For a foreign-currency receipt, enter what was paid in dollars."
          [error]="amountError() ?? undefined"
          [ngModel]="amountText()"
          (ngModelChange)="amountText.set($event ?? ''); amountError.set(null)"
        />
        <mt-segmented-control
          name="entry"
          label="The amount"
          [options]="entryOptions"
          [ngModel]="entry()"
          (ngModelChange)="setEntry($event)"
        />
      </div>
      <div class="receipt">
        <mt-select
          name="receipt"
          label="Receipt"
          size="sm"
          [native]="true"
          [options]="receiptOptions()"
          [ngModel]="receiptId()"
          (ngModelChange)="receiptId.set($event ?? NO_RECEIPT)"
        />
        @if (canUpload()) {
          <input #picker type="file" hidden [accept]="accept" (change)="upload($event)" data-testid="receipt-file" />
          <button
            mtButton
            variant="secondary"
            size="sm"
            type="button"
            iconStart="upload"
            [loading]="uploading()"
            (click)="picker.click()"
          >
            Upload receipt
          </button>
        }
      </div>
      <p class="preview caption t-3" aria-live="polite" data-testid="disbursement-preview">{{ preview() }}</p>
      @if (uploadNote(); as note) {
        <p class="caption t-3 note" role="status">{{ note }}</p>
      }
      <span class="actions">
        <button mtButton variant="ghost" size="sm" type="button" (click)="cancelled.emit()">Cancel</button>
        <button mtButton variant="primary" size="sm" type="submit" [loading]="saving()" [disabled]="uploading()">
          {{ submitLabel() }}
        </button>
      </span>
    </form>
  `,
  styles: `
    .mt-disbursement-form .fields {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-8) var(--space-12);
      align-items: start;
    }
    .mt-disbursement-form .preset,
    .mt-disbursement-form .description {
      grid-column: span 2;
    }
    .mt-disbursement-form .amount,
    .mt-disbursement-form .receipt {
      display: flex;
      gap: var(--space-8);
      align-items: end;
      grid-column: span 2;
    }
    .mt-disbursement-form .amount > .mt-text-field,
    .mt-disbursement-form .receipt > .mt-select {
      flex: 1;
      min-width: 0;
    }
    .mt-disbursement-form .amount > .mt-segmented-control {
      margin-bottom: 22px;
    }
    .mt-disbursement-form .preview,
    .mt-disbursement-form .note {
      grid-column: 1 / 3;
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .mt-disbursement-form .actions {
      grid-column: 3 / -1;
      display: flex;
      gap: var(--space-8);
      justify-content: flex-end;
    }
    @media (max-width: 900px) {
      .mt-disbursement-form .fields {
        grid-template-columns: 1fr 1fr;
      }
      .mt-disbursement-form .amount,
      .mt-disbursement-form .receipt,
      .mt-disbursement-form .preview,
      .mt-disbursement-form .note,
      .mt-disbursement-form .actions {
        grid-column: 1 / -1;
      }
      .mt-disbursement-form .amount,
      .mt-disbursement-form .receipt {
        flex-wrap: wrap;
      }
    }
  `,
})
export class DisbursementForm {
  readonly matterId = input.required<string>();
  /** The disbursement being edited; a new one when absent. */
  readonly initial = input<DisbursementItem | null>(null);
  readonly presets = input<readonly DisbursementPreset[]>([]);
  /** The matter's documents (newest first), for the receipt. */
  readonly documents = input<readonly ReceiptOption[]>([]);
  readonly canUpload = input(false);
  readonly saving = input(false);
  readonly submitLabel = input('Add disbursement');
  readonly formLabel = input('Record a disbursement');
  readonly saved = output<DisbursementFormValue>();
  readonly cancelled = output();

  protected readonly NO_PRESET = NO_PRESET;
  protected readonly NO_RECEIPT = NO_RECEIPT;
  protected readonly accept = UPLOAD_ACCEPT;
  protected readonly entryOptions = AMOUNT_ENTRY_OPTIONS;
  protected readonly treatmentOptions = GST_TREATMENT_OPTIONS;
  protected readonly categoryOptions = DISBURSEMENT_CATEGORY_OPTIONS;

  private readonly today = inject(MT_TODAY);
  private readonly uploads = inject(DocumentUploads);
  private readonly descriptionField = viewChild('descriptionField', { read: ElementRef<HTMLElement> });

  protected readonly presetId = signal(NO_PRESET);
  protected readonly dateText = signal('');
  protected readonly description = signal('');
  protected readonly payee = signal('');
  protected readonly category = signal<DisbursementCategory>('other');
  protected readonly gstTreatment = signal<GstTreatment>('taxable');
  protected readonly amountText = signal('');
  protected readonly entry = signal<AmountEntry>(storedAmountEntry());
  protected readonly receiptId = signal(NO_RECEIPT);
  protected readonly dateError = signal<string | null>(null);
  protected readonly descriptionError = signal<string | null>(null);
  protected readonly amountError = signal<string | null>(null);
  /** The upload this form started for the receipt (its row key in DocumentUploads). */
  private readonly uploadKey = signal<string | null>(null);

  protected readonly presetOptions = computed((): MtOption<string>[] => [
    { value: NO_PRESET, label: 'No preset' },
    ...this.presets().map((preset) => ({ value: preset.id, label: preset.label })),
  ]);
  protected readonly receiptOptions = computed((): MtOption<string>[] => [
    { value: NO_RECEIPT, label: 'No receipt' },
    ...this.documents().map((doc) => ({ value: doc.id, label: doc.name })),
  ]);

  private readonly upload$ = computed(() => {
    const key = this.uploadKey();
    return key ? (this.uploads.items().find((item) => item.key === key) ?? null) : null;
  });
  /** Sending, or sent but not yet a document the receipt can point at. */
  protected readonly uploading = computed(() => {
    const item = this.upload$();
    if (!item) return false;
    if (['waiting', 'hashing', 'uploading'].includes(item.phase)) return true;
    return item.phase === 'sent' && !this.documents().some((doc) => doc.id === item.uploadId);
  });
  protected readonly uploadNote = computed(() => {
    const item = this.upload$();
    if (!item) return null;
    if (item.error) return `The receipt didn’t upload: ${item.error}`;
    if (this.uploading()) return `Uploading ${item.fileName}…`;
    return null;
  });

  private readonly cents = computed(() => parseDollars(this.amountText()));
  protected readonly preview = computed(() => {
    const cents = this.cents();
    if (!cents) return '';
    const amounts = enteredAmounts(cents, this.entry(), this.gstTreatment());
    return amountPreview(amounts.amountExGstCents, amounts.gstCents, this.gstTreatment());
  });

  constructor() {
    queueMicrotask(() => this.reset());
    // A receipt uploaded here is picked as soon as the server has made it a document.
    effect(() => {
      const item = this.upload$();
      const id = item?.uploadId;
      if (!id || !this.documents().some((doc) => doc.id === id)) return;
      untracked(() => {
        this.receiptId.set(id);
        this.uploadKey.set(null);
      });
    });
  }

  /** Puts the initial values back (a new one: today, nothing else). */
  reset(): void {
    const initial = this.initial();
    this.presetId.set(initial?.presetId ?? NO_PRESET);
    this.dateText.set(formatEntryDate(initial?.date ?? this.today()));
    this.description.set(initial?.description ?? '');
    this.payee.set(initial?.payee ?? '');
    this.category.set(initial?.category ?? 'other');
    this.gstTreatment.set(initial?.gstTreatment ?? 'taxable');
    if (initial) {
      const inclusive = typeof initial.amountIncGstCents === 'number';
      this.entry.set(inclusive ? 'inc' : 'ex');
      this.amountText.set(dollarsText(inclusive ? initial.amountIncGstCents : initial.amountExGstCents));
    } else {
      this.entry.set(storedAmountEntry());
      this.amountText.set('');
    }
    this.receiptId.set(initial?.receiptDocumentId ?? NO_RECEIPT);
    this.uploadKey.set(null);
    this.dateError.set(null);
    this.descriptionError.set(null);
    this.amountError.set(null);
  }

  focus(): void {
    this.descriptionField()?.nativeElement.querySelector('input')?.focus();
  }

  /** Prefills from a preset; what's typed after stays the person's. */
  protected applyPreset(id: string): void {
    this.presetId.set(id);
    const preset = this.presets().find((p) => p.id === id);
    if (!preset) return;
    this.description.set(preset.label);
    this.category.set(preset.category);
    this.gstTreatment.set(preset.gstTreatment);
    if (preset.payee) this.payee.set(preset.payee);
    if (typeof preset.defaultAmountCents === 'number') {
      this.amountText.set(dollarsText(preset.defaultAmountCents));
      this.entry.set('ex');
    }
    this.descriptionError.set(null);
    this.amountError.set(null);
  }

  protected setEntry(entry: AmountEntry | null): void {
    if (!entry) return;
    this.entry.set(entry);
    rememberAmountEntry(entry);
  }

  protected upload(event: Event): void {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    target.value = '';
    if (!file) return;
    this.uploads.add(this.matterId(), [file], { category: 'financial' });
    const mine = this.uploads.forMatter(this.matterId());
    this.uploadKey.set(mine[mine.length - 1]?.key ?? null);
  }

  protected save(): void {
    if (this.saving() || this.uploading()) return;
    const date = parseEntryDate(this.dateText(), this.today());
    const description = this.description().trim();
    const cents = this.cents();
    const amountProblem =
      cents === undefined ? 'Enter an amount in dollars, such as 42.50.' : disbursementAmountProblem(cents);
    this.dateError.set(date ? null : 'Enter a date such as 01/10/2026, or y for yesterday');
    this.descriptionError.set(description ? null : 'Say what was paid for.');
    this.amountError.set(amountProblem);
    if (!date || !description || amountProblem || !cents) return;
    const gstTreatment = this.gstTreatment();
    this.saved.emit({
      date,
      description,
      payee: this.payee().trim(),
      category: this.category(),
      presetId: this.presetId() || null,
      gstTreatment,
      ...enteredAmounts(cents, this.entry(), gstTreatment),
      receiptDocumentId: this.receiptId() || null,
    });
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }
}
