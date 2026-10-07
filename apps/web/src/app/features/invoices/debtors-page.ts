import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  debtorsRepository,
  LATEST_DEBTORS_QUERY,
  MEMBER_LIST_QUERY,
  membersRepository,
  paymentCallables,
  PENDING_REMINDERS_QUERY,
  reminderRepository,
  type ReminderItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  AGED_BUCKET_LABELS,
  AGED_BUCKETS,
  debtorsByClient,
  debtorsCsv,
  emptyAged,
  reminderMessage,
  type AgedAmounts,
  type Cents,
  type DateOnly,
  type DebtorRow,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  MT_TODAY,
  MtButton,
  MtEmptyState,
  MtNote,
  MtSegmentedControl,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { dateText } from './invoices-view';
import { ReminderDialog, type ReminderDialogData, type ReminderDialogResult } from './reminder-dialog';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { downloadText } from '../billing/download';

type Whose = 'all' | 'mine';
const WHOSE: MtOption<Whose>[] = [
  { value: 'all', label: 'All matters' },
  { value: 'mine', label: 'My matters' },
];

/**
 * `/billing/debtors` (BILL-08, billing.view, flag `billing.invoicing`): the aged-debtors report,
 * what each client owes by matter, bucketed by days past due (`metrics/debtors-{date}`, kept by
 * the nightly rollup and worked out again here when it isn't today's), exported as CSV; and the
 * payment reminders waiting to be sent. Lawyers see the reminders for their own matters; nothing
 * goes until someone reviews it and presses Send.
 */
