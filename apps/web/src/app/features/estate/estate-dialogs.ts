import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { EstateAsset, EstateDistribution, EstateLiability, Repository } from '@materia/data-access/repository';
import {
  defaultPassesOutside,
  type AssetClass,
  type AssetStatus,
  type DistributionKind,
  type DistributionStatus,
  type JointHolding,
  type LiabilityClass,
  type LiabilityStatus,
} from '@materia/domain';
import {
  injectDialogRef,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtNote,
  MtSelect,
  MtTextarea,
  MtTextField,
} from '@materia/ui';

import {
  ASSET_CLASS_OPTIONS,
  ASSET_STATUS_OPTIONS,
  DISTRIBUTION_KIND_OPTIONS,
  DISTRIBUTION_STATUS_OPTIONS,
  JOINT_HOLDING_OPTIONS,
  LIABILITY_CLASS_OPTIONS,
  LIABILITY_STATUS_OPTIONS,
  moneyInput,
  parseMoneyInput,
  parseShareInput,
  shareInput,
  type AssetRow,
  type DistributionRow,
  type LiabilityRow,
} from './estate-view';
import { errorCopy } from '../../core/error-copy';
import { formatDateInput, parseDateInput } from '../contacts/contact-form';

/** What an estate dialog did. */
export type EstateDialogResult = 'saved' | 'removed' | undefined;

type Patch = Record<string, unknown>;

/** Splits a form's values into the fields to write and the optional fields cleared (edits only). */
function changes(values: Patch, editing: boolean): { patch: Patch; remove: string[] } {
  const patch: Patch = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '') {
      if (editing) remove.push(key);
    } else {
      patch[key] = value;
    }
  }
  return { patch, remove };
}

async function write<T>(repo: Repository<T>, id: string | undefined, values: Patch): Promise<void> {
  const { patch, remove } = changes(values, !!id);
  if (id) await repo.update(id, patch, { remove });
  else await repo.create(patch);
}

const FORM_STYLE = `
  .mt-estate-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
  }
  .mt-estate-form .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-12);
  }
  .mt-estate-form fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  .mt-estate-form legend {
    font: 600 13px/18px var(--font-sans);
    margin-bottom: var(--space-4);
  }
  @media (max-width: 560px) {
    .mt-estate-form .pair {
      grid-template-columns: 1fr;
    }
  }
`;

// ---------- assets ----------

export interface AssetDialogData {
  repo: Repository<EstateAsset>;
  asset?: AssetRow;
  /** The matter's documents, for the valuation documents. */
  documents: readonly { id: string; name: string }[];
  /** The asset's class for a new asset (the quick-entry row's). */
  assetClass?: AssetClass;
}

/**
 * Add or edit an estate asset (CORE-16): its class and value at the date of death, how it's held
 * (a joint tenancy passes outside the estate by default; tenants in common hold a share in it), its
 * progress and realised amount, a foreign currency, valuation documents and notes. Saves directly
 * under the rules; `estate-onWrite` updates the totals.
 */
