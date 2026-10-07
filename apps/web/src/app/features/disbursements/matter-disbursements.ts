import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import {
  disbursementCallables,
  disbursementPresetsRepository,
  forMatter,
  MATTER_DISBURSEMENTS_QUERY,
  matterDisbursementRepository,
  matterDocumentRepository,
  matterDocumentsQuery,
  type DisbursementItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  DISBURSEMENT_CATEGORY_LABELS,
  DISBURSEMENT_PRESETS_DOC,
  disbursementTotals,
  GST_TREATMENT_LABELS,
  presetsOrDefault,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  formatShortDate,
  MT_MENU,
  MT_TODAY,
  MtBadge,
  MtButton,
  MtEmptyState,
  MtIconButton,
  MtNote,
  ToastService,
} from '@materia/ui';

import { DisbursementForm, type DisbursementFormValue, type ReceiptOption } from './disbursement-form';
import { DISBURSEMENT_STATUS_LABELS } from './disbursements-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { MatterScreen } from '../matter-detail/matter-screen';

type Item = WithId<DisbursementItem>;

/**
 * A matter's disbursements (BILL-04), under its time on the Time tab: outlays with their GST
 * treatment, ex GST, GST and total, and the receipt (a matter document). time.record roles add
 * and edit unbilled ones (presets prefill the form); approvers write them off or restore them
 * (`disbursements-setStatus`). Billed ones are read-only. Totals count unbilled ones only, as
 * WIP does. Shown while `billing.disbursements` is on.
 */