@Component({
  selector: 'mt-debtors-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, RouterLink, MtButton, MtEmptyState, MtNote, MtSegmentedControl],
  host: { class: 'mt-col mt-debtors-page' },
  template: `
    <div class="mt-row head">
      <h1 class="title-l">Aged debtors</h1>
      <span class="caption t-3" data-testid="debtors-as-of">{{ asOfText() }}</span>
      <span class="mt-row mt-ml actions">
        <mt-segmented-control
          label="Show"
          name="whose"
          [options]="whoseOptions"
          [ngModel]="whose()"
          (ngModelChange)="whose.set($event)"
        />
        <button mtButton variant="ghost" size="sm" iconStart="refresh" [loading]="refreshing()" (click)="refresh()">
          Refresh
        </button>
        <button
          mtButton
          variant="secondary"
          size="sm"
          iconStart="arrow-down"
          [disabled]="!rows().length"
          (click)="exportCsv()"
        >
          Export CSV
        </button>
      </span>
    </div>
    <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>

    <section class="mt-col" aria-labelledby="reminders-title">
      <h2 class="heading" id="reminders-title">Reminders to send</h2>
      <ul class="reminders" data-testid="reminders">
        @for (reminder of reminders(); track reminder.id) {
          <li class="mt-card mt-row reminder">
            <span class="mt-col">
              <a class="label" [routerLink]="['/billing/invoices', reminder.invoiceId]">{{ reminder.invoiceNumber }}</a>
              <span class="caption t-3"
                >{{ reminder.clientName || 'Client' }} · {{ reminder.matterNumber }} · {{ overdueText(reminder) }}</span
              >
            </span>
            <span class="num mt-ml">{{ money(reminder.balanceCents) }}</span>
            @if (canSend(reminder)) {
              <button mtButton variant="primary" size="sm" (click)="send(reminder)">Review and send</button>
              <button mtButton variant="ghost" size="sm" (click)="dismiss(reminder)">Dismiss</button>
            }
          </li>
        } @empty {
          <li class="caption t-3">No reminders waiting. Overdue invoices are queued here at 7, 30 and 60 days.</li>
        }
      </ul>
    </section>

    @switch (report.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading the report…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ error() }}</mt-note>
      }
      @default {
        @if (rows().length) {
          <div class="table-wrap">
            <table data-testid="debtors">
              <caption class="mt-sr">
                What each client owes, by matter and days past due
              </caption>
              <thead>
                <tr>
                  <th scope="col">Client and matter</th>
                  <th scope="col" class="num">Invoices</th>
                  @for (bucket of buckets; track bucket) {
                    <th scope="col" class="num">{{ labels[bucket] }}</th>
                  }
                  <th scope="col" class="num">Total</th>
                </tr>
              </thead>
              <tbody>
                @for (group of groups(); track group.clientName) {
                  <tr class="client" data-testid="debtor-client">
                    <th scope="rowgroup" class="label">{{ group.clientName || 'Unnamed client' }}</th>
                    <td></td>
                    @for (bucket of buckets; track bucket) {
                      <td class="num">{{ cell(group.buckets[bucket]) }}</td>
                    }
                    <td class="num label">{{ money(group.totalCents) }}</td>
                  </tr>
                  @for (row of group.rows; track row.matterId) {
                    <tr data-testid="debtor-matter">
                      <td class="matter">
                        <a [routerLink]="['/matters', row.matterId, 'time']">{{ row.matterNumber }}</a>
                        <span class="caption t-3">{{ row.matterTitle }}</span>
                      </td>
                      <td class="num">{{ row.invoices }}</td>
                      @for (bucket of buckets; track bucket) {
                        <td class="num">{{ cell(row.buckets[bucket]) }}</td>
                      }
                      <td class="num">{{ money(row.totalCents) }}</td>
                    </tr>
                  }
                }
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td></td>
                  @for (bucket of buckets; track bucket) {
                    <td class="num">{{ money(totals()[bucket]) }}</td>
                  }
                  <td class="num label" data-testid="debtors-total">{{ money(total()) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          @if (truncated()) {
            <mt-note tone="info">The report lists the first matters only; the totals count them all.</mt-note>
          }
        } @else if (!refreshing()) {
          <mt-empty-state
            icon="billing"
            title="No one owes anything"
            [description]="
              whose() === 'mine'
                ? 'None of your matters has an unpaid invoice.'
                : 'Every issued invoice is paid or credited.'
            "
          />
        }
      }
    }
  `,
  styles: `
    .mt-debtors-page {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-debtors-page h1,
    .mt-debtors-page h2 {
      margin: 0;
    }
    .mt-debtors-page .head,
    .mt-debtors-page .actions {
      align-items: center;
      gap: var(--space-8) var(--space-12);
      flex-wrap: wrap;
    }
    .mt-debtors-page .reminders {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-debtors-page .reminder {
      padding: var(--space-8) var(--space-12);
      gap: var(--space-8);
      align-items: center;
      flex-wrap: wrap;
    }
    .mt-debtors-page .table-wrap {
      overflow-x: auto;
    }
    .mt-debtors-page table {
      width: 100%;
      border-collapse: collapse;
    }
    .mt-debtors-page th,
    .mt-debtors-page td {
      padding: var(--space-8);
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-debtors-page thead th {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-debtors-page tr.client {
      background: var(--surface-sunken);
    }
    .mt-debtors-page .matter {
      padding-left: var(--space-20);
    }
    .mt-debtors-page .matter .caption {
      display: block;
    }
    .mt-debtors-page .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .mt-debtors-page tfoot th,
    .mt-debtors-page tfoot td {
      font-weight: 600;
      border-bottom: none;
    }
  `,
})
export class DebtorsPage {
  private readonly context = inject(OrgContext);
  private readonly today = inject(MT_TODAY);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly api = paymentCallables(inject(CALLABLES));
  private readonly canAll = can('billing.void');

