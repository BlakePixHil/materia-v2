import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import {
  contactsRepository,
  creditNoteRepository,
  documentCallables,
  invoiceCallables,
  invoiceCreditNotesQuery,
  matterDetailRepository,
  type CreditNoteItem,
  type InvoiceItem,
  type WithId,
} from '@materia/data-access/repository';
import { creditableLines, invoiceBalanceCents, invoiceClientEmails, type InvoiceClientLike } from '@materia/domain';
import { DialogService, formatAud, MtBadge, MtButton, MtNote, ToastService } from '@materia/ui';

import {
  CreditNoteDialog,
  SendInvoiceDialog,
  VoidInvoiceDialog,
  type CreditNoteDialogData,
  type CreditNoteDialogResult,
  type SendInvoiceDialogData,
  type SendInvoiceDialogResult,
  type VoidInvoiceDialogData,
} from './invoice-dialogs';
import { dateText, INVOICE_STATUS_TONES, invoiceStatusLabel, LIVE_INVOICE_STATUSES } from './invoices-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { DOWNLOAD_NAVIGATOR } from '../documents/document-actions';
import { PdfViewer } from '../documents/pdf-viewer';

type CreditNote = WithId<CreditNoteItem>;

/**
 * An issued (or void) invoice (BILL-07): its PDF, the facts (to, dates, total, what's owed, when it
 * was emailed) and its credit notes. Lawyers and above download and email it (`billing-sendInvoice`:
 * to the clients by default; never automatic) and render a failed PDF again; owners and admins void
 * an unpaid one or credit it. When no client has an email address, sending is off and the PDF is
 * offered to print.
 */
