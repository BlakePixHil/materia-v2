import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  checkPayment,
  MANUAL_PAYMENT_METHODS,
  owingCents,
  PAYMENT_METHOD_LABELS,
  PAYMENT_WARNING_COPY,
  TRUST_PAYMENT_COPY,
  type InvoiceMoneyLike,
  type ManualPaymentMethod,
} from '@materia/domain';
import {
  formatAud,
  injectDialogRef,
  MT_TODAY,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtNote,
  MtSelect,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import { dollarsText, parseDollars } from '../settings/money';
import { formatEntryDate, parseEntryDate } from '../time/time-view';

export interface PaymentDialogData {
  kind: 'payment' | 'refund';
  number: string;
  invoice: InvoiceMoneyLike & { status: string; issueDate?: string | undefined };
}

export interface PaymentDialogResult {
  kind: 'payment' | 'refund';
  date: string;
  amountCents: number;
  method: ManualPaymentMethod;
  reference?: string;
  payer?: string;
  credit: boolean;
}

const METHOD_OPTIONS: MtOption<ManualPaymentMethod>[] = MANUAL_PAYMENT_METHODS.map((value) => ({
  value,
  label: PAYMENT_METHOD_LABELS[value],
}));

/**
 * Records a payment received against an invoice, or a refund of credit held (BILL-08). Defaults
 * to today and what's owing (or the credit held). The same checks as `billing-recordPayment` run
 * as you type: more than is owing needs "Keep the extra as a credit", and a date before the
 * invoice is allowed with a warning. The payer is free text (an estate's executor often pays).
 */
@Component({
  selector: 'mt-payment-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtNote, MtSelect, MtTextField],
  template: `
    <mt-dialog size="sm" [title]="title" [description]="description">
      <form id="mt-payment-form" class="mt-col" style="gap: var(--space-12)" (submit)="$event.preventDefault(); save()">
        <div class="mt-row" style="gap: var(--space-12); align-items: flex-start">
          <mt-text-field
            class="mt-grow"
            name="date"
            [label]="refund ? 'Date refunded' : fromTrust() ? 'Date withdrawn' : 'Date received'"
            placeholder="DD/MM/YYYY"
            [error]="dateError() ?? undefined"
            [ngModel]="dateText()"
            (ngModelChange)="dateText.set($event ?? ''); touched.set(false)"
          />
          <mt-text-field
            class="mt-grow"
            name="amount"
            label="Amount (AUD)"
            inputmode="decimal"
            placeholder="0.00"
            [error]="amountError() ?? undefined"
            [ngModel]="amountText()"
            (ngModelChange)="amountText.set($event ?? ''); touched.set(false)"
          />
        </div>
        <mt-select
          name="method"
          label="Method"
          [native]="true"
          [options]="methodOptions"
          [ngModel]="method()"
          (ngModelChange)="method.set($event ?? 'eft')"
        />
        @if (fromTrust()) {
          <mt-note tone="info" data-testid="payment-trust">{{ trustCopy }}</mt-note>
        }
        <mt-text-field
          name="reference"
          [label]="fromTrust() ? 'Trust records reference' : 'Reference'"
          [description]="
            fromTrust() ? 'The withdrawal’s reference in your trust records.' : 'A receipt, cheque or bank reference.'
          "
          [optional]="!fromTrust()"
          [required]="fromTrust()"
          [ngModel]="reference()"
          (ngModelChange)="reference.set($event ?? ''); touched.set(false)"
        />
        @if (!refund) {
          <mt-text-field
            name="payer"
            label="Paid by"
            description="If not the client: an executor, a family member."
            [optional]="true"
            [ngModel]="payer()"
            (ngModelChange)="payer.set($event ?? '')"
          />
          @if (over()) {
            <mt-checkbox
              name="credit"
              [label]="'Keep the extra ' + extra() + ' as a credit for the client'"
              [ngModel]="credit()"
              (ngModelChange)="credit.set(!!$event)"
            />
          }
        }
        @for (warning of check()?.warnings ?? []; track warning) {
          <mt-note tone="warning" data-testid="payment-warning">{{ warningCopy[warning] }}</mt-note>
        }
        @if (touched() && problem(); as message) {
          <mt-note tone="danger" data-testid="payment-problem">{{ message }}</mt-note>
        } @else if (check(); as result) {
          <p class="caption t-3" role="status">
            Afterwards:
            {{
              result.owingAfterCents < 0
                ? money(-result.owingAfterCents) + ' in credit'
                : money(result.owingAfterCents) + ' owing'
            }}.
          </p>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-payment-form">
          {{ refund ? 'Record refund' : 'Record payment' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class PaymentDialog {
  protected readonly ref = injectDialogRef<PaymentDialogData, PaymentDialogResult | undefined>();
  protected readonly data = this.ref.data;
  private readonly today = inject(MT_TODAY);
  protected readonly refund = this.data.kind === 'refund';
  protected readonly methodOptions = METHOD_OPTIONS;
  protected readonly warningCopy = PAYMENT_WARNING_COPY;
  protected readonly title = `${this.refund ? 'Record a refund on' : 'Record a payment on'} ${this.data.number}`;
  protected readonly description = this.refund
    ? 'Record money paid back to the client from the credit they hold. Materia records it; it doesn’t move money.'
    : 'Record money received for this invoice. Materia records it; it doesn’t take payments.';

  /** What's owing now (negative is credit held). */
  private readonly owing: number = owingCents(this.data.invoice);

  protected readonly dateText = signal(formatEntryDate(this.today()));
  protected readonly amountText = signal(dollarsText(this.refund ? Math.max(0, -this.owing) : Math.max(0, this.owing)));
  protected readonly method = signal<ManualPaymentMethod>('eft');
  protected readonly reference = signal('');
  protected readonly payer = signal('');
  protected readonly credit = signal(false);
  protected readonly touched = signal(false);
  /** BILL-12: a payment from trust is recorded after the withdrawal, with its reference. */
  protected readonly fromTrust = computed(() => this.method() === 'trust_transfer');
  protected readonly trustCopy = TRUST_PAYMENT_COPY;

  private readonly date = computed(() => parseEntryDate(this.dateText(), this.today()));
  private readonly amount = computed(() => parseDollars(this.amountText()));
  protected readonly dateError = computed(() =>
    this.touched() && !this.date() ? 'Enter a date like 6/10/2026.' : null,
  );
  protected readonly amountError = computed(() => {
    if (!this.touched()) return null;
    const amount = this.amount();
    return amount === undefined || amount === null || amount <= 0 ? 'Enter an amount, like 250.00.' : null;
  });
  protected readonly over = computed(() => (this.amount() ?? 0) > this.owing);
  protected readonly extra = computed(() => this.money((this.amount() ?? 0) - Math.max(0, this.owing)));

  protected readonly check = computed(() => {
    const date = this.date();
    const amount = this.amount();
    if (!date || !amount) return null;
    return checkPayment(
      this.data.invoice,
      {
        kind: this.data.kind,
        date,
        amountCents: amount,
        credit: this.credit(),
        method: this.method(),
        reference: this.reference(),
      },
      this.today(),
    );
  });
  protected readonly problem = computed(() => this.check()?.problem ?? null);

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected save(): void {
    this.touched.set(true);
    const date = this.date();
    const amount = this.amount();
    if (!date || !amount || amount <= 0 || this.problem()) return;
    void this.ref.close({
      kind: this.data.kind,
      date,
      amountCents: amount,
      method: this.method(),
      ...(this.reference().trim() ? { reference: this.reference().trim() } : {}),
      ...(!this.refund && this.payer().trim() ? { payer: this.payer().trim() } : {}),
      credit: !this.refund && this.over() && this.credit(),
    });
  }
}

export interface ReversePaymentDialogData {
  number: string;
  what: string;
  /** BILL-12: reversing a payment from trust: the trust records need their own correction. */
  trustWarning?: string | undefined;
}

/** Reverses a payment or refund (BILL-08): a bounced cheque, or one recorded in error. Closes with the reason. */
@Component({
  selector: 'mt-reverse-payment-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtTextarea],
  template: `
    <mt-dialog size="sm" role="alertdialog" [title]="'Reverse ' + data.what + '?'" [description]="description">
      <form
        id="mt-reverse-payment-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); save()"
      >
        @if (data.trustWarning; as warning) {
          <mt-note tone="warning" data-testid="reverse-trust-warning">{{ warning }}</mt-note>
        }
        <mt-textarea
          name="reason"
          label="Reason"
          description="For example, the cheque was dishonoured."
          [rows]="2"
          [maxLength]="500"
          [error]="error() ?? undefined"
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event ?? ''); error.set(null)"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="danger" type="submit" form="mt-reverse-payment-form">Reverse</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class ReversePaymentDialog {
  protected readonly ref = injectDialogRef<ReversePaymentDialogData, string | undefined>();
  protected readonly data = this.ref.data;
  protected readonly description = `It stays on invoice ${this.data.number}, marked reversed, and no longer counts.`;
  protected readonly reason = signal('');
  protected readonly error = signal<string | null>(null);

  protected save(): void {
    const reason = this.reason().trim();
    if (!reason) {
      this.error.set('Say why it’s being reversed.');
      return;
    }
    void this.ref.close(reason);
  }
}
