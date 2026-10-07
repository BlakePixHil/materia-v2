import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  creditNoteRepository,
  forMatter,
  invoiceCallables,
  invoiceRepository,
  MATTER_DISBURSEMENTS_QUERY,
  MATTER_TIME_QUERY,
  matterDetailRepository,
  matterDisbursementRepository,
  matterInvoicesQuery,
  matterTimeRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  orgSettingsReadRepository,
  timeCallables,
  type InvoiceItem,
  type OrgSettings,
  type WithId,
} from '@materia/data-access/repository';
import {
  buildInvoice,
  draftChanges,
  INVOICE_EXTRA_LINES_MAX,
  INVOICE_NOTES_MAX,
  INVOICE_WARNING_COPY,
  PAID_FROM_TRUST_COPY,
  unitsToHours,
  type DateOnly,
  type InvoiceDraftFieldsInput,
  type InvoiceEntryLike,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  MT_TODAY,
  MtBadge,
  MtButton,
  MtCheckbox,
  MtEmptyState,
  MtIconButton,
  MtNote,
  MtSegmentedControl,
  MtTextarea,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { dateText, extraLineForm, extraLinesFrom, invoiceSourcesFrom, type ExtraLineForm } from './invoices-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';
import { writeDownTime } from '../billing/write-down';
import { formatEntryDate, parseEntryDate } from '../time/time-view';

/** What the pre-bill form holds: the choices, as typed. */
interface PreBillForm {
  from: string;
  to: string;
  grouping: 'itemised' | 'summary';
  excludedTimeEntryIds: string[];
  excludedDisbursementIds: string[];
  extraLines: ExtraLineForm[];
  notes: string;
  paymentTermsDays: string;
  paidFromTrust: boolean;
}

function formOf(invoice: InvoiceItem): PreBillForm {
  return {
    from: invoice.from ? formatEntryDate(invoice.from) : '',
    to: invoice.to ? formatEntryDate(invoice.to) : '',
    grouping: invoice.grouping,
    excludedTimeEntryIds: [...invoice.excludedTimeEntryIds],
    excludedDisbursementIds: [...invoice.excludedDisbursementIds],
    extraLines: invoice.extraLines.map(extraLineForm),
    notes: invoice.notes,
    paymentTermsDays: String(invoice.paymentTermsDays),
    paidFromTrust: invoice.paidFromTrust === true,
  };
}

/** The saved choices, as `buildInvoice` takes them. */
function savedFields(invoice: InvoiceItem): InvoiceDraftFieldsInput {
  return {
    ...(invoice.from ? { from: invoice.from } : {}),
    ...(invoice.to ? { to: invoice.to } : {}),
    grouping: invoice.grouping,
    excludedTimeEntryIds: invoice.excludedTimeEntryIds,
    excludedDisbursementIds: invoice.excludedDisbursementIds,
    extraLines: invoice.extraLines,
    notes: invoice.notes,
    paymentTermsDays: invoice.paymentTermsDays,
    paidFromTrust: invoice.paidFromTrust === true,
  };
}

const GROUPINGS: MtOption<'itemised' | 'summary'>[] = [
  { value: 'itemised', label: 'Itemised' },
  { value: 'summary', label: 'Summary' },
];

/**
 * A pre-bill (BILL-07): the choices on the left (dates, the time and disbursements to include, the
 * grouping, fixed fees and discounts, notes and payment terms) and a live preview of the invoice
 * on the right, built in the browser by `buildInvoice` from the same sources the server reads.
 * Items that changed since the pre-bill was saved are marked. Save stores the choices (the server
 * builds the lines); Issue saves them if needed, then issues it (`billing-issueInvoice`), which
 * numbers and freezes it. Delete removes the pre-bill.
 */
@Component({
  selector: 'mt-pre-bill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    RouterLink,
    MtBadge,
    MtButton,
    MtCheckbox,
    MtEmptyState,
    MtIconButton,
    MtNeedsConnection,
    MtNote,
    MtSegmentedControl,
    MtTextarea,
    MtTextField,
  ],
  host: { class: 'mt-col mt-pre-bill' },
  template: `
    <div class="mt-row head">
      <div class="mt-col">
        <h1 class="title-l">Pre-bill</h1>
        <a class="caption" [routerLink]="['/matters', matterId(), 'time']" data-testid="pre-bill-matter">{{
          matterLabel()
        }}</a>
      </div>
      <div class="mt-row mt-ml actions">
        @if (canIssue()) {
          <button mtButton variant="ghost" size="sm" iconStart="trash" (click)="remove()">Delete</button>
          <button
            mtButton
            variant="secondary"
            size="sm"
            [loading]="saving()"
            [disabled]="!dirty() || !!formError()"
            (click)="save()"
          >
            Save
          </button>
          <button
            mtButton
            mtNeedsConnection
            variant="primary"
            size="sm"
            [loading]="issuing()"
            [disabled]="!issuable()"
            (click)="issue()"
          >
            Issue invoice
          </button>
        }
      </div>
    </div>
    <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>
    @if (changes().stale && !dirty()) {
      <mt-note tone="warning" data-testid="pre-bill-changed">
        Some time or disbursements changed since this pre-bill was saved. The preview shows them as they are now; saving
        or issuing uses them.
      </mt-note>
    }

    <div class="grid">
      <section class="mt-col choices" aria-label="What to bill">
        <div class="mt-row dates">
          <mt-text-field
            name="from"
            label="From"
            placeholder="DD/MM/YYYY"
            [optional]="true"
            [error]="fromError() ?? undefined"
            [ngModel]="form().from"
            (ngModelChange)="patch({ from: $event ?? '' })"
          />
          <mt-text-field
            name="to"
            label="To"
            placeholder="DD/MM/YYYY"
            [optional]="true"
            [error]="toError() ?? undefined"
            [ngModel]="form().to"
            (ngModelChange)="patch({ to: $event ?? '' })"
          />
        </div>
        <mt-segmented-control
          label="Professional fees"
          name="grouping"
          [options]="groupings"
          [ngModel]="form().grouping"
          (ngModelChange)="patch({ grouping: $event })"
        />
        <p class="caption t-3 hint">
          {{
            form().grouping === 'summary'
              ? 'One professional fees line, with each entry in a schedule.'
              : 'A line for each time entry.'
          }}
        </p>

        <section class="mt-col block" aria-labelledby="pb-time">
          <div class="mt-row block-head">
            <h2 class="heading" id="pb-time">Time</h2>
            <span class="caption t-3 mt-ml">{{ build().available.entries.length }} billable</span>
          </div>
          @if (build().unapprovedEntries) {
            <mt-note tone="info"
              >{{ build().unapprovedEntries }}
              {{ build().unapprovedEntries === 1 ? 'entry in these dates isn’t' : 'entries in these dates aren’t' }}
              approved yet, so {{ build().unapprovedEntries === 1 ? 'it isn’t' : 'they aren’t' }} on this bill.</mt-note
            >
          }
          <ul class="items" data-testid="pre-bill-time">
            @for (entry of build().available.entries; track entry.id) {
              <li class="mt-row item">
                <mt-checkbox
                  [label]="entry.narrative || 'Time'"
                  [description]="entryMeta(entry)"
                  [ngModel]="!form().excludedTimeEntryIds.includes(entry.id)"
                  (ngModelChange)="toggle('excludedTimeEntryIds', entry.id, !!$event)"
                />
                @if (changes().changed.includes(entry.id)) {
                  <mt-badge tone="warning">Changed since added</mt-badge>
                } @else if (changes().added.includes(entry.id)) {
                  <mt-badge tone="info">New</mt-badge>
                }
                <span class="num mt-ml">{{ money(entry.amountCents) }}</span>
                @if (canWriteDown()) {
                  <button
                    mtIconButton
                    icon="minus"
                    size="sm"
                    [label]="'Write down or off: ' + (entry.narrative || 'this entry')"
                    [disabled]="writingDown()"
                    (click)="writeDown(entry.id)"
                  ></button>
                }
              </li>
            } @empty {
              <li class="caption t-3">No approved, unbilled time in these dates.</li>
            }
          </ul>
        </section>

        <section class="mt-col block" aria-labelledby="pb-disbursements">
          <div class="mt-row block-head">
            <h2 class="heading" id="pb-disbursements">Disbursements</h2>
            <span class="caption t-3 mt-ml">{{ build().available.disbursements.length }} unbilled</span>
          </div>
          <ul class="items" data-testid="pre-bill-disbursements">
            @for (item of build().available.disbursements; track item.id) {
              <li class="mt-row item">
                <mt-checkbox
                  [label]="item.description"
                  [description]="date(item.date) + (item.payee ? ' · ' + item.payee : '')"
                  [ngModel]="!form().excludedDisbursementIds.includes(item.id)"
                  (ngModelChange)="toggle('excludedDisbursementIds', item.id, !!$event)"
                />
                @if (changes().changed.includes(item.id)) {
                  <mt-badge tone="warning">Changed since added</mt-badge>
                } @else if (changes().added.includes(item.id)) {
                  <mt-badge tone="info">New</mt-badge>
                }
                <span class="num mt-ml">{{ money(item.amountExGstCents + item.gstCents) }}</span>
              </li>
            } @empty {
              <li class="caption t-3">No unbilled disbursements in these dates.</li>
            }
          </ul>
        </section>

        <section class="mt-col block" aria-labelledby="pb-extra">
          <h2 class="heading" id="pb-extra">Fixed fees and discounts</h2>
          @for (line of form().extraLines; track $index; let i = $index) {
            <div class="mt-row extra" [attr.data-kind]="line.kind">
              <mt-text-field
                class="grow"
                [name]="'extra-description-' + i"
                [label]="line.kind === 'fixed_fee' ? 'Fixed fee' : 'Discount'"
                [ngModel]="line.description"
                (ngModelChange)="patchLine(i, { description: $event ?? '' })"
              />
              <mt-text-field
                class="amount"
                [name]="'extra-amount-' + i"
                label="Amount ex GST"
                inputmode="decimal"
                [ngModel]="line.amount"
                (ngModelChange)="patchLine(i, { amount: $event ?? '' })"
              />
              <mt-checkbox
                label="GST-free"
                [ngModel]="line.gstFree"
                (ngModelChange)="patchLine(i, { gstFree: !!$event })"
              />
              <button
                mtIconButton
                icon="trash"
                size="sm"
                [label]="'Remove ' + (line.description || (line.kind === 'fixed_fee' ? 'fixed fee' : 'discount'))"
                (click)="removeLine(i)"
              ></button>
            </div>
          }
          @if (extraError(); as message) {
            <p class="caption t-danger" role="alert">{{ message }}</p>
          }
          @if (form().extraLines.length < extraMax) {
            <div class="mt-row">
              <button mtButton variant="secondary" size="sm" iconStart="plus" (click)="addLine('fixed_fee')">
                Add fixed fee
              </button>
              <button mtButton variant="ghost" size="sm" iconStart="plus" (click)="addLine('discount')">
                Add discount
              </button>
            </div>
          }
        </section>

        <mt-textarea
          name="notes"
          label="Notes on the invoice"
          [optional]="true"
          [rows]="3"
          [maxLength]="notesMax"
          [ngModel]="form().notes"
          (ngModelChange)="patch({ notes: $event ?? '' })"
        />
        <mt-text-field
          class="terms"
          name="terms"
          label="Payment terms"
          suffix="days"
          inputmode="numeric"
          [error]="termsError() ?? undefined"
          [ngModel]="form().paymentTermsDays"
          (ngModelChange)="patch({ paymentTermsDays: $event ?? '' })"
        />
        <mt-checkbox
          name="paidFromTrust"
          label="To be paid from trust"
          [description]="trustCopy"
          [ngModel]="form().paidFromTrust"
          (ngModelChange)="patch({ paidFromTrust: !!$event })"
        />
      </section>

      <section class="mt-card preview" aria-labelledby="pb-preview" data-testid="pre-bill-preview">
        <div class="mt-row preview-head">
          <h2 class="title-m" id="pb-preview">{{ gstRegistered() ? 'Tax invoice' : 'Invoice' }}</h2>
          <span class="caption t-3 mt-ml">Preview</span>
        </div>
        @for (warning of warnings(); track warning) {
          <mt-note tone="warning" [attr.data-warning]="warning">{{ warningCopy[warning] }}</mt-note>
        }
        @if (problem(); as message) {
          <mt-note tone="danger" data-testid="pre-bill-problem">{{ message }}.</mt-note>
        }
        @if (build().lines.length) {
          <div class="table-wrap">
            <table>
              <caption class="mt-sr">
                Invoice lines
              </caption>
              <thead>
                <tr>
                  <th scope="col">Description</th>
                  <th scope="col" class="num">Qty</th>
                  <th scope="col" class="num">{{ gstRegistered() ? 'Ex GST' : 'Amount' }}</th>
                  @if (gstRegistered()) {
                    <th scope="col" class="num">GST</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (line of build().lines; track $index) {
                  <tr [attr.data-kind]="line.kind">
                    <td>
                      <span>{{ line.description }}{{ line.gstFree ? ' *' : '' }}</span>
                      @if (line.date || line.by) {
                        <span class="caption t-3 sub">{{ lineMeta(line.date, line.by) }}</span>
                      }
                    </td>
                    <td class="num">{{ line.kind === 'time' ? line.quantity.toFixed(2) + ' h' : line.quantity }}</td>
                    <td class="num">{{ money(line.amountExGstCents) }}</td>
                    @if (gstRegistered()) {
                      <td class="num">{{ money(line.gstCents) }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <mt-empty-state
            icon="billing"
            title="Nothing to bill yet"
            description="Include time or disbursements, or add a fixed fee."
            [headingLevel]="3"
          />
        }
        <dl class="totals" data-testid="pre-bill-totals">
          @if (gstRegistered()) {
            <div class="mt-row">
              <dt>Subtotal ex GST</dt>
              <dd>{{ money(build().subtotalCents) }}</dd>
            </div>
            <div class="mt-row">
              <dt>GST</dt>
              <dd>{{ money(build().gstCents) }}</dd>
            </div>
          }
          <div class="mt-row grand">
            <dt>{{ gstRegistered() ? 'Total inc GST' : 'Total' }}</dt>
            <dd data-testid="pre-bill-total">{{ money(build().totalCents) }}</dd>
          </div>
        </dl>
        @if (build().itemisation?.length) {
          <details class="schedule">
            <summary class="caption">Schedule of professional fees ({{ build().itemisation?.length }})</summary>
            <ul class="items">
              @for (item of build().itemisation; track item.refId) {
                <li class="mt-row item caption">
                  <span>{{ date(item.date) }} · {{ item.description }}</span>
                  <span class="num mt-ml">{{ item.hours.toFixed(2) }} h · {{ money(item.amountExGstCents) }}</span>
                </li>
              }
            </ul>
          </details>
        }
        <p class="caption t-3">
          Due {{ termsText() }} after it’s issued. Rounding: GST is worked out on each line, to the nearest cent (half
          up), then added up.
        </p>
        @if (form().paidFromTrust) {
          <p class="caption t-3" data-testid="pre-bill-trust">
            To be paid from trust.
            {{
              trustNoticeOn()
                ? 'The notice of intended withdrawal prints on the invoice.'
                : 'No withdrawal notice prints until the wording is approved.'
            }}
          </p>
        }
      </section>
    </div>
  `,
  styles: `
    .mt-pre-bill {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-pre-bill h1,
    .mt-pre-bill h2 {
      margin: 0;
    }
    .mt-pre-bill .head {
      align-items: flex-start;
      gap: var(--space-12);
      flex-wrap: wrap;
    }
    .mt-pre-bill .actions {
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-pre-bill .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
      gap: var(--space-16);
      align-items: start;
    }
    .mt-pre-bill .choices {
      gap: var(--space-12);
    }
    .mt-pre-bill .dates {
      gap: var(--space-12);
      flex-wrap: wrap;
    }
    .mt-pre-bill .dates > * {
      flex: 1 1 140px;
    }
    .mt-pre-bill .hint {
      margin: calc(-1 * var(--space-8)) 0 0;
    }
    .mt-pre-bill .block {
      gap: var(--space-8);
      padding-top: var(--space-8);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-pre-bill .block-head {
      align-items: baseline;
    }
    .mt-pre-bill .items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .mt-pre-bill .item {
      align-items: flex-start;
      gap: var(--space-8);
    }
    .mt-pre-bill .item mt-checkbox {
      min-width: 0;
      flex: 0 1 auto;
    }
    .mt-pre-bill .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .mt-pre-bill .extra {
      gap: var(--space-8);
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .mt-pre-bill .extra .grow {
      flex: 1 1 200px;
    }
    .mt-pre-bill .extra .amount {
      flex: 0 1 140px;
    }
    .mt-pre-bill .terms {
      max-width: 200px;
    }
    .mt-pre-bill .preview {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
      position: sticky;
      top: var(--space-16);
    }
    .mt-pre-bill .preview-head {
      align-items: baseline;
    }
    .mt-pre-bill .table-wrap {
      overflow-x: auto;
    }
    .mt-pre-bill table {
      width: 100%;
      border-collapse: collapse;
    }
    .mt-pre-bill th,
    .mt-pre-bill td {
      padding: var(--space-6) var(--space-8);
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-pre-bill th {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-pre-bill th.num,
    .mt-pre-bill td.num {
      text-align: right;
    }
    .mt-pre-bill tr[data-kind='adjustment'] td {
      color: var(--text-secondary);
    }
    .mt-pre-bill .sub {
      display: block;
    }
    .mt-pre-bill .totals {
      margin: 0 0 0 auto;
      min-width: 240px;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-pre-bill .totals .mt-row {
      justify-content: space-between;
      gap: var(--space-16);
    }
    .mt-pre-bill .totals dt {
      color: var(--text-secondary);
    }
    .mt-pre-bill .totals dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .mt-pre-bill .totals .grand {
      padding-top: var(--space-6);
      border-top: 1px solid var(--border-strong, var(--border-subtle));
      font-weight: 600;
    }
    .mt-pre-bill .totals .grand dt {
      color: var(--text-primary);
    }
    .mt-pre-bill .schedule summary {
      cursor: pointer;
    }
    .mt-pre-bill .schedule .items {
      margin-top: var(--space-8);
    }
    @media (max-width: 960px) {
      .mt-pre-bill .grid {
        grid-template-columns: minmax(0, 1fr);
      }
      .mt-pre-bill .preview {
        position: static;
      }
    }
  `,
})
export class PreBill {
  readonly invoice = input.required<WithId<InvoiceItem>>();

