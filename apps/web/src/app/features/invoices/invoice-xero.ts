import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { xeroCallables, type InvoiceItem, type WithId } from '@materia/data-access/repository';
import {
  XERO_SYNC_ERROR_COPY,
  xeroDocumentUrl,
  xeroSyncLabel,
  type XeroSettings,
  type XeroSync,
} from '@materia/domain';
import { formatAud, MtBadge, MtButton, MtIcon, MtNote, ToastService, type MtBadgeTone } from '@materia/ui';

import { dateText, LIVE_INVOICE_STATUSES } from './invoices-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';

/**
 * A document's Xero copy in the chosen Xero organisation (BILL-09): one sent to another
 * organisation counts as not sent there, as the server counts it. A queued send may not name its
 * organisation yet.
 */
export function xeroSyncIn(
  sync: XeroSync | null | undefined,
  settings: Pick<XeroSettings, 'tenantId'> | null | undefined,
): XeroSync | null {
  if (!sync || !settings) return null;
  return !sync.tenantId || sync.tenantId === settings.tenantId ? sync : null;
}

const XERO_TONES: Record<XeroSync['status'], MtBadgeTone> = {
  synced: 'success',
  queued: 'info',
  failed: 'danger',
  conflict: 'danger',
};

/** "A payment of the same amount was recorded here within a week." (BILL-09). */
export const POSSIBLE_DUPLICATE_COPY =
  'A payment of the same amount was recorded here within a week. Check it isn’t counted twice.';

/**
 * An invoice's or credit note's place in Xero (BILL-09): "In Xero", "Sending to Xero", "Not in
 * Xero" or "Not sent to Xero", and once it's there a link that opens it in Xero in a new tab.
 */
@Component({
  selector: 'mt-xero-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtBadge, MtIcon],
  template: `
    <mt-badge [tone]="tone()" [attr.data-xero]="sync()?.status ?? 'none'">{{ label() }}</mt-badge>
    @if (url(); as href) {
      <a class="caption" [href]="href" target="_blank" rel="noopener noreferrer" aria-label="Open in Xero, in a new tab"
        >Open in Xero<mt-icon name="external" [size]="14"
      /></a>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--space-6, 6px);
    }
    a {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4, 4px);
    }
  `,
})
export class XeroChip {
  readonly sync = input<XeroSync | null>(null);
  readonly kind = input<'invoice' | 'creditNote'>('invoice');

  protected readonly label = computed(() => xeroSyncLabel(this.sync()));
  protected readonly tone = computed<MtBadgeTone>(() => {
    const status = this.sync()?.status;
    return status ? XERO_TONES[status] : 'neutral';
  });
  protected readonly url = computed(() => {
    const sync = this.sync();
    return sync?.status === 'synced' && sync.id ? xeroDocumentUrl(this.kind(), sync.id) : null;
  });
}

/**
 * What an invoice needs from someone about Xero (BILL-09): why it isn't there (with "Try again"),
 * "Send to Xero" for an issued invoice never sent, and payments made in Xero that couldn't be
 * recorded here. Sending is `billing.issue`'s (`xero-send`).
 */
@Component({
  selector: 'mt-invoice-xero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtNeedsConnection, MtNote],
  template: `
    @let state = sync();
    @if (state?.status === 'failed' || state?.status === 'conflict') {
      <mt-note tone="danger" data-testid="invoice-xero-error">
        Not in Xero. {{ problem() }}
        @if (canSend()) {
          <button mtButton mtNeedsConnection variant="secondary" size="sm" [loading]="sending()" (click)="send()">
            Try again
          </button>
        }
      </mt-note>
    } @else if (!state && unsentLive() && canSend()) {
      <mt-note data-testid="invoice-xero-unsent">
        This invoice isn’t in Xero.
        <button mtButton mtNeedsConnection variant="secondary" size="sm" [loading]="sending()" (click)="send()">
          Send to Xero
        </button>
      </mt-note>
    }
    @if (unrecorded().length) {
      <mt-note tone="warning" data-testid="invoice-xero-unrecorded">
        <strong>Payments in Xero not recorded here</strong>
        <ul>
          @for (payment of unrecorded(); track payment.id) {
            <li>{{ date(payment.date) }} · {{ money(payment.amountCents) }} · {{ payment.reason }}</li>
          }
        </ul>
      </mt-note>
    }
    <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>
  `,
  styles: `
    /* Its notes sit in the invoice's own column, like the invoice's other notes. */
    :host {
      display: contents;
    }
    mt-note button {
      display: flex;
      margin-top: var(--space-8, 8px);
    }
    ul {
      margin: var(--space-4, 4px) 0 0;
      padding-left: var(--space-16, 16px);
    }
  `,
})
export class InvoiceXero {
  readonly invoice = input.required<WithId<InvoiceItem>>();
  /** Its copy in the chosen Xero organisation ({@link xeroSyncIn}). */
  readonly sync = input<XeroSync | null>(null);
  readonly canSend = input(false);

  private readonly api = xeroCallables(inject(CALLABLES));
  private readonly toasts = inject(ToastService);
  protected readonly sending = signal(false);
  protected readonly announcement = signal('');

  /** Issued (not void) and never sent: "Send to Xero". */
  protected readonly unsentLive = computed(() => LIVE_INVOICE_STATUSES.has(this.invoice().status));
  /** The server's sentence (Xero's own reason included), else the copy for its code. */
  protected readonly problem = computed(() => {
    const error = this.sync()?.error;
    if (!error) return this.sync()?.status === 'conflict' ? XERO_SYNC_ERROR_COPY.number_taken : '';
    return error.message || XERO_SYNC_ERROR_COPY[error.code];
  });
  protected readonly unrecorded = computed(() => this.sync()?.unrecordedPayments ?? []);

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected date(date: string): string {
    return dateText(date);
  }

  protected async send(): Promise<void> {
    if (this.sending()) return;
    const invoice = this.invoice();
    this.sending.set(true);
    try {
      await this.api.send({ invoiceId: invoice.id });
      this.toasts.show({ title: `Sending invoice ${invoice.number} to Xero` });
      this.announcement.set('Sending to Xero.');
    } catch (error) {
      this.toasts.show({ title: 'It wasn’t sent to Xero', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.sending.set(false);
    }
  }
}