@Component({
  selector: 'mt-matter-disbursements',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MT_MENU, MtBadge, MtButton, MtEmptyState, MtIconButton, MtNote, DisbursementForm],
  host: { class: 'mt-matter-disbursements' },
  template: `
    <section class="mt-col" aria-labelledby="disbursements-title" data-testid="disbursements">
      <div class="mt-row head">
        <h2 class="title-m" id="disbursements-title">Disbursements</h2>
        @if (items.status() !== 'loading') {
          <span class="caption t-3 totals" data-testid="disbursement-totals">{{ totalsText() }}</span>
        }
        @if (canRecord() && !adding()) {
          <button mtButton class="mt-ml" variant="secondary" size="sm" iconStart="plus" (click)="startAdding()">
            Add disbursement
          </button>
        }
      </div>
      @if (adding()) {
        <mt-disbursement-form
          #addForm
          class="card"
          [matterId]="matterId()"
          [presets]="presets()"
          [documents]="receipts()"
          [canUpload]="canUpload()"
          (saved)="create($event)"
          (cancelled)="adding.set(false)"
        />
      }
      <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>
      @switch (items.status()) {
        @case ('loading') {
          <p class="caption t-3" role="status">Loading disbursements…</p>
        }
        @case ('error') {
          <mt-note tone="danger">{{ loadError() }}</mt-note>
        }
        @default {
          @if (rows().length) {
            <div class="table-wrap">
              <table>
                <caption class="mt-sr">
                  Disbursements on this matter
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Description</th>
                    <th scope="col">GST</th>
                    <th scope="col" class="num">Ex GST</th>
                    <th scope="col" class="num">GST</th>
                    <th scope="col" class="num">Total</th>
                    <th scope="col"><span class="mt-sr">Receipt and actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (item of rows(); track item.id) {
                    @if (editing() === item.id) {
                      <tr>
                        <td colspan="7">
                          <mt-disbursement-form
                            submitLabel="Save"
                            formLabel="Edit disbursement"
                            [matterId]="matterId()"
                            [initial]="item"
                            [presets]="presets()"
                            [documents]="receipts()"
                            [canUpload]="canUpload()"
                            [saving]="busy()"
                            (saved)="update(item, $event)"
                            (cancelled)="editing.set(null)"
                          />
                        </td>
                      </tr>
                    } @else {
                      <tr [attr.data-status]="item.status" [attr.data-disbursement]="item.id">
                        <td class="date">{{ date(item.date) }}</td>
                        <td>
                          <span class="label">{{ item.description }}</span>
                          <span class="caption t-3 sub">
                            {{ category(item) }}{{ item.payee ? ' · ' + item.payee : '' }}
                          </span>
                          @if (item.status !== 'unbilled') {
                            <mt-badge [tone]="item.status === 'billed' ? 'success' : 'neutral'">
                              {{ statusLabel(item) }}
                            </mt-badge>
                          }
                        </td>
                        <td class="caption">{{ treatment(item) }}</td>
                        <td class="num">{{ money(item.amountExGstCents) }}</td>
                        <td class="num">{{ money(item.gstCents) }}</td>
                        <td class="num label">{{ money(item.amountExGstCents + item.gstCents) }}</td>
                        <td class="end">
                          @if (item.receiptDocumentId) {
                            <a
                              mtIconButton
                              icon="attach"
                              size="sm"
                              label="Open the receipt"
                              [routerLink]="['/matters', matterId(), 'documents', item.receiptDocumentId]"
                            ></a>
                          }
                          @if (actionsFor(item); as actions) {
                            <button
                              mtIconButton
                              icon="more"
                              size="sm"
                              [label]="'More actions for ' + item.description"
                              [mtMenuTrigger]="menu"
                            ></button>
                            <ng-template #menu>
                              <mt-menu aria-label="Disbursement actions">
                                @if (actions.edit) {
                                  <button mtMenuItem icon="compose" (click)="editing.set(item.id)">Edit</button>
                                }
                                @if (actions.approve && item.status === 'unbilled') {
                                  <button mtMenuItem icon="x" (click)="setStatus(item, 'written_off')">
                                    Write off
                                  </button>
                                }
                                @if (actions.approve && item.status === 'written_off') {
                                  <button mtMenuItem icon="refresh" (click)="setStatus(item, 'unbilled')">
                                    Restore
                                  </button>
                                }
                                @if (actions.edit) {
                                  <button mtMenuItem icon="trash" tone="danger" (click)="remove(item)">Delete</button>
                                }
                              </mt-menu>
                            </ng-template>
                          }
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          } @else if (!adding()) {
            <mt-empty-state
              icon="billing"
              title="No disbursements yet"
              [description]="
                canRecord()
                  ? 'Record outlays such as filing fees, searches and advertisements, with the receipt.'
                  : 'Outlays paid on this matter show here.'
              "
              [headingLevel]="3"
            />
          }
        }
      }
    </section>
  `,
  styles: `
    .mt-matter-disbursements {
      display: block;
      max-width: 1080px;
    }
    .mt-matter-disbursements > section {
      gap: var(--space-12);
    }
    .mt-matter-disbursements .head {
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-12);
    }
    .mt-matter-disbursements h2 {
      margin: 0;
    }
    .mt-matter-disbursements .card {
      padding: var(--space-12);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-matter-disbursements .table-wrap {
      overflow-x: auto;
    }
    .mt-matter-disbursements table {
      width: 100%;
      border-collapse: collapse;
    }
    .mt-matter-disbursements th,
    .mt-matter-disbursements td {
      padding: var(--space-8);
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-matter-disbursements th {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-matter-disbursements .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .mt-matter-disbursements .date {
      white-space: nowrap;
    }
    .mt-matter-disbursements .sub {
      display: block;
    }
    .mt-matter-disbursements .end {
      white-space: nowrap;
      text-align: right;
    }
    .mt-matter-disbursements tr[data-status='written_off'] td:not(.end) {
      color: var(--text-tertiary);
    }
    .mt-matter-disbursements tr[data-status='written_off'] .num {
      text-decoration: line-through;
    }
  `,
})
export class MatterDisbursements {
  protected readonly screen = inject(MatterScreen);
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly today = inject(MT_TODAY);
  private readonly api = disbursementCallables(inject(CALLABLES));
  private readonly repo = matterDisbursementRepository(this.screen.id);
  private readonly documents = matterDocumentRepository(this.screen.id);
  private readonly addForm = viewChild<DisbursementForm>('addForm');

  private readonly canRecordTime = can('time.record');
  private readonly canApprove = can('time.approve');
  private readonly canPrivileged = can('privileged.view');
  private readonly uploadAllowed = can('document.upload');
  protected readonly canRecord = computed(() => this.canRecordTime() && !this.screen.deleted());
  protected readonly canUpload = computed(() => this.uploadAllowed() && !this.screen.deleted());
  protected readonly matterId = computed(() => this.screen.id() ?? '');

