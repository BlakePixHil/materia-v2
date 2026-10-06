import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { invoiceRepository } from '@materia/data-access/repository';
import { MtButton, MtEmptyState, MtNote } from '@materia/ui';

import { InvoiceDetail } from './invoice-detail';
import { PreBill } from './pre-bill';
import { errorCopy } from '../../core/error-copy';

/**
 * `/billing/invoices/:id` (BILL-07): a pre-bill while it's a draft, then the issued invoice. The
 * document is live, so issuing a pre-bill turns this page into the invoice in place.
 */
@Component({
  selector: 'mt-invoice-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InvoiceDetail, MtButton, MtEmptyState, MtNote, PreBill],
  template: `
    @switch (doc.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading the invoice…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ error() }}</mt-note>
      }
      @default {
        @if (doc.value(); as invoice) {
          @if (invoice.status === 'draft') {
            <mt-pre-bill [invoice]="invoice" />
          } @else {
            <mt-invoice-detail [invoice]="invoice" />
          }
        } @else {
          <mt-empty-state
            icon="billing"
            title="No such invoice"
            description="It may have been a pre-bill that was deleted."
          >
            <a mtButton size="sm" routerLink="/billing/invoices">All invoices</a>
          </mt-empty-state>
        }
      }
    }
  `,
})
export class InvoicePage {
  private readonly params = toSignal(inject(ActivatedRoute).paramMap);
  private readonly id = computed(() => this.params()?.get('id') ?? null);
  protected readonly doc = invoiceRepository().watch(() => this.id());
  protected readonly error = computed(() => errorCopy(this.doc.error()));
}