  protected readonly report = debtorsRepository().watchQuery(LATEST_DEBTORS_QUERY);
  private readonly pending = reminderRepository().watchQuery(PENDING_REMINDERS_QUERY);
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });

  protected readonly buckets = AGED_BUCKETS;
  protected readonly labels = AGED_BUCKET_LABELS;
  protected readonly whoseOptions = WHOSE;
  protected readonly whose = signal<Whose>('all');
  protected readonly refreshing = signal(false);
  protected readonly announcement = signal('');
  protected readonly error = computed(() => errorCopy(this.report.error()));

  private readonly latest = computed(() => this.report.value()[0]?.debtors ?? null);
  protected readonly truncated = computed(() => this.latest()?.truncated ?? false);
  protected readonly rows = computed<DebtorRow[]>(() => {
    const rows = this.latest()?.rows ?? [];
    const me = this.context.uid();
    return this.whose() === 'mine' ? rows.filter((row) => row.lawyerUid === me) : rows;
  });
  protected readonly groups = computed(() => debtorsByClient(this.rows()));
  protected readonly totals = computed<AgedAmounts>(() => {
    const totals = emptyAged();
    for (const row of this.rows())
      for (const bucket of AGED_BUCKETS) totals[bucket] = (totals[bucket] + row.buckets[bucket]) as Cents;
    return totals;
  });
  protected readonly total = computed(() => AGED_BUCKETS.reduce((sum, bucket) => sum + this.totals()[bucket], 0));
  protected readonly asOfText = computed(() => {
    const asOf = this.latest()?.asOf;
    if (this.refreshing()) return 'Working it out…';
    return asOf ? `As of ${dateText(asOf)}` : '';
  });

  protected readonly reminders = computed(() => {
    const me = this.context.uid();
    const mine = this.whose() === 'mine' || !this.canAll();
    return this.pending
      .value()
      .filter((reminder) => !mine || reminder.lawyerUid === me)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  });

  constructor() {
    // Today's report: the nightly rollup's, or worked out now when the latest is older (once per visit).
    let asked = false;
    effect(() => {
      if (this.report.status() !== 'ready' || asked) return;
      const asOf = this.latest()?.asOf;
      if (asOf === this.today()) return;
      asked = true;
      untracked(() => void this.refresh(true));
    });
  }

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected cell(cents: number): string {
    return cents ? formatAud(cents) : '—';
  }

  protected overdueText(reminder: ReminderItem): string {
    return `over ${reminder.threshold} days overdue (due ${dateText(reminder.dueDate)})`;
  }

  protected canSend(reminder: ReminderItem): boolean {
    return this.canAll() || reminder.lawyerUid === this.context.uid();
  }

  protected async refresh(quiet = false): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.api.refreshDebtors();
      if (!quiet) this.announcement.set('Report refreshed.');
    } catch (error) {
      this.toasts.show({ title: 'The report wasn’t refreshed', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.refreshing.set(false);
    }
  }

  protected exportCsv(): void {
    const asOf = this.latest()?.asOf ?? this.today();
    const totals = { ...this.totals(), totalCents: this.total() as Cents };
    downloadText(
      `aged-debtors-${asOf}.csv`,
      debtorsCsv({ asOf: asOf as DateOnly, rows: this.rows(), totals }),
      'text/csv;charset=utf-8',
    );
  }

  protected async send(reminder: WithId<ReminderItem>): Promise<void> {
    const lawyer = this.members.value().find((member) => member.id === reminder.lawyerUid)?.displayName;
    const choice = await this.dialogs.open<ReminderDialogData, ReminderDialogResult | undefined>(ReminderDialog, {
      data: {
        number: reminder.invoiceNumber,
        owing: formatAud(reminder.balanceCents),
        emails: reminder.to,
        message: reminderMessage({
          clientName: reminder.clientName,
          invoiceNumber: reminder.invoiceNumber,
          balanceCents: reminder.balanceCents,
          dueDate: reminder.dueDate as DateOnly,
          threshold: reminder.threshold,
          lawyerName: lawyer,
        }),
      },
    }).result;
    if (!choice) return;
    try {
      const { sent } = await this.api.sendReminder({ reminderId: reminder.id, ...choice });
      this.toasts.show({
        title: `Reminder for ${reminder.invoiceNumber} sent to ${sent} ${sent === 1 ? 'address' : 'addresses'}`,
      });
    } catch (error) {
      this.toasts.show({ title: 'The reminder wasn’t sent', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async dismiss(reminder: WithId<ReminderItem>): Promise<void> {
    try {
      await this.api.dismissReminder({ reminderId: reminder.id });
      this.toasts.show({ title: `Reminder for ${reminder.invoiceNumber} dismissed` });
    } catch (error) {
      this.toasts.show({ title: 'The reminder wasn’t dismissed', description: errorCopy(error), tone: 'danger' });
    }
  }
}