  private readonly context = inject(OrgContext);
  private readonly flags = inject(FeatureFlagService);
  private readonly router = inject(Router);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly today = inject(MT_TODAY);
  private readonly api = invoiceCallables(inject(CALLABLES));
  private readonly timeApi = timeCallables(inject(CALLABLES));
  /** Approvers write time down or off from the pre-bill (BILL-07b); the preview follows the entry. */
  protected readonly canWriteDown = can('time.approve');
  protected readonly writingDown = signal(false);
  protected readonly canIssue = can('billing.issue');
  protected readonly groupings = GROUPINGS;
  protected readonly warningCopy = INVOICE_WARNING_COPY;
  protected readonly extraMax = INVOICE_EXTRA_LINES_MAX;
  protected readonly notesMax = INVOICE_NOTES_MAX;
  protected readonly trustCopy = PAID_FROM_TRUST_COPY;
  protected readonly trustNoticeOn = computed(() => this.flags.isOn('billing.trustNotice'));

  protected readonly matterId = computed(() => this.invoice().matterId);
  private readonly matter = matterDetailRepository().watch(() => this.matterId());
  private readonly entries = matterTimeRepository(this.matterId).watchQuery(
    forMatter(this.matterId, MATTER_TIME_QUERY),
  );
  private readonly disbursements = matterDisbursementRepository(this.matterId).watchQuery(
    forMatter(this.matterId, MATTER_DISBURSEMENTS_QUERY),
  );
  private readonly invoices = invoiceRepository().watchQuery(() => matterInvoicesQuery(this.matterId()));
  private readonly creditNotes = creditNoteRepository().watchQuery(() => ({
    where: [['matterId', '==', this.matterId()]],
    pageSize: 200,
  }));
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  private readonly org = signal<OrgSettings | null>(null);

