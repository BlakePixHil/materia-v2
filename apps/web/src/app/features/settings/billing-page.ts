import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import { orgSettingsReadRepository, type OrgSettings } from '@materia/data-access/repository';
import {
  BILLING_UNIT_OPTIONS,
  BillingSettingsInput,
  DEFAULT_DAILY_TARGET_MINUTES,
  feeProblems,
  MatterTypeSchema,
  type FeeDefault,
  type FeeDefaults,
  type MatterType,
} from '@materia/domain';
import {
  MATTER_TYPE_LABELS,
  MtButton,
  MtNote,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtSwitch,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { dollarsText, parseDollars } from './money';
import { SettingsApi } from './settings-api';
import { warnBeforeUnload, type HasUnsavedChanges } from './unsaved-changes';
import { errorCopy } from '../../core/error-copy';
import { FEE_ARRANGEMENT_OPTIONS } from '../intake/intake-state';

const TYPES = MatterTypeSchema.options;

interface FeeRow {
  arrangement: FeeDefault['arrangement'] | '';
  amount: string;
  estimate: string;
}

interface BillingForm {
  defaultRate: string;
  unitMinutes: number;
  rounding: 'up' | 'nearest';
  gstRegistered: boolean;
  invoicePrefix: string;
  paymentTermsDays: string;
  dailyTargetHours: string;
  nextInvoiceNumber: string;
  fees: Record<MatterType, FeeRow>;
}

function formOf(org: OrgSettings | undefined): BillingForm {
  const billing = org?.billing ?? {};
  const fees = Object.fromEntries(
    TYPES.map((type) => {
      const fee = org?.feeDefaults?.[type];
      const amount = fee?.arrangement === 'capped' ? fee.capCents : fee?.amountCents;
      return [
        type,
        { arrangement: fee?.arrangement ?? '', amount: dollarsText(amount), estimate: dollarsText(fee?.estimateCents) },
      ];
    }),
  ) as Record<MatterType, FeeRow>;
  return {
    defaultRate: dollarsText(billing.defaultRateCents ?? 0),
    unitMinutes: billing.unitMinutes ?? 6,
    rounding: billing.rounding ?? 'up',
    gstRegistered: billing.gstRegistered ?? true,
    invoicePrefix: billing.invoicePrefix ?? 'INV-',
    paymentTermsDays: String(billing.paymentTermsDays ?? 14),
    dailyTargetHours: String((billing.dailyTargetMinutes ?? DEFAULT_DAILY_TARGET_MINUTES) / 60),
    nextInvoiceNumber: '',
    fees,
  };
}

/** Hours as whole minutes (0 to 24 hours, 6.5 is 390), or `null` when it isn't one. */
function targetMinutes(text: string): number | null {
  const hours = Number(text.trim());
  if (!text.trim() || !Number.isFinite(hours) || hours < 0 || hours > 24) return null;
  return Math.round(hours * 60);
}

/** The fee defaults the rows describe, or the first problem. */
function feeDefaultsOf(fees: Record<MatterType, FeeRow>): {
  value?: FeeDefaults;
  problems: Partial<Record<MatterType, string>>;
} {
  const value: FeeDefaults = {};
  const problems: Partial<Record<MatterType, string>> = {};
  for (const type of TYPES) {
    const row = fees[type];
    if (!row.arrangement) continue;
    const amount = parseDollars(row.amount);
    const estimate = parseDollars(row.estimate);
    if (amount === undefined || estimate === undefined) {
      problems[type] = 'Enter amounts in dollars.';
      continue;
    }
    const fee = {
      arrangement: row.arrangement,
      ...(row.arrangement === 'fixed' && amount !== null ? { amountCents: amount } : {}),
      ...(row.arrangement === 'capped' && amount !== null ? { capCents: amount } : {}),
      ...(row.arrangement !== 'pro_bono' && estimate !== null ? { estimateCents: estimate } : {}),
    };
    const problem = feeProblems(fee)[0];
    if (problem) problems[type] = problem.message;
    else value[type] = fee;
  }
  return Object.keys(problems).length ? { problems } : { value, problems };
}

/**
 * Settings → Billing and rates (`/settings/billing`, CORE-21; owners and admins): the default rate,
 * billing unit and rounding, GST registration, invoice numbering and terms, and each matter type's
 * default fee arrangement and estimate (prefilled at intake). Each member's own rate and budgets are
 * on the team page. Saved through `orgs-updateSettings`; rate changes apply to new time entries only.
 */
@Component({
  selector: 'mt-billing-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtNote, MtSelect, MtSettingsRow, MtSettingsSection, MtSwitch, MtTextField],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Billing and rates</h1>
      <p style="margin: 0; color: var(--text-secondary)">
        How time is recorded and invoiced. Rate changes apply to new time entries only; recorded entries keep their
        rate.
      </p>
    </div>

    @switch (org.status()) {
      @case ('loading') {
        <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading settings…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
    }

    <form class="mt-col" style="gap: 24px" (submit)="$event.preventDefault(); save()">
      <mt-settings-section title="Time" [headingLevel]="2">
        <mt-text-field
          name="defaultRate"
          label="Default hourly rate"
          description="Excluding GST. Used when a member has no rate of their own."
          inputmode="decimal"
          suffix="AUD / h"
          [error]="rateProblem() ?? undefined"
          [ngModel]="form().defaultRate"
          (ngModelChange)="set({ defaultRate: $event ?? '' })"
        />
        <div class="pair">
          <mt-select
            name="unitMinutes"
            label="Billing unit"
            [native]="true"
            [options]="units"
            [ngModel]="form().unitMinutes"
            (ngModelChange)="set({ unitMinutes: $event ?? 6 })"
          />
          <mt-select
            name="rounding"
            label="Rounding"
            [native]="true"
            [options]="roundings"
            [ngModel]="form().rounding"
            (ngModelChange)="set({ rounding: $event ?? 'up' })"
          />
        </div>
      </mt-settings-section>

      <mt-settings-section title="Invoices" [headingLevel]="2">
        <mt-settings-row
          title="Registered for GST"
          description="Invoices show GST and are titled “Tax invoice” when on."
        >
          <mt-switch
            name="gst"
            label="Registered for GST"
            labelHidden
            [ngModel]="form().gstRegistered"
            (ngModelChange)="set({ gstRegistered: !!$event })"
          />
        </mt-settings-row>
        @if (gstChanged()) {
          <mt-note tone="warning" data-gst-warning>
            This applies to new invoices only. Invoices already issued keep their GST treatment.
          </mt-note>
        }
        <div class="pair">
          <mt-text-field
            name="invoicePrefix"
            label="Invoice number prefix"
            autocomplete="off"
            [error]="prefixProblem() ?? undefined"
            [ngModel]="form().invoicePrefix"
            (ngModelChange)="set({ invoicePrefix: $event ?? '' })"
          />
          <mt-text-field
            name="paymentTermsDays"
            label="Payment terms"
            suffix="days"
            inputmode="numeric"
            [error]="termsProblem() ?? undefined"
            [ngModel]="form().paymentTermsDays"
            (ngModelChange)="set({ paymentTermsDays: $event ?? '' })"
          />
        </div>
        <mt-text-field
          name="dailyTargetHours"
          label="Daily time target"
          description="Each person’s weekday target on Time and billing."
          suffix="hours"
          inputmode="decimal"
          [error]="targetProblem() ?? undefined"
          [ngModel]="form().dailyTargetHours"
          (ngModelChange)="set({ dailyTargetHours: $event ?? '' })"
        />
        <mt-text-field
          name="nextInvoiceNumber"
          label="Start invoice numbers at"
          description="Only before the first invoice: invoice numbers are gapless and can’t change after that."
          inputmode="numeric"
          optional
          [error]="nextNumberProblem() ?? undefined"
          [ngModel]="form().nextInvoiceNumber"
          (ngModelChange)="set({ nextInvoiceNumber: $event ?? '' })"
        />
      </mt-settings-section>

      <mt-settings-section
        title="Fee defaults by matter type"
        description="Filled in when a new matter of the type is opened. People can change them on the matter."
        [headingLevel]="2"
      >
        <div class="fees" role="group" aria-label="Fee defaults">
          @for (type of types; track type) {
            @let row = form().fees[type];
            <div class="fee-row" [attr.data-fee]="type">
              <span class="label type">{{ typeLabel(type) }}</span>
              <mt-select
                size="sm"
                [name]="'arr-' + type"
                [label]="typeLabel(type) + ' fee arrangement'"
                [native]="true"
                [options]="arrangements"
                [ngModel]="row.arrangement"
                (ngModelChange)="setFee(type, { arrangement: $event ?? '' })"
              />
              @if (row.arrangement === 'fixed' || row.arrangement === 'capped') {
                <mt-text-field
                  size="sm"
                  [name]="'amt-' + type"
                  [label]="typeLabel(type) + (row.arrangement === 'fixed' ? ' fixed fee' : ' cap')"
                  inputmode="decimal"
                  [ngModel]="row.amount"
                  (ngModelChange)="setFee(type, { amount: $event ?? '' })"
                />
              }
              @if (row.arrangement && row.arrangement !== 'pro_bono') {
                <mt-text-field
                  size="sm"
                  [name]="'est-' + type"
                  [label]="typeLabel(type) + ' estimate'"
                  inputmode="decimal"
                  [ngModel]="row.estimate"
                  (ngModelChange)="setFee(type, { estimate: $event ?? '' })"
                />
              }
              @if (feeProblems()[type]; as problem) {
                <span class="caption problem" role="alert">{{ problem }}</span>
              }
            </div>
          }
        </div>
      </mt-settings-section>

      <div class="mt-row" style="gap: 8px">
        <button mtButton variant="primary" type="submit" [loading]="saving()" [disabled]="!ready()">Save</button>
        <button mtButton variant="ghost" type="button" [disabled]="!unsaved()" (click)="reset()">
          Discard changes
        </button>
      </div>
    </form>
  `,
  styles: `
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--space-12, 12px);
    }
    .fees {
      display: flex;
      flex-direction: column;
      gap: var(--space-12, 12px);
    }
    .fee-row {
      display: grid;
      grid-template-columns: 140px repeat(3, minmax(120px, 1fr));
      gap: var(--space-8, 8px);
      align-items: end;
    }
    .fee-row .type {
      align-self: center;
    }
    .fee-row .problem {
      grid-column: 2 / -1;
      color: var(--text-danger);
    }
    @media (max-width: 599px) {
      .fee-row {
        grid-template-columns: 1fr;
      }
      .fee-row .problem {
        grid-column: auto;
      }
    }
  `,
})
export class BillingSettingsPage implements HasUnsavedChanges {
  private readonly context = inject(OrgContext);
  private readonly api = inject(SettingsApi);
  private readonly toasts = inject(ToastService);
  protected readonly org = orgSettingsReadRepository().watch(() => this.context.orgId());

  protected readonly types = TYPES;
  protected readonly units: MtOption<number>[] = BILLING_UNIT_OPTIONS.map((m) => ({
    value: m,
    label: m === 6 ? '6 minutes (0.1 h)' : `${m} minute${m === 1 ? '' : 's'}`,
  }));
  protected readonly roundings: MtOption<'up' | 'nearest'>[] = [
    { value: 'up', label: 'Round up to the next unit' },
    { value: 'nearest', label: 'Round to the nearest unit' },
  ];
  protected readonly arrangements: MtOption<FeeDefault['arrangement'] | ''>[] = [
    { value: '', label: 'No default' },
    // A conditional arrangement needs its condition, which is the matter's own.
    ...(FEE_ARRANGEMENT_OPTIONS.filter((o) => o.value !== 'conditional') as MtOption<FeeDefault['arrangement']>[]),
  ];

  protected readonly form = signal<BillingForm>(formOf(undefined));
  private readonly saved = signal<BillingForm | null>(null);
  protected readonly saving = signal(false);

  readonly unsaved = computed(() => {
    const saved = this.saved();
    return !!saved && JSON.stringify(saved) !== JSON.stringify(this.form());
  });
  protected readonly gstChanged = computed(() => {
    const saved = this.saved();
    return !!saved && saved.gstRegistered !== this.form().gstRegistered;
  });
  protected readonly rateProblem = computed(() => {
    const value = parseDollars(this.form().defaultRate);
    return value === undefined || value === null ? 'Enter a rate in dollars.' : null;
  });
  protected readonly prefixProblem = computed(() =>
    /^[A-Za-z0-9-]{0,10}$/.test(this.form().invoicePrefix.trim()) ? null : 'Up to 10 letters, digits or hyphens.',
  );
  protected readonly termsProblem = computed(() => {
    const days = Number(this.form().paymentTermsDays);
    return Number.isInteger(days) && days >= 0 && days <= 365 ? null : 'Enter 0 to 365 days.';
  });
  protected readonly targetProblem = computed(() =>
    targetMinutes(this.form().dailyTargetHours) === null ? 'Enter 0 to 24 hours.' : null,
  );
  protected readonly nextNumberProblem = computed(() => {
    const text = this.form().nextInvoiceNumber.trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isInteger(n) && n >= 1 && n <= 9_999_999 ? null : 'Enter a whole number from 1.';
  });
  private readonly fees = computed(() => feeDefaultsOf(this.form().fees));
  protected readonly feeProblems = computed(() => this.fees().problems);
  private readonly billing = computed(() => {
    const f = this.form();
    return BillingSettingsInput.safeParse({
      defaultRateCents: parseDollars(f.defaultRate),
      unitMinutes: f.unitMinutes,
      rounding: f.rounding,
      gstRegistered: f.gstRegistered,
      invoicePrefix: f.invoicePrefix,
      paymentTermsDays: Number(f.paymentTermsDays),
      dailyTargetMinutes: targetMinutes(f.dailyTargetHours) ?? -1,
    });
  });
  protected readonly ready = computed(
    () =>
      this.unsaved() && this.billing().success && !!this.fees().value && !this.nextNumberProblem() && !this.saving(),
  );
  protected readonly loadError = computed(() => {
    const error = this.org.error();
    return error ? errorCopy(error) : 'Couldn’t load the settings.';
  });

  constructor() {
    warnBeforeUnload(this.unsaved);
    effect(() => {
      const org = this.org.value();
      if (!org) return;
      untracked(() => {
        if (this.unsaved()) return;
        const form = formOf(org);
        this.form.set(form);
        this.saved.set(form);
      });
    });
  }

  protected typeLabel(type: MatterType): string {
    return MATTER_TYPE_LABELS[type];
  }

  protected set(patch: Partial<BillingForm>): void {
    this.form.update((form) => ({ ...form, ...patch }));
  }

  protected setFee(type: MatterType, patch: Partial<FeeRow>): void {
    this.form.update((form) => ({ ...form, fees: { ...form.fees, [type]: { ...form.fees[type], ...patch } } }));
  }

  protected reset(): void {
    const saved = this.saved();
    if (saved) this.form.set(saved);
  }

  protected async save(): Promise<void> {
    const billing = this.billing();
    const feeDefaults = this.fees().value;
    if (!this.ready() || !billing.success || !feeDefaults) return;
    const next = this.form().nextInvoiceNumber.trim();
    this.saving.set(true);
    try {
      await this.api.updateSettings({
        billing: billing.data,
        feeDefaults,
        ...(next ? { nextInvoiceNumber: Number(next) } : {}),
      });
      const saved = { ...this.form(), nextInvoiceNumber: '' };
      this.form.set(saved);
      this.saved.set(saved);
      this.toasts.show({ title: 'Billing settings saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The settings didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