@Component({
  selector: 'mt-invoice-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MtBadge, MtButton, MtNote, PdfViewer],
  host: { class: 'mt-col mt-invoice-detail' },
  template: `
    @let inv = invoice();
    <div class="mt-row head">
      <div class="mt-col">
        <div class="mt-row title-row">
          <h1 class="title-l">{{ title() }} {{ inv.number }}</h1>
          <mt-badge [tone]="tone()" data-testid="invoice-status">{{ statusLabel() }}</mt-badge>
        </div>
        <a class="caption" [routerLink]="['/matters', inv.matterId, 'time']">{{ matterLabel() }}</a>
      </div>
      <div class="mt-row mt-ml actions">
        @if (pdfReady()) {
          <button mtButton variant="ghost" size="sm" iconStart="arrow-down" (click)="download()">
            {{ emails().length ? 'Download PDF' : 'Download to print' }}
          </button>
        }
        @if (canIssue() && live()) {
          <button
            mtButton
            variant="primary"
            size="sm"
            iconStart="send"
            [disabled]="!pdfReady() || !emails().length"
            (click)="send()"
          >
            Email invoice
          </button>
        }
        @if (canVoid() && live()) {
          <button mtButton variant="secondary" size="sm" [disabled]="!creditable()" (click)="credit()">
            Credit note
          </button>
        }
        @if (canVoid() && voidable()) {
          <button mtButton variant="ghost" size="sm" (click)="voidIt()">Void</button>
        }
      </div>
    </div>
    <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>

    @if (inv.status === 'void') {
      <mt-note tone="warning" data-testid="invoice-void"
        >Void{{ inv.voidReason ? ': ' + inv.voidReason : '' }}. It keeps its number; its work went back to work in
        progress.</mt-note
      >
    }
    @if (live() && clientsLoaded() && !emails().length) {
      <mt-note tone="info" data-testid="invoice-no-email"
        >The client has no email address, so it can’t be emailed. Download the PDF to print and post it.</mt-note
      >
    }

    <div class="grid">
      <section class="mt-card pdf" aria-label="PDF">
        @switch (pdfState()) {
          @case ('ready') {
            @if (pdfUrl(); as url) {
              <mt-pdf-viewer [url]="url" [label]="title() + ' ' + inv.number" />
            } @else if (pdfError(); as message) {
              <mt-note tone="danger">{{ message }}</mt-note>
            } @else {
              <p class="caption t-3" role="status">Loading the PDF…</p>
            }
          }
          @case ('failed') {
            <mt-note tone="danger" data-testid="invoice-pdf-failed">
              The PDF couldn’t be made. The invoice is issued either way.
              @if (canIssue()) {
                <button mtButton size="sm" [loading]="retrying()" (click)="retry({ invoiceId: inv.id })">
                  Try again
                </button>
              }
            </mt-note>
          }
          @default {
            <p class="caption t-3" role="status" data-testid="invoice-pdf-pending">Preparing the PDF…</p>
          }
        }
      </section>

      <section class="mt-col facts" aria-label="Details">
        <dl class="mt-card">
          <div>
            <dt>To</dt>
            <dd>{{ inv.buyer?.name ?? '—' }}</dd>
          </div>
          <div>
            <dt>Issued</dt>
            <dd>{{ date(inv.issueDate) }}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{{ date(inv.dueDate) }}</dd>
          </div>
          <div>
            <dt>{{ gst() ? 'Total inc GST' : 'Total' }}</dt>
            <dd data-testid="invoice-total">{{ money(inv.totalCents) }}</dd>
          </div>
          @if (gst()) {
            <div>
              <dt>GST</dt>
              <dd>{{ money(inv.gstCents) }}</dd>
            </div>
          }
          @if (inv.creditedCents) {
            <div>
              <dt>Credited</dt>
              <dd>{{ money(inv.creditedCents) }}</dd>
            </div>
          }
          @if (live()) {
            <div class="owing">
              <dt>Owing</dt>
              <dd data-testid="invoice-owing">{{ money(balance()) }}</dd>
            </div>
          }
          <div>
            <dt>Emailed</dt>
            <dd data-testid="invoice-sent">{{ sentText() }}</dd>
          </div>
        </dl>

        <section class="mt-col" aria-labelledby="credit-notes-title">
          <h2 class="title-s" id="credit-notes-title">Credit notes</h2>
          <ul class="notes" data-testid="credit-notes">
            @for (note of creditNotes.value(); track note.id) {
              <li class="mt-card mt-col note">
                <div class="mt-row">
                  <span class="label-m">{{ note.number }}</span>
                  <span class="caption t-3">{{ date(note.issueDate) }}</span>
                  <span class="num mt-ml">{{ money(note.totalCents) }}</span>
                </div>
                <span class="caption t-3">{{ note.reason }}</span>
                @if (note.pdfStatus === 'ready' && note.pdfDocumentId) {
                  <button mtButton variant="ghost" size="sm" iconStart="arrow-down" (click)="downloadNote(note)">
                    Download PDF
                  </button>
                } @else if (note.pdfStatus === 'failed' && canIssue()) {
                  <button mtButton variant="ghost" size="sm" (click)="retry({ creditNoteId: note.id })">
                    Make the PDF again
                  </button>
                } @else {
                  <span class="caption t-3">Preparing the PDF…</span>
                }
              </li>
            } @empty {
              <li class="caption t-3">None.</li>
            }
          </ul>
        </section>
      </section>
    </div>
  `,
  styles: `
    .mt-invoice-detail {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-invoice-detail h1,
    .mt-invoice-detail h2 {
      margin: 0;
    }
    .mt-invoice-detail .head {
      align-items: flex-start;
      gap: var(--space-12);
      flex-wrap: wrap;
    }
    .mt-invoice-detail .title-row {
      align-items: center;
      gap: var(--space-8);
    }
    .mt-invoice-detail .actions {
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-invoice-detail .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.6fr) minmax(240px, 1fr);
      gap: var(--space-16);
      align-items: start;
    }
    .mt-invoice-detail .pdf {
      display: flex;
      flex-direction: column;
      min-height: 320px;
      padding: var(--space-12);
    }
    .mt-invoice-detail .facts {
      gap: var(--space-16);
    }
    .mt-invoice-detail dl {
      margin: 0;
      padding: var(--space-12) var(--space-16);
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .mt-invoice-detail dl > div {
      display: flex;
      justify-content: space-between;
      gap: var(--space-12);
    }
    .mt-invoice-detail dt {
      color: var(--text-secondary);
    }
    .mt-invoice-detail dd {
      margin: 0;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .mt-invoice-detail .owing {
      padding-top: var(--space-6);
      border-top: 1px solid var(--border-subtle);
      font-weight: 600;
    }
    .mt-invoice-detail .notes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-invoice-detail .note {
      padding: var(--space-8) var(--space-12);
      gap: var(--space-4);
      align-items: flex-start;
    }
    .mt-invoice-detail .note > .mt-row {
      align-self: stretch;
      gap: var(--space-8);
      align-items: baseline;
    }
    .mt-invoice-detail .num {
      font-variant-numeric: tabular-nums;
    }
    @media (max-width: 960px) {
      .mt-invoice-detail .grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class InvoiceDetail {
  readonly invoice = input.required<WithId<InvoiceItem>>();

  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly navigate = inject(DOWNLOAD_NAVIGATOR);
  private readonly api = invoiceCallables(inject(CALLABLES));
  private readonly documents = documentCallables(inject(CALLABLES));
  private readonly contacts = contactsRepository();
  protected readonly canIssue = can('billing.issue');
  protected readonly canVoid = can('billing.void');

  private readonly matter = matterDetailRepository().watch(() => this.invoice().matterId);
  protected readonly creditNotes = creditNoteRepository().watchQuery(() => invoiceCreditNotesQuery(this.invoice().id));

  protected readonly gst = computed(() => this.invoice().gstRegistered !== false);
  protected readonly title = computed(() => (this.gst() ? 'Tax invoice' : 'Invoice'));
  protected readonly statusLabel = computed(() => invoiceStatusLabel(this.invoice()));
  protected readonly tone = computed(() => INVOICE_STATUS_TONES[this.invoice().status] ?? 'neutral');
  protected readonly live = computed(() => LIVE_INVOICE_STATUSES.has(this.invoice().status));
  protected readonly voidable = computed(() => {
    const invoice = this.invoice();
    return invoice.status === 'issued' && !invoice.payments.length && !invoice.creditedCents;
  });
  protected readonly creditable = computed(() =>
    creditableLines(this.invoice(), this.creditNotes.value()).some((line) => line.amountExGstCents > 0),
  );
  protected readonly balance = computed(() => invoiceBalanceCents(this.invoice()));
  protected readonly matterLabel = computed(() => {
    const invoice = this.invoice();
    const matter = this.matter.value();
    const number = matter?.number ?? invoice.matterNumber;
    const title = matter?.title ?? invoice.matterTitle;
    return number ? `${number}${title ? ' · ' + title : ''}` : 'Matter';
  });
  protected readonly sentText = computed(() => {
    const invoice = this.invoice();
    if (!invoice.sentAt) return 'Not yet';
    const to = invoice.sentTo?.length ?? 0;
    return `${dateText(toIsoDate(invoice.sentAt))} to ${to} ${to === 1 ? 'address' : 'addresses'}`;
  });

  protected readonly pdfState = computed(() => {
    const invoice = this.invoice();
    if (invoice.pdfStatus === 'ready' && invoice.pdfDocumentId) return 'ready';
    return invoice.pdfStatus === 'failed' ? 'failed' : 'pending';
  });
  protected readonly pdfReady = computed(() => this.pdfState() === 'ready');
  protected readonly pdfUrl = signal<string | null>(null);
  protected readonly pdfError = signal<string | null>(null);
  protected readonly retrying = signal(false);
  protected readonly announcement = signal('');

  /** The clients, read once per matter: their email addresses are the default "To". */
  private readonly clients = signal<InvoiceClientLike[] | null>(null);
  protected readonly clientsLoaded = computed(() => this.clients() !== null);
  protected readonly emails = computed(() => invoiceClientEmails(this.clients() ?? []));

  constructor() {
    // The PDF's signed URL, once it's ready (again after a retry).
    effect(() => {
      const docId = this.pdfReady() ? this.invoice().pdfDocumentId : undefined;
      const matterId = this.invoice().matterId;
      untracked(() => {
        this.pdfUrl.set(null);
        this.pdfError.set(null);
        if (!docId) return;
        this.documents
          .getDownloadUrl({ matterId, docId })
          .then(({ url }) => this.pdfUrl.set(url))
          .catch((error: unknown) => this.pdfError.set(errorCopy(error)));
      });
    });
    let readFor: string | null = null;
    effect(() => {
      const ids = this.matter.value()?.clientContactIds;
      const matterId = this.invoice().matterId;
      if (!ids || readFor === matterId) return;
      readFor = matterId;
      untracked(() => {
        Promise.all(ids.map((id) => this.contacts.get(id).catch(() => null)))
          .then((found) => this.clients.set(found.filter((c) => c !== null) as InvoiceClientLike[]))
          .catch(() => this.clients.set([]));
      });
    });
  }

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected date(date: string | undefined): string {
    return dateText(date);
  }

  protected download(): void {
    const docId = this.invoice().pdfDocumentId;
    if (docId) void this.downloadDocument(docId);
  }

  protected downloadNote(note: CreditNote): void {
    if (note.pdfDocumentId) void this.downloadDocument(note.pdfDocumentId);
  }

  protected async send(): Promise<void> {
    const invoice = this.invoice();
    const choice = await this.dialogs.open<SendInvoiceDialogData, SendInvoiceDialogResult | undefined>(
      SendInvoiceDialog,
      { data: { number: invoice.number, total: formatAud(invoice.totalCents), emails: this.emails() } },
    ).result;
    if (!choice) return;
    try {
      const result = await this.api.send({ invoiceId: invoice.id, to: choice.to, message: choice.message });
      const n = result.sent;
      this.toasts.show({ title: `Invoice ${invoice.number} emailed to ${n} ${n === 1 ? 'address' : 'addresses'}` });
      this.announcement.set('Invoice emailed.');
    } catch (error) {
      this.toasts.show({ title: 'The invoice wasn’t emailed', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async voidIt(): Promise<void> {
    const invoice = this.invoice();
    const reason = await this.dialogs.open<VoidInvoiceDialogData, string | undefined>(VoidInvoiceDialog, {
      data: { number: invoice.number, total: formatAud(invoice.totalCents) },
    }).result;
    if (!reason) return;
    try {
      const result = await this.api.void({ invoiceId: invoice.id, reason });
      this.toasts.show({
        title: `Invoice ${invoice.number} voided`,
        description: `${result.released} ${result.released === 1 ? 'item is' : 'items are'} back in work in progress.`,
      });
    } catch (error) {
      this.toasts.show({ title: 'The invoice wasn’t voided', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async credit(): Promise<void> {
    const invoice = this.invoice();
    const request = await this.dialogs.open<CreditNoteDialogData, CreditNoteDialogResult | undefined>(
      CreditNoteDialog,
      { data: { invoice, credited: this.creditNotes.value() } },
    ).result;
    if (!request) return;
    try {
      const result = await this.api.createCreditNote({ invoiceId: invoice.id, ...request });
      this.toasts.show({ title: `Credit note ${result.number} issued`, description: formatAud(result.totalCents) });
    } catch (error) {
      this.toasts.show({ title: 'The credit note wasn’t issued', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async retry(target: { invoiceId: string } | { creditNoteId: string }): Promise<void> {
    this.retrying.set(true);
    try {
      await this.api.retryPdf(target);
      this.announcement.set('Making the PDF again.');
    } catch (error) {
      this.toasts.show({ title: 'The PDF didn’t start', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.retrying.set(false);
    }
  }

  private async downloadDocument(docId: string): Promise<void> {
    try {
      const { url } = await this.documents.getDownloadUrl({ matterId: this.invoice().matterId, docId });
      this.navigate(url);
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t download the PDF', description: errorCopy(error), tone: 'danger' });
    }
  }
}

/** An instant as its date (the browser's day; the list shows dates, not times). */
function toIsoDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
