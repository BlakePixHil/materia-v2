import { ChangeDetectionStrategy, Component, computed, signal, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { INVOICES_QUERY, invoiceRepository, type InvoiceItem, type WithId } from '@materia/data-access/repository';
import { invoiceBalanceCents } from '@materia/domain';
import { formatAud, MtBadge, MtButton, MtEmptyState, MtNote, MtSegmentedControl, type MtOption } from '@materia/ui';

import {
  dateText,
  INVOICE_STATUS_TONES,
  invoiceName,
  invoiceStatusLabel,
  LIVE_INVOICE_STATUSES,
} from './invoices-view';
import { errorCopy } from '../../core/error-copy';
import { MtExportButton } from '../../core/exports/export-button';

type Filter = 'all' | 'draft' | 'live' | 'void';
const FILTERS: MtOption<Filter>[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Pre-bills' },
  { value: 'live', label: 'Issued' },
  { value: 'void', label: 'Void' },
];

/**
 * `/billing/invoices` (BILL-07, billing.view): pre-bills and invoices, newest first, filtered by
 * where they stand. A row opens the pre-bill or invoice. Pre-bills start from a matter's Time tab.
 */
@Component({
  selector: 'mt-invoices-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, RouterLink, MtBadge, MtButton, MtEmptyState, MtExportButton, MtNote, MtSegmentedControl],
  host: { class: 'mt-col mt-invoices-page' },
  template: `
    <div class="mt-row head">
      <h1 class="title-l">Invoices</h1>
      <span class="caption t-3" data-testid="invoices-summary">{{ summary() }}</span>
      <a mtButton variant="ghost" size="sm" class="mt-ml" routerLink="/billing/debtors">Aged debtors</a>
      <mt-export-button kind="invoices" [filters]="{ status: filter() }" />
      <mt-segmented-control
        label="Show"
        name="filter"
        [options]="filters"
        [ngModel]="filter()"
        (ngModelChange)="filter.set($event)"
      />
    </div>
    @switch (list.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading invoices…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ error() }}</mt-note>
      }
      @default {
        @if (rows().length) {
          <div class="table-wrap">
            <table data-testid="invoices">
              <caption class="mt-sr">
                Invoices and pre-bills
              </caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Matter</th>
                  <th scope="col">To</th>
                  <th scope="col">Issued</th>
                  <th scope="col">Due</th>
                  <th scope="col" class="num">Total</th>
                  <th scope="col" class="num">Owing</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.id) {
                  <tr [attr.data-status]="row.status">
                    <td>
                      <a class="label" [routerLink]="['/billing/invoices', row.id]">{{ name(row) }}</a>
                    </td>
                    <td>
                      {{ row.matterNumber ?? '' }}<span class="caption t-3 sub">{{ row.matterTitle ?? '' }}</span>
                    </td>
                    <td>{{ row.buyer?.name ?? '' }}</td>
                    <td class="date">{{ date(row.issueDate) }}</td>
                    <td class="date">{{ date(row.dueDate) }}</td>
                    <td class="num">{{ money(row.totalCents) }}</td>
                    <td class="num">{{ owing(row) }}</td>
                    <td>
                      <mt-badge [tone]="tone(row)">{{ status(row) }}</mt-badge>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (list.hasMore()) {
            <button mtButton size="sm" variant="ghost" [loading]="list.loadingMore()" (click)="list.loadMore()">
              Show more
            </button>
          }
        } @else {
          <mt-empty-state
            icon="billing"
            [title]="filter() === 'all' ? 'No invoices yet' : 'Nothing here'"
            description="Start a pre-bill from a matter’s Time tab: it gathers the matter’s approved, unbilled time and disbursements."
          />
        }
      }
    }
  `,
  styles: `
    .mt-invoices-page {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-invoices-page h1 {
      margin: 0;
    }
    .mt-invoices-page .head {
      align-items: center;
      gap: var(--space-8) var(--space-12);
      flex-wrap: wrap;
    }
    .mt-invoices-page .table-wrap {
      overflow-x: auto;
    }
    .mt-invoices-page table {
      width: 100%;
      border-collapse: collapse;
    }
    .mt-invoices-page th,
    .mt-invoices-page td {
      padding: var(--space-8);
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-invoices-page th {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-invoices-page .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .mt-invoices-page .date {
      white-space: nowrap;
    }
    .mt-invoices-page .sub {
      display: block;
    }
    .mt-invoices-page tr[data-status='void'] td {
      color: var(--text-tertiary);
    }
  `,
})
export class InvoicesPage {
  protected readonly list = invoiceRepository().watchQuery(INVOICES_QUERY);
  protected readonly filters = FILTERS;
  protected readonly filter = signal<Filter>('all');
  protected readonly error = computed(() => errorCopy(this.list.error()));

  protected readonly rows = computed(() => {
    const filter = this.filter();
    return this.list.value().filter((row) => {
      if (filter === 'all') return true;
      if (filter === 'live') return LIVE_INVOICE_STATUSES.has(row.status);
      return row.status === filter;
    });
  });
  protected readonly summary = computed(() => {
    const live = this.list.value().filter((row) => LIVE_INVOICE_STATUSES.has(row.status));
    const owing = live.reduce((sum, row) => sum + invoiceBalanceCents(row), 0);
    return live.length ? `${formatAud(owing)} owing on ${live.length} issued` : '';
  });

  protected name(row: InvoiceItem): string {
    return invoiceName(row);
  }

  protected status(row: InvoiceItem): string {
    return invoiceStatusLabel(row);
  }

  protected tone(row: InvoiceItem) {
    return INVOICE_STATUS_TONES[row.status] ?? 'neutral';
  }

  protected date(date: string | undefined): string {
    return dateText(date);
  }

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected owing(row: WithId<InvoiceItem>): string {
    return LIVE_INVOICE_STATUSES.has(row.status) ? formatAud(invoiceBalanceCents(row)) : '—';
  }
}