@Component({
  selector: 'mt-asset-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtNote, MtSelect, MtTextarea, MtTextField],
  template: `
    <mt-dialog [title]="data.asset ? 'Edit asset' : 'Add an asset'" [closeOnOutsideClick]="false">
      <form id="mt-asset-form" class="mt-estate-form" (submit)="$event.preventDefault(); save()">
        <div class="pair">
          <mt-select
            name="class"
            label="Class"
            [native]="true"
            [options]="classes"
            [ngModel]="assetClass()"
            (ngModelChange)="assetClass.set($event)"
          />
          <mt-select
            name="status"
            label="Status"
            [native]="true"
            [options]="statuses"
            [ngModel]="status()"
            (ngModelChange)="status.set($event)"
          />
        </div>
        <mt-text-field
          name="description"
          label="Description"
          [required]="true"
          [error]="errors()['description']"
          [ngModel]="description()"
          (ngModelChange)="description.set($event ?? '')"
        />
        <mt-text-field
          name="institution"
          label="Institution or reference"
          [optional]="true"
          description="The bank and account, title reference or policy number."
          [ngModel]="institution()"
          (ngModelChange)="institution.set($event ?? '')"
        />
        <div class="pair">
          <mt-text-field
            name="value"
            label="Value at date of death"
            inputmode="decimal"
            [required]="true"
            [error]="errors()['value']"
            [ngModel]="value()"
            (ngModelChange)="value.set($event ?? '')"
          >
            <span mtPrefix>$</span>
          </mt-text-field>
          <mt-text-field
            name="realised"
            label="Realised"
            inputmode="decimal"
            [optional]="true"
            [error]="errors()['realised']"
            [ngModel]="realised()"
            (ngModelChange)="realised.set($event ?? '')"
          >
            <span mtPrefix>$</span>
          </mt-text-field>
        </div>
        <div class="pair">
          <mt-text-field
            name="valuationSource"
            label="Valuation source"
            [optional]="true"
            [ngModel]="valuationSource()"
            (ngModelChange)="valuationSource.set($event ?? '')"
          />
          <mt-text-field
            name="valuedOn"
            label="Valued on"
            placeholder="DD/MM/YYYY"
            [optional]="true"
            [error]="errors()['valuedOn']"
            [ngModel]="valuedOn()"
            (ngModelChange)="valuedOn.set($event ?? '')"
          />
        </div>
        <fieldset>
          <legend>Ownership</legend>
          <mt-checkbox
            name="jointlyHeld"
            label="Jointly held"
            [ngModel]="jointlyHeld()"
            (ngModelChange)="setJoint($event, holding())"
          />
          @if (jointlyHeld()) {
            <mt-select
              name="jointHolding"
              label="Held as"
              [native]="true"
              [options]="holdings"
              [ngModel]="holding()"
              (ngModelChange)="setJoint(true, $event)"
            />
          }
          <mt-text-field
            name="share"
            label="Deceased’s share"
            inputmode="decimal"
            suffix="%"
            [optional]="true"
            description="Leave blank for the whole asset."
            [error]="errors()['share']"
            [ngModel]="share()"
            (ngModelChange)="share.set($event ?? '')"
          />
          <mt-checkbox
            name="outside"
            label="Passes outside the estate"
            description="Superannuation paid under a nomination, a joint tenancy or a nominated policy. Shown separately and left out of the gross estate."
            [ngModel]="outside()"
            (ngModelChange)="outside.set($event)"
          />
        </fieldset>
        <div class="pair">
          <mt-text-field
            name="currency"
            label="Original currency"
            placeholder="USD"
            [optional]="true"
            [error]="errors()['currency']"
            [ngModel]="currency()"
            (ngModelChange)="currency.set(($event ?? '').toUpperCase())"
          />
          <mt-text-field
            name="originalAmount"
            label="Original amount"
            inputmode="decimal"
            [optional]="true"
            [error]="errors()['originalAmount']"
            [ngModel]="originalAmount()"
            (ngModelChange)="originalAmount.set($event ?? '')"
          />
        </div>
        @if (data.documents.length) {
          <fieldset>
            <legend>Valuation documents</legend>
            @for (document of data.documents; track document.id) {
              <mt-checkbox
                [name]="'doc-' + document.id"
                [label]="document.name"
                [ngModel]="documentIds().includes(document.id)"
                (ngModelChange)="toggleDocument(document.id, $event)"
              />
            }
          </fieldset>
        }
        <mt-textarea
          name="notes"
          label="Notes"
          [optional]="true"
          [ngModel]="notes()"
          (ngModelChange)="notes.set($event ?? '')"
        />
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        @if (data.asset) {
          <button mtButton variant="ghost" style="margin-right: auto" (click)="remove()">Remove asset</button>
        }
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-asset-form" [loading]="saving()">
          {{ data.asset ? 'Save' : 'Add asset' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: FORM_STYLE,
})
export class AssetDialog {
  protected readonly ref = injectDialogRef<AssetDialogData, EstateDialogResult>();
  protected readonly data = this.ref.data;
  private readonly asset = this.data.asset;

  protected readonly classes = ASSET_CLASS_OPTIONS;
  protected readonly statuses = ASSET_STATUS_OPTIONS;
  protected readonly holdings = JOINT_HOLDING_OPTIONS;

  protected readonly assetClass = signal<AssetClass>(this.asset?.class ?? this.data.assetClass ?? 'bank');
  protected readonly status = signal<AssetStatus>(this.asset?.status ?? 'identified');
  protected readonly description = signal(this.asset?.description ?? '');
  protected readonly institution = signal(this.asset?.institution ?? '');
  protected readonly value = signal(moneyInput(this.asset?.valueAtDeathCents));
  protected readonly realised = signal(moneyInput(this.asset?.realisedCents));
  protected readonly valuationSource = signal(this.asset?.valuationSource ?? '');
  protected readonly valuedOn = signal(formatDateInput(this.asset?.valuedOn));
  protected readonly jointlyHeld = signal(this.asset?.jointlyHeld ?? false);
  protected readonly holding = signal<JointHolding>(this.asset?.jointHolding ?? 'joint_tenants');
  protected readonly share = signal(shareInput(this.asset?.shareBps));
  protected readonly outside = signal(this.asset?.passesOutsideEstate ?? false);
  protected readonly currency = signal(this.asset?.originalCurrency ?? '');
  protected readonly originalAmount = signal(
    this.asset?.originalAmount === undefined ? '' : String(this.asset.originalAmount),
  );
  protected readonly documentIds = signal<readonly string[]>(this.asset?.documentIds ?? []);
  protected readonly notes = signal(this.asset?.notes ?? '');

  protected readonly errors = signal<Record<string, string | undefined>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  /** Joint tenancy passes outside by default; tenants in common, or sole ownership, doesn't. */
  protected setJoint(jointlyHeld: boolean, holding: JointHolding): void {
    this.jointlyHeld.set(jointlyHeld);
    this.holding.set(holding);
    this.outside.set(defaultPassesOutside(jointlyHeld, holding));
  }

  protected toggleDocument(id: string, on: boolean): void {
    this.documentIds.update((ids) => (on ? [...ids.filter((other) => other !== id), id] : ids.filter((o) => o !== id)));
  }

  private values(): Patch | null {
    const errors: Record<string, string | undefined> = {};
    const value = parseMoneyInput(this.value());
    const realised = parseMoneyInput(this.realised());
    const share = parseShareInput(this.share());
    const description = this.description().trim();
    if (!description) errors['description'] = 'Describe the asset.';
    if ('error' in value) errors['value'] = value.error;
    else if (value.value === undefined) errors['value'] = 'Enter the value at the date of death (0 if unknown).';
    if ('error' in realised) errors['realised'] = realised.error;
    if ('error' in share) errors['share'] = share.error;
    const valuedOn = this.valuedOn().trim() ? parseDateInput(this.valuedOn()) : undefined;
    if (valuedOn === null) errors['valuedOn'] = 'Enter a date like 14/06/2026.';
    const currency = this.currency().trim();
    if (currency && !/^[A-Z]{3}$/.test(currency)) errors['currency'] = 'Enter a three-letter code like USD.';
    const amountText = this.originalAmount().trim().replace(/,/g, '');
    if (amountText && !/^\d+(\.\d+)?$/.test(amountText)) errors['originalAmount'] = 'Enter an amount like 1200.50.';
    this.errors.set(errors);
    if (Object.values(errors).some(Boolean)) return null;
    return {
      class: this.assetClass(),
      status: this.status(),
      description,
      institution: this.institution().trim(),
      valueAtDeathCents: 'value' in value ? value.value : undefined,
      realisedCents: 'value' in realised ? realised.value : undefined,
      valuationSource: this.valuationSource().trim(),
      valuedOn: valuedOn ?? undefined,
      jointlyHeld: this.jointlyHeld(),
      jointHolding: this.jointlyHeld() ? this.holding() : undefined,
      shareBps: 'value' in share ? share.value : undefined,
      passesOutsideEstate: this.outside(),
      originalCurrency: currency,
      originalAmount: amountText ? Number(amountText) : undefined,
      documentIds: [...this.documentIds()],
      notes: this.notes().trim(),
    };
  }

  protected async save(): Promise<void> {
    const values = this.values();
    if (!values || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await write(this.data.repo, this.asset?.id, values);
      void this.ref.close('saved');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    if (!this.asset || this.saving()) return;
    this.saving.set(true);
    try {
      await this.data.repo.softDelete(this.asset.id);
      void this.ref.close('removed');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}

// ---------- liabilities ----------

export interface LiabilityDialogData {
  repo: Repository<EstateLiability>;
  liability?: LiabilityRow;
}

/** Add or edit an estate liability (CORE-16): the creditor, class, amount and status. */
@Component({
  selector: 'mt-liability-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSelect, MtTextarea, MtTextField],
  template: `
    <mt-dialog [title]="data.liability ? 'Edit liability' : 'Add a liability'" [closeOnOutsideClick]="false">
      <form id="mt-liability-form" class="mt-estate-form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="creditor"
          label="Creditor"
          [required]="true"
          [error]="errors()['creditor']"
          [ngModel]="creditor()"
          (ngModelChange)="creditor.set($event ?? '')"
        />
        <div class="pair">
          <mt-select
            name="class"
            label="Class"
            [native]="true"
            [options]="classes"
            [ngModel]="liabilityClass()"
            (ngModelChange)="liabilityClass.set($event)"
          />
          <mt-select
            name="status"
            label="Status"
            [native]="true"
            [options]="statuses"
            [ngModel]="status()"
            (ngModelChange)="status.set($event)"
          />
        </div>
        <div class="pair">
          <mt-text-field
            name="amount"
            label="Amount"
            inputmode="decimal"
            [required]="true"
            [error]="errors()['amount']"
            [ngModel]="amount()"
            (ngModelChange)="amount.set($event ?? '')"
          >
            <span mtPrefix>$</span>
          </mt-text-field>
          <mt-text-field
            name="reference"
            label="Reference"
            [optional]="true"
            [ngModel]="reference()"
            (ngModelChange)="reference.set($event ?? '')"
          />
        </div>
        <mt-textarea
          name="notes"
          label="Notes"
          [optional]="true"
          [ngModel]="notes()"
          (ngModelChange)="notes.set($event ?? '')"
        />
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        @if (data.liability) {
          <button mtButton variant="ghost" style="margin-right: auto" (click)="remove()">Remove liability</button>
        }
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-liability-form" [loading]="saving()">
          {{ data.liability ? 'Save' : 'Add liability' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: FORM_STYLE,
})
export class LiabilityDialog {
  protected readonly ref = injectDialogRef<LiabilityDialogData, EstateDialogResult>();
  protected readonly data = this.ref.data;
  private readonly liability = this.data.liability;

  protected readonly classes = LIABILITY_CLASS_OPTIONS;
  protected readonly statuses = LIABILITY_STATUS_OPTIONS;
  protected readonly liabilityClass = signal<LiabilityClass>(this.liability?.class ?? 'debt');
  protected readonly status = signal<LiabilityStatus>(this.liability?.status ?? 'notified');
  protected readonly creditor = signal(this.liability?.creditor ?? '');
  protected readonly reference = signal(this.liability?.reference ?? '');
  protected readonly amount = signal(moneyInput(this.liability?.amountCents));
  protected readonly notes = signal(this.liability?.notes ?? '');
  protected readonly errors = signal<Record<string, string | undefined>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected async save(): Promise<void> {
    const creditor = this.creditor().trim();
    const amount = parseMoneyInput(this.amount());
    const errors: Record<string, string | undefined> = {};
    if (!creditor) errors['creditor'] = 'Name the creditor.';
    if ('error' in amount) errors['amount'] = amount.error;
    else if (amount.value === undefined) errors['amount'] = 'Enter the amount owed.';
    this.errors.set(errors);
    if (Object.values(errors).some(Boolean) || this.saving() || !('value' in amount)) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await write(this.data.repo, this.liability?.id, {
        class: this.liabilityClass(),
        status: this.status(),
        creditor,
        reference: this.reference().trim(),
        amountCents: amount.value,
        notes: this.notes().trim(),
      });
      void this.ref.close('saved');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    if (!this.liability || this.saving()) return;
    this.saving.set(true);
    try {
      await this.data.repo.softDelete(this.liability.id);
      void this.ref.close('removed');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}

// ---------- distributions ----------

export interface DistributionDialogData {
  repo: Repository<EstateDistribution>;
  distribution?: DistributionRow;
  beneficiaries: readonly { value: string; label: string }[];
  assets: readonly { value: string; label: string }[];
}

/**
 * Record a planned or paid distribution to a beneficiary (CORE-16): a specific gift of an asset, a
 * pecuniary gift of an amount, or a share of the residue. Saving an edit clears its review flag.
 */
@Component({
  selector: 'mt-distribution-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSelect, MtTextarea, MtTextField],
  template: `
    <mt-dialog
      [title]="data.distribution ? 'Edit distribution' : 'Record a distribution'"
      [closeOnOutsideClick]="false"
    >
      <form id="mt-distribution-form" class="mt-estate-form" (submit)="$event.preventDefault(); save()">
        @if (data.distribution?.needsValueReview) {
          <mt-note tone="warning">
            An asset’s value changed after this was recorded. Check it, then save to mark it reviewed.
          </mt-note>
        }
        <mt-select
          name="beneficiary"
          label="Beneficiary"
          [native]="true"
          [required]="true"
          [error]="errors()['beneficiary']"
          [options]="data.beneficiaries"
          [ngModel]="beneficiary()"
          (ngModelChange)="beneficiary.set($event)"
        />
        <div class="pair">
          <mt-select
            name="kind"
            label="Gift"
            [native]="true"
            [options]="kinds"
            [ngModel]="kind()"
            (ngModelChange)="kind.set($event)"
          />
          <mt-select
            name="status"
            label="Status"
            [native]="true"
            [options]="statuses"
            [ngModel]="status()"
            (ngModelChange)="status.set($event)"
          />
        </div>
        @if (kind() === 'specific') {
          <mt-select
            name="asset"
            label="Asset"
            [native]="true"
            [required]="true"
            [error]="errors()['asset']"
            [options]="data.assets"
            [ngModel]="assetId()"
            (ngModelChange)="assetId.set($event)"
          />
        }
        @if (kind() === 'residuary') {
          <mt-text-field
            name="share"
            label="Share of the residue"
            [optional]="true"
            description="As the will words it, like “One half”."
            [ngModel]="share()"
            (ngModelChange)="share.set($event ?? '')"
          />
        } @else {
          <mt-text-field
            name="amount"
            label="Amount"
            inputmode="decimal"
            [optional]="kind() === 'specific'"
            [required]="kind() === 'pecuniary'"
            [description]="kind() === 'specific' ? 'Leave blank to use the asset’s value.' : ''"
            [error]="errors()['amount']"
            [ngModel]="amount()"
            (ngModelChange)="amount.set($event ?? '')"
          >
            <span mtPrefix>$</span>
          </mt-text-field>
        }
        @if (status() === 'paid') {
          <mt-text-field
            name="paidOn"
            label="Paid on"
            placeholder="DD/MM/YYYY"
            [optional]="true"
            [error]="errors()['paidOn']"
            [ngModel]="paidOn()"
            (ngModelChange)="paidOn.set($event ?? '')"
          />
        }
        <mt-textarea
          name="notes"
          label="Notes"
          [optional]="true"
          [ngModel]="notes()"
          (ngModelChange)="notes.set($event ?? '')"
        />
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        @if (data.distribution) {
          <button mtButton variant="ghost" style="margin-right: auto" (click)="remove()">Remove</button>
        }
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-distribution-form" [loading]="saving()">
          {{ data.distribution ? 'Save' : 'Record distribution' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: FORM_STYLE,
})
export class DistributionDialog {
  protected readonly ref = injectDialogRef<DistributionDialogData, EstateDialogResult>();
  protected readonly data = this.ref.data;
  private readonly distribution = this.data.distribution;

  protected readonly kinds = DISTRIBUTION_KIND_OPTIONS;
  protected readonly statuses = DISTRIBUTION_STATUS_OPTIONS;
  protected readonly beneficiary = signal<string | null>(
    this.distribution?.beneficiaryPartyId ?? this.data.beneficiaries[0]?.value ?? null,
  );
  protected readonly kind = signal<DistributionKind>(this.distribution?.kind ?? 'pecuniary');
  protected readonly status = signal<DistributionStatus>(this.distribution?.status ?? 'planned');
  protected readonly assetId = signal<string | null>(this.distribution?.assetId ?? this.data.assets[0]?.value ?? null);
  protected readonly amount = signal(moneyInput(this.distribution?.amountCents));
  protected readonly share = signal(this.distribution?.share ?? '');
  protected readonly paidOn = signal(formatDateInput(this.distribution?.paidOn));
  protected readonly notes = signal(this.distribution?.notes ?? '');
  protected readonly errors = signal<Record<string, string | undefined>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly editing = computed(() => !!this.distribution);

  protected async save(): Promise<void> {
    const kind = this.kind();
    const errors: Record<string, string | undefined> = {};
    const amount = kind === 'residuary' ? { value: undefined } : parseMoneyInput(this.amount());
    if (!this.beneficiary()) errors['beneficiary'] = 'Choose a beneficiary.';
    if (kind === 'specific' && !this.assetId()) errors['asset'] = 'Choose the asset given.';
    if ('error' in amount) errors['amount'] = amount.error;
    else if (kind === 'pecuniary' && amount.value === undefined) errors['amount'] = 'Enter the amount of the gift.';
    const paidOn = this.status() === 'paid' && this.paidOn().trim() ? parseDateInput(this.paidOn()) : undefined;
    if (paidOn === null) errors['paidOn'] = 'Enter a date like 14/06/2026.';
    this.errors.set(errors);
    if (Object.values(errors).some(Boolean) || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await write(this.data.repo, this.distribution?.id, {
        beneficiaryPartyId: this.beneficiary(),
        kind,
        status: this.status(),
        amountCents: 'value' in amount ? amount.value : undefined,
        assetId: kind === 'specific' ? (this.assetId() ?? undefined) : undefined,
        share: kind === 'residuary' ? this.share().trim() : undefined,
        paidOn: paidOn ?? undefined,
        notes: this.notes().trim(),
        // Saving an edit is the review.
        ...(this.distribution?.needsValueReview ? { needsValueReview: false } : {}),
      });
      void this.ref.close('saved');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    if (!this.distribution || this.saving()) return;
    this.saving.set(true);
    try {
      await this.data.repo.softDelete(this.distribution.id);
      void this.ref.close('removed');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}