  protected readonly gstRegistered = computed(() => this.org()?.billing?.gstRegistered !== false);
  protected readonly matterLabel = computed(() => {
    const matter = this.matter.value();
    return matter ? `${matter.number} · ${matter.title}` : 'Matter';
  });

  /**
   * The form resets only when the pre-bill itself changes. A memoised id, because linkedSignal
   * recomputes whenever its source's dependencies change: with `() => this.invoice().id` every
   * snapshot of the same pre-bill threw away what was being edited.
   */
  private readonly invoiceId = computed(() => this.invoice().id);
  protected readonly form = linkedSignal<string, PreBillForm>({
    source: this.invoiceId,
    computation: () => formOf(untracked(this.invoice)),
  });
  protected readonly saving = signal(false);
  protected readonly issuing = signal(false);
  protected readonly announcement = signal('');

  private readonly sources = computed(() =>
    invoiceSourcesFrom({
      org: this.org(),
      matter: this.matter.value(),
      entries: this.entries.value(),
      disbursements: this.disbursements.value(),
      invoices: this.invoices.value(),
      creditNotes: this.creditNotes.value(),
      people: Object.fromEntries(this.members.value().map((member) => [member.id, member.displayName])),
    }),
  );

  private readonly fromDate = computed(() => this.parseDate(this.form().from));
  private readonly toDate = computed(() => this.parseDate(this.form().to));
  protected readonly fromError = computed(() => (this.fromDate() === undefined ? 'Enter a date as DD/MM/YYYY.' : null));
  protected readonly toError = computed(() => {
    const to = this.toDate();
    if (to === undefined) return 'Enter a date as DD/MM/YYYY.';
    const from = this.fromDate();
    return from && to && from > to ? 'The end date is before the start date.' : null;
  });
  private readonly terms = computed(() => {
    const text = this.form().paymentTermsDays.trim();
    const days = Number(text);
    return text && Number.isInteger(days) && days >= 0 && days <= 365 ? days : null;
  });
  protected readonly termsError = computed(() => (this.terms() === null ? 'Enter 0 to 365 days.' : null));
  private readonly extras = computed(() => extraLinesFrom(this.form().extraLines));
  protected readonly extraError = computed(() => this.extras().error);
  protected readonly formError = computed(
    () => this.fromError() ?? this.toError() ?? this.termsError() ?? this.extraError(),
  );
  protected readonly termsText = computed(() => {
    const days = this.terms() ?? this.invoice().paymentTermsDays;
    return days === 1 ? '1 day' : `${days} days`;
  });

