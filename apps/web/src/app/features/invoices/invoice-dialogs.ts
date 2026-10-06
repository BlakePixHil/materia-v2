import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { CreditNoteItem, InvoiceItem } from '@materia/data-access/repository';
import {
  creditableLines,
  creditNoteLines,
  INVOICE_MESSAGE_MAX,
  INVOICE_SEND_MAX_RECIPIENTS,
  invoiceTotals,
  type CreditLineInput,
} from '@materia/domain';
import {
  formatAud,
  injectDialogRef,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtNote,
  MtSegmentedControl,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import { dollarsText, parseDollars } from '../settings/money';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SendInvoiceDialogData {
  number: string;
  total: string;
  /** The clients' addresses: the default "To". */
  emails: string[];
}

export interface SendInvoiceDialogResult {
  to: string[];
  message: string;
}

/** Emails an issued invoice's PDF (BILL-07): to the clients by default, with an optional message. */
@Component({
  selector: 'mt-send-invoice-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextarea, MtTextField],
  template: `
    <mt-dialog size="sm" [title]="'Email invoice ' + data.number" [description]="description">
      <form
        id="mt-send-invoice-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); save()"
      >
        <mt-text-field
          name="to"
          label="To"
          inputmode="email"
          description="Separate addresses with commas."
          [error]="toError() ?? undefined"
          [ngModel]="to()"
          (ngModelChange)="to.set($event ?? ''); touched.set(true)"
        />
        <mt-textarea
          name="message"
          label="Message"
          [optional]="true"
          [rows]="4"
          [maxLength]="messageMax"
          [ngModel]="message()"
          (ngModelChange)="message.set($event ?? '')"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-send-invoice-form">Send</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class SendInvoiceDialog {
  protected readonly ref = injectDialogRef<SendInvoiceDialogData, SendInvoiceDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly messageMax = INVOICE_MESSAGE_MAX;
  protected readonly description = `The PDF (${this.data.total}) goes as an attachment. Nothing is sent until you press Send.`;
  protected readonly to = signal(this.data.emails.join(', '));
  protected readonly message = signal('');
  protected readonly touched = signal(false);

  private readonly addresses = computed(() =>
    this.to()
      .split(/[,;\s]+/)
      .map((address) => address.trim())
      .filter(Boolean),
  );
  protected readonly toError = computed(() => {
    const addresses = this.addresses();
    if (!addresses.length) return this.touched() ? 'Add an email address.' : null;
    const bad = addresses.find((address) => !EMAIL.test(address));
    if (bad) return `“${bad}” isn’t an email address.`;
    if (addresses.length > INVOICE_SEND_MAX_RECIPIENTS)
      return `Send to up to ${INVOICE_SEND_MAX_RECIPIENTS} addresses.`;
    return null;
  });

  protected save(): void {
    this.touched.set(true);
    if (this.toError() || !this.addresses().length) return;
    void this.ref.close({ to: this.addresses(), message: this.message().trim() });
  }
}

export interface VoidInvoiceDialogData {
  number: string;
  total: string;
}

/** Voids an unpaid invoice (BILL-07) with a reason. Closes with the reason, or `undefined`. */
@Component({
  selector: 'mt-void-invoice-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextarea],
  template: `
    <mt-dialog size="sm" role="alertdialog" [title]="'Void invoice ' + data.number + '?'" [description]="description">
      <form id="mt-void-invoice-form" (submit)="$event.preventDefault(); save()">
        <mt-textarea
          name="reason"
          label="Reason"
          [rows]="2"
          [maxLength]="500"
          [error]="error() ?? undefined"
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event ?? ''); error.set(null)"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="danger" type="submit" form="mt-void-invoice-form">Void invoice</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class VoidInvoiceDialog {
  protected readonly ref = injectDialogRef<VoidInvoiceDialogData, string | undefined>();
  protected readonly data = this.ref.data;
  protected readonly description = `It keeps its number, marked void, and its ${this.data.total} of time and disbursements go back to work in progress.`;
  protected readonly reason = signal('');
  protected readonly error = signal<string | null>(null);

  protected save(): void {
    const reason = this.reason().trim();
    if (!reason) {
      this.error.set('Say why it’s being voided.');
      return;
    }
    void this.ref.close(reason);
  }
}

export interface CreditNoteDialogData {
  invoice: Pick<InvoiceItem, 'number' | 'lines' | 'gstRegistered'>;
  credited: readonly Pick<CreditNoteItem, 'lines'>[];
}

export interface CreditNoteDialogResult {
  full: boolean;
  lines: CreditLineInput[];
  reason: string;
}

type CreditMode = 'full' | 'lines';
const MODES: MtOption<CreditMode>[] = [
  { value: 'full', label: 'Everything left' },
  { value: 'lines', label: 'Choose lines' },
];

/**
 * Credits all or part of an issued invoice (BILL-07): everything left, or chosen lines (each in
 * full or by an amount ex GST). Previews the credit note's total with the domain's
 * `creditNoteLines`, which the server runs too. Closes with the request, or `undefined`.
 */
@Component({
  selector: 'mt-credit-note-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtNote, MtSegmentedControl, MtTextarea, MtTextField],
  template: `
    <mt-dialog size="md" [title]="'Credit invoice ' + data.invoice.number" [description]="description">
      <form
        id="mt-credit-note-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); save()"
      >
        <mt-segmented-control
          label="Credit"
          name="mode"
          [options]="modes"
          [ngModel]="mode()"
          (ngModelChange)="mode.set($event)"
        />
        @if (mode() === 'lines') {
          <ul
            class="mt-col"
            style="list-style: none; margin: 0; padding: 0; gap: var(--space-8)"
            data-testid="credit-lines"
          >
            @for (line of choices(); track line.index) {
              <li class="mt-row" style="gap: var(--space-8); align-items: flex-end; flex-wrap: wrap">
                <mt-checkbox
                  style="flex: 1 1 220px"
                  [label]="line.description"
                  [description]="formatAud(line.left) + ' left to credit'"
                  [ngModel]="picked().has(line.index)"
                  (ngModelChange)="pick(line.index, !!$event)"
                />
                @if (picked().has(line.index)) {
                  <mt-text-field
                    style="flex: 0 1 160px"
                    [name]="'credit-amount-' + line.index"
                    label="Amount ex GST"
                    inputmode="decimal"
                    [ngModel]="amounts()[line.index] ?? ''"
                    (ngModelChange)="setAmount(line.index, $event ?? '')"
                  />
                }
              </li>
            } @empty {
              <li class="caption t-3">Nothing is left to credit.</li>
            }
          </ul>
        }
        <mt-textarea
          name="reason"
          label="Reason"
          [rows]="2"
          [maxLength]="500"
          [error]="reasonError() ?? undefined"
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event ?? ''); touched.set(true)"
        />
        @if (preview(); as result) {
          @if (result.problem) {
            <mt-note tone="danger">{{ result.problem }}.</mt-note>
          } @else {
            <mt-note tone="info" data-testid="credit-preview">{{ previewText() }}</mt-note>
          }
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-credit-note-form" [disabled]="!request()">
          Issue credit note
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class CreditNoteDialog {
  protected readonly ref = injectDialogRef<CreditNoteDialogData, CreditNoteDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly modes = MODES;
  protected readonly formatAud = formatAud;
  protected readonly description =
    'A credit note reduces what the client owes and gets its own CN- number. The time and disbursements stay billed.';
  protected readonly mode = signal<CreditMode>('full');
  protected readonly picked = signal<ReadonlySet<number>>(new Set());
  protected readonly amounts = signal<Record<number, string>>({});
  protected readonly reason = signal('');
  protected readonly touched = signal(false);

  private readonly left = creditableLines(this.data.invoice, this.data.credited);
  protected readonly choices = computed(() =>
    this.data.invoice.lines.flatMap((line, index) => {
      const left = this.left[index]?.amountExGstCents ?? 0;
      return left > 0 ? [{ index, description: line.description, left }] : [];
    }),
  );

  /** The lines asked for, or `null` while an amount is mistyped. */
  private readonly asked = computed((): CreditLineInput[] | null => {
    const asked: CreditLineInput[] = [];
    for (const index of [...this.picked()].sort((a, b) => a - b)) {
      const text = this.amounts()[index] ?? '';
      const left = this.left[index]?.amountExGstCents ?? 0;
      const amount = parseDollars(text);
      if (amount === undefined || amount === 0) return null;
      asked.push(amount === null || amount === left ? { line: index } : { line: index, amountExGstCents: amount });
    }
    return asked;
  });

  protected readonly preview = computed(() => {
    if (this.mode() === 'full') return creditNoteLines(this.data.invoice, this.data.credited, { full: true });
    const asked = this.asked();
    if (asked === null) return { lines: [], problem: 'Enter each amount in dollars' };
    if (!asked.length) return null;
    return creditNoteLines(this.data.invoice, this.data.credited, { lines: asked });
  });
  protected readonly previewText = computed(() => {
    const totals = invoiceTotals(this.preview()?.lines ?? []);
    return this.data.invoice.gstRegistered === false
      ? `Credits ${formatAud(totals.totalCents)}.`
      : `Credits ${formatAud(totals.totalCents)} (${formatAud(totals.gstCents)} GST).`;
  });
  protected readonly reasonError = computed(() =>
    this.touched() && !this.reason().trim() ? 'Say why you’re crediting it.' : null,
  );

  protected readonly request = computed((): CreditNoteDialogResult | null => {
    const preview = this.preview();
    if (!preview || preview.problem || !preview.lines.length) return null;
    const reason = this.reason().trim();
    if (!reason) return null;
    return this.mode() === 'full'
      ? { full: true, lines: [], reason }
      : { full: false, lines: this.asked() ?? [], reason };
  });

  protected pick(index: number, on: boolean): void {
    this.picked.update((set) => {
      const next = new Set(set);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
    if (on && this.amounts()[index] === undefined) {
      this.setAmount(index, dollarsText(this.left[index]?.amountExGstCents ?? 0));
    }
  }

  protected setAmount(index: number, text: string): void {
    this.amounts.update((amounts) => ({ ...amounts, [index]: text }));
  }

  protected save(): void {
    this.touched.set(true);
    const request = this.request();
    if (request) void this.ref.close(request);
  }
}