  protected readonly items = this.repo.watchQuery(forMatter(this.screen.id, MATTER_DISBURSEMENTS_QUERY));
  protected readonly loadError = computed(() => errorCopy(this.items.error()));
  private readonly presetsDoc = disbursementPresetsRepository().watch(DISBURSEMENT_PRESETS_DOC);
  protected readonly presets = computed(() =>
    this.presetsDoc.status() === 'loading' ? [] : presetsOrDefault(this.presetsDoc.value()),
  );
  private readonly docs = this.documents.watchQuery(() =>
    this.screen.id() ? matterDocumentsQuery({ privilegedVisible: this.canPrivileged(), pageSize: 100 }) : null,
  );
  protected readonly receipts = computed((): ReceiptOption[] =>
    this.docs.value().map((doc) => ({ id: doc.id, name: doc.name })),
  );

  protected readonly adding = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly announcement = signal('');

  protected readonly rows = computed(() => this.items.value().filter((item) => !item.deletedAt));
  protected readonly totalsText = computed(() => {
    const totals = disbursementTotals(this.rows());
    if (!totals.count) return this.rows().length ? 'Nothing unbilled' : '';
    return `${totals.count} unbilled · ${formatAud(totals.exGstCents)} ex GST · ${formatAud(totals.gstCents)} GST`;
  });

  protected date(date: string): string {
    return formatShortDate(date as never, this.today());
  }

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected treatment(item: Item): string {
    return GST_TREATMENT_LABELS[item.gstTreatment];
  }

  protected category(item: Item): string {
    return DISBURSEMENT_CATEGORY_LABELS[item.category ?? 'other'];
  }

  protected statusLabel(item: Item): string {
    return DISBURSEMENT_STATUS_LABELS[item.status];
  }

  /** Unbilled ones are edited and deleted by time.record roles; approvers write off and restore. */
  protected actionsFor(item: Item): { edit: boolean; approve: boolean } | null {
    if (this.screen.deleted()) return null;
    const edit = item.status === 'unbilled' && this.canRecordTime();
    const approve = this.canApprove() && item.status !== 'billed';
    return edit || approve ? { edit, approve } : null;
  }

  protected startAdding(): void {
    this.adding.set(true);
    queueMicrotask(() => this.addForm()?.focus());
  }

  /** Records it. Not awaited: offline, it's saved when back online. */
  protected create(value: DisbursementFormValue): void {
    this.repo
      .create(value)
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The disbursement didn’t save', description: errorCopy(error), tone: 'danger' }),
      );
    this.announcement.set(`Recorded ${value.description}.`);
    this.adding.set(false);
  }

  protected async update(item: Item, value: DisbursementFormValue): Promise<void> {
    this.busy.set(true);
    try {
      await this.repo.update(item.id, value);
      this.announcement.set('Saved.');
      this.editing.set(null);
    } catch (error) {
      this.toasts.show({ title: 'The change didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(item: Item): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Delete this disbursement?',
      body: `${item.description}, ${formatAud(item.amountExGstCents + item.gstCents)}. The receipt stays in Documents.`,
      confirmLabel: 'Delete disbursement',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.repo.softDelete(item.id);
      this.announcement.set('Deleted the disbursement.');
    } catch (error) {
      this.toasts.show({ title: 'The disbursement wasn’t deleted', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async setStatus(item: Item, status: 'unbilled' | 'written_off'): Promise<void> {
    const matterId = this.screen.id();
    if (!matterId) return;
    try {
      const result = await this.api.setStatus({ matterId, disbursementIds: [item.id], status });
      if (result.updated.length) this.announcement.set(status === 'written_off' ? 'Written off.' : 'Restored.');
      else this.toasts.show({ title: 'Nothing changed', description: 'That disbursement has been billed.' });
    } catch (error) {
      this.toasts.show({ title: 'The status didn’t change', description: errorCopy(error), tone: 'danger' });
    }
  }
}