  /** The choices as `billing-saveDraft` takes them (the last valid values while one is mistyped). */
  private readonly fields = computed((): InvoiceDraftFieldsInput => {
    const form = this.form();
    const from = this.fromDate();
    const to = this.toDate();
    return {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      grouping: form.grouping,
      excludedTimeEntryIds: form.excludedTimeEntryIds,
      excludedDisbursementIds: form.excludedDisbursementIds,
      extraLines: this.extras().lines,
      notes: form.notes,
      paymentTermsDays: this.terms() ?? this.invoice().paymentTermsDays,
      paidFromTrust: form.paidFromTrust,
    };
  });

  protected readonly build = computed(() => buildInvoice(this.fields(), this.sources()));
  /** The warnings the preview shows (unapproved time shows by the time; an empty bill shows its empty state). */
  protected readonly warnings = computed(() => {
    const build = this.build();
    return build.warnings.filter(
      (w) => w !== 'unapproved_time' && w !== 'too_many_items' && (w !== 'zero_total' || build.lines.length > 0),
    );
  });
  protected readonly problem = computed(() => (this.build().lines.length ? this.build().problem : null));
  /** Whether the choices differ from what's saved. */
  protected readonly dirty = computed(
    () => JSON.stringify(this.fields()) !== JSON.stringify(savedFields(this.invoice())),
  );
  /** The saved pre-bill against the same choices built now: what changed since it was saved. */
  protected readonly changes = computed(() => {
    const invoice = this.invoice();
    if (this.entries.status() === 'loading' || this.disbursements.status() === 'loading') {
      return { changed: [], added: [], stale: false };
    }
    return draftChanges(invoice, buildInvoice(savedFields(invoice), this.sources()));
  });
  protected readonly issuable = computed(
    () => !this.formError() && !this.build().problem && !this.saving() && this.entries.status() !== 'loading',
  );

