import { ChangeDetectionStrategy, Component, computed, inject, signal, ViewEncapsulation } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import { invoiceCallables, invoiceRepository, matterInvoicesQuery } from '@materia/data-access/repository';
import { invoiceBalanceCents } from '@materia/domain';
import { formatAud, MtBadge, MtButton, MtEmptyState, MtNote, ToastService } from '@materia/ui';

import {
  dateText,
  INVOICE_STATUS_TONES,
  invoiceName,
  invoiceStatusLabel,
  LIVE_INVOICE_STATUSES,
} from './invoices-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { MatterScreen } from '../matter-detail/matter-screen';

/**
 * A matter's bills (BILL-07), on its Time tab for billing.view roles while `billing.invoicing` is
 * on: its pre-bills and invoices, newest first, with what's owing. New pre-bill
 * (`billing-saveDraft`, lawyers and above) gathers the matter's approved, unbilled time and
 * disbursements and opens it, or opens the pre-bill already in progress.
 */
@Component({
  selector: 'mt-matter-bills',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MtBadge, MtButton, MtEmptyState, MtNote],
  host: { class: 'mt-matter-bills' },
  template: `
    <section class="mt-col" aria-labelledby="bills-title" data-testid="matter-bills">
      <div class="mt-row head">
        <h2 class="title-m" id="bills-title">Bills</h2>
        @if (owing(); as text) {
          <span class="caption t-3">{{ text }}</span>
        }
        @if (canIssue() && !screen.deleted()) {
          <button
            mtButton
            class="mt-ml"
            variant="secondary"
            size="sm"
            iconStart="plus"
            [loading]="starting()"
            (click)="startPreBill()"
          >
            {{ draft() ? 'Open pre-bill' : 'New pre-bill' }}
          </button>
        }
      </div>
      @switch (bills.status()) {
        @case ('loading') {
          <p class="caption t-3" role="status">Loading bills…</p>
        }
        @case ('error') {
          <mt-note tone="danger">{{ error() }}</mt-note>
        }
        @default {
          @if (bills.value().length) {
            <ul class="list">
              @for (bill of bills.value(); track bill.id) {
                <li class="mt-row bill" [attr.data-status]="bill.status">
                  <a class="label-m" [routerLink]="['/billing/invoices', bill.id]">{{ name(bill) }}</a>
                  <mt-badge [tone]="tone(bill.status)">{{ status(bill) }}</mt-badge>
                  <span class="caption t-3">{{ bill.issueDate ? date(bill.issueDate) : '' }}</span>
                  <span class="num mt-ml">{{ money(bill.totalCents) }}</span>
                </li>
              }
            </ul>
          } @else {
            <mt-empty-state
              icon="billing"
              title="No bills yet"
              description="A pre-bill gathers the approved, unbilled time and disbursements for review before it’s issued."
              [headingLevel]="3"
            />
          }
        }
      }
    </section>
  `,
  styles: `
    .mt-matter-bills {
      display: block;
      max-width: 1080px;
    }
    .mt-matter-bills > section {
      gap: var(--space-12);
    }
    .mt-matter-bills h2 {
      margin: 0;
    }
    .mt-matter-bills .head {
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-12);
    }
    .mt-matter-bills .list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .mt-matter-bills .bill {
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-8) 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-matter-bills .num {
      font-variant-numeric: tabular-nums;
    }
    .mt-matter-bills .bill[data-status='void'] .num {
      text-decoration: line-through;
      color: var(--text-tertiary);
    }
  `,
})
export class MatterBills {
  protected readonly screen = inject(MatterScreen);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly api = invoiceCallables(inject(CALLABLES));
  protected readonly canIssue = can('billing.issue');

  protected readonly bills = invoiceRepository().watchQuery(() => {
    const id = this.screen.id();
    return id ? matterInvoicesQuery(id) : null;
  });
  protected readonly error = computed(() => errorCopy(this.bills.error()));
  protected readonly draft = computed(() => this.bills.value().find((bill) => bill.status === 'draft') ?? null);
  protected readonly owing = computed(() => {
    const live = this.bills.value().filter((bill) => LIVE_INVOICE_STATUSES.has(bill.status));
    if (!live.length) return '';
    return `${formatAud(live.reduce((sum, bill) => sum + invoiceBalanceCents(bill), 0))} owing`;
  });
  protected readonly starting = signal(false);

  protected name(bill: Parameters<typeof invoiceName>[0]): string {
    return invoiceName(bill);
  }

  protected status(bill: Parameters<typeof invoiceStatusLabel>[0]): string {
    return invoiceStatusLabel(bill);
  }

  protected tone(status: string) {
    return INVOICE_STATUS_TONES[status] ?? 'neutral';
  }

  protected date(date: string): string {
    return dateText(date);
  }

  protected money(cents: number): string {
    return formatAud(cents);
  }

  /** Opens the pre-bill in progress, or starts one with every billable item. */
  protected async startPreBill(): Promise<void> {
    const matterId = this.screen.id();
    if (!matterId) return;
    const draft = this.draft();
    if (draft) {
      void this.router.navigate(['/billing/invoices', draft.id]);
      return;
    }
    this.starting.set(true);
    try {
      const { invoiceId } = await this.api.saveDraft({ matterId, fields: {} });
      void this.router.navigate(['/billing/invoices', invoiceId]);
    } catch (error) {
      this.toasts.show({ title: 'The pre-bill didn’t start', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.starting.set(false);
    }
  }
}