  constructor() {
    const orgId = this.context.orgId();
    if (orgId) {
      orgSettingsReadRepository()
        .get(orgId)
        .then((org) => this.org.set(org ?? null))
        .catch(() => undefined);
    }
  }

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected date(date: string): string {
    return dateText(date);
  }

  protected entryMeta(entry: InvoiceEntryLike): string {
    const hours = unitsToHours(entry.units, this.sources().unitMinutes);
    const who = this.sources().people?.[entry.uid] ?? 'Former member';
    return `${dateText(entry.date)} · ${who} · ${hours.toFixed(2)} h`;
  }

  protected lineMeta(date: string | undefined, by: string | undefined): string {
    return [date ? dateText(date) : '', by ?? ''].filter(Boolean).join(' · ');
  }

  protected patch(change: Partial<PreBillForm>): void {
    this.form.update((form) => ({ ...form, ...change }));
  }

  protected async writeDown(entryId: string): Promise<void> {
    const entry = this.entries.value().find((item) => item.id === entryId);
    const matterId = this.matterId();
    if (!entry || !matterId || this.writingDown()) return;
    this.writingDown.set(true);
    try {
      const ui = { dialogs: this.dialogs, toasts: this.toasts };
      const summary = await writeDownTime(ui, this.timeApi, matterId, [entry], this.sources().unitMinutes);
      if (summary) this.announcement.set(summary);
    } catch (error) {
      this.toasts.show({ title: 'The time wasn’t written down', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.writingDown.set(false);
    }
  }

  protected toggle(key: 'excludedTimeEntryIds' | 'excludedDisbursementIds', id: string, included: boolean): void {
    this.form.update((form) => {
      const rest = form[key].filter((other) => other !== id);
      return { ...form, [key]: included ? rest : [...rest, id] };
    });
  }

  protected addLine(kind: ExtraLineForm['kind']): void {
    this.patch({ extraLines: [...this.form().extraLines, { kind, description: '', amount: '', gstFree: false }] });
  }

  protected patchLine(index: number, change: Partial<ExtraLineForm>): void {
    this.patch({
      extraLines: this.form().extraLines.map((line, i) => (i === index ? { ...line, ...change } : line)),
    });
  }

  protected removeLine(index: number): void {
    this.patch({ extraLines: this.form().extraLines.filter((_, i) => i !== index) });
  }

  protected async save(): Promise<boolean> {
    if (this.formError()) return false;
    this.saving.set(true);
    try {
      await this.api.saveDraft({ invoiceId: this.invoice().id, matterId: this.matterId(), fields: this.fields() });
      this.announcement.set('Pre-bill saved.');
      return true;
    } catch (error) {
      this.toasts.show({ title: 'The pre-bill didn’t save', description: errorCopy(error), tone: 'danger' });
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  protected async issue(): Promise<void> {
    if (!this.issuable()) return;
    const total = formatAud(this.build().totalCents);
    const confirmed = await this.dialogs.confirm({
      title: 'Issue this invoice?',
      body: `${total} on ${this.matterLabel()}. It takes the next invoice number and can’t be edited after; correct it with a void or a credit note.${this.build().totalCents === 0 ? ' It totals $0.00.' : ''}`,
      confirmLabel: 'Issue invoice',
    });
    if (!confirmed) return;
    this.issuing.set(true);
    try {
      if ((this.dirty() || this.changes().stale) && !(await this.save())) return;
      const result = await this.api.issue({ invoiceId: this.invoice().id });
      this.toasts.show({ title: `Invoice ${result.number} issued`, description: 'Its PDF is being prepared.' });
      this.announcement.set(`Invoice ${result.number} issued.`);
    } catch (error) {
      this.toasts.show({ title: 'The invoice wasn’t issued', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.issuing.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Delete this pre-bill?',
      body: 'Its time and disbursements stay unbilled.',
      confirmLabel: 'Delete pre-bill',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.api.deleteDraft({ invoiceId: this.invoice().id });
      void this.router.navigate(['/matters', this.matterId(), 'time']);
    } catch (error) {
      this.toasts.show({ title: 'The pre-bill wasn’t deleted', description: errorCopy(error), tone: 'danger' });
    }
  }

  /** A typed date: empty is `null`, a bad one `undefined`. */
  private parseDate(text: string): DateOnly | null | undefined {
    if (!text.trim()) return null;
    return parseEntryDate(text, this.today()) ?? undefined;
  }
}
