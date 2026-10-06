import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import type { MatterType, WipRow } from '@materia/domain';
import {
  formatAud,
  formatDateOnly,
  MATTER_TYPE_LABELS,
  MtBadge,
  MtButton,
  MtEmptyState,
  MtMeter,
  MtNote,
  MtSelect,
  MtTable,
  MtTableCell,
  ToastService,
  type MtOption,
  type MtTableColumn,
} from '@materia/ui';

import { BillingScreen } from './billing-screen';
import { ageText, feeLabel, MATTER_TYPES, wipFlags } from './billing-view';
import { downloadText } from './download';
import { errorCopy } from '../../core/error-copy';

const ANY = '';

/**
 * The WIP tab (BILL-03, billing.view): matters with unbilled time (final, billable, not invoiced)
 * and disbursements, from `billing-wip`, with the oldest entry's age, the fee, how much of the
 * estimate is used (BILL-05), the last invoice (BILL-07) and flags for closed matters and old WIP.
 * Sortable, filterable by responsible lawyer and matter type; a row opens the matter's Time tab.
 * Export downloads the entries behind the filtered rows as CSV (`time-exportCsv`).
 */
@Component({
  selector: 'mt-wip-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtBadge, MtButton, MtEmptyState, MtMeter, MtNote, MtSelect, MtTable, MtTableCell],
  host: { class: 'mt-col mt-wip-tab' },
  template: `
    <div class="mt-row filters">
      <mt-select
        name="responsible"
        label="Responsible"
        [native]="true"
        [options]="responsibleOptions()"
        [ngModel]="responsible()"
        (ngModelChange)="responsible.set($event ?? ANY)"
      />
      <mt-select
        name="type"
        label="Matter type"
        [native]="true"
        [options]="typeOptions"
        [ngModel]="type()"
        (ngModelChange)="type.set($event ?? ANY)"
      />
      <span class="mt-ml caption t-3" data-testid="wip-total">{{ totalText() }}</span>
      <button mtButton size="sm" variant="ghost" iconStart="refresh" [loading]="loading()" (click)="screen.loadWip()">
        Refresh
      </button>
      @if (screen.canApprove()) {
        <button
          mtButton
          size="sm"
          variant="secondary"
          iconStart="arrow-down"
          [loading]="exporting()"
          (click)="exportCsv()"
        >
          Export
        </button>
      }
    </div>
    @if (error(); as message) {
      <mt-note tone="danger">
        {{ message }}
        <button mtButton size="sm" (click)="screen.loadWip()">Try again</button>
      </mt-note>
    }
    @if (result()?.truncated) {
      <mt-note tone="warning"
        >There is more time than this view reads at once, so these totals are a lower bound.</mt-note
      >
    }
    @if (closedCount()) {
      <mt-note tone="warning" data-testid="closed-wip">
        {{ closedCount() }} closed {{ closedCount() === 1 ? 'matter still has' : 'matters still have' }} unbilled work.
        Bill or write it off before the file is archived.
      </mt-note>
    }
    @if (loading() && !result()) {
      <p class="caption t-3" role="status">Working out work in progress…</p>
    } @else {
      <mt-table
        label="Work in progress by matter"
        density="compact"
        [rows]="rows()"
        [columns]="columns"
        [rowKey]="rowKey"
        [rowLabel]="rowLabel"
        [(sort)]="sort"
        (open)="open($event)"
      >
        <ng-template mtCell="title" let-cell>
          @let row = asRow(cell);
          <div class="title">{{ row.title }}</div>
          <div class="caption t-3">{{ fee(row) }} · {{ responsibleName(row) }}</div>
        </ng-template>
        <ng-template mtCell="budget" let-cell>
          @let row = asRow(cell);
          @if (row.budgetPct === null) {
            <span class="caption t-3">No estimate</span>
          } @else {
            <div class="mt-row budget">
              <mt-meter
                [value]="row.budgetPct"
                [max]="100"
                [target]="80"
                [tone]="row.budgetPct >= 80 ? 'warning' : 'brand'"
                [label]="'Estimate used for ' + row.number"
              />
              <span class="mono-s t-3">{{ row.budgetPct }}%</span>
            </div>
          }
        </ng-template>
        <ng-template mtCell="flags" let-cell>
          @let row = asRow(cell);
          @for (flag of flags(row); track flag.label) {
            <mt-badge [tone]="flag.tone">{{ flag.label }}</mt-badge>
          } @empty {
            <span class="caption t-3">On track</span>
          }
        </ng-template>
        <div mtTableEmpty>
          <mt-empty-state
            icon="billing"
            [title]="filtered() ? 'No work in progress matches' : 'No unbilled work in progress'"
            [description]="
              filtered()
                ? 'Try another responsible lawyer or matter type.'
                : 'Final, billable time that hasn’t been invoiced shows here, by matter.'
            "
            [headingLevel]="3"
          />
        </div>
      </mt-table>
    }
  `,
  styles: `
    .mt-wip-tab {
      gap: var(--space-12);
      min-width: 0;
    }
    .mt-wip-tab .filters {
      align-items: flex-end;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-12);
    }
    .mt-wip-tab .filters .mt-select {
      min-width: 180px;
    }
    .mt-wip-tab .budget {
      align-items: center;
      gap: var(--space-8);
    }
    .mt-wip-tab .budget mt-meter {
      flex: 1 1 auto;
      min-width: 64px;
    }
  `,
})
export class WipTab {
  protected readonly screen = inject(BillingScreen);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly ANY = ANY;

  protected readonly result = this.screen.wip;
  protected readonly loading = this.screen.wipLoading;
  protected readonly error = this.screen.wipError;
  protected readonly exporting = signal(false);
  protected readonly responsible = signal<string>(ANY);
  protected readonly type = signal<MatterType | ''>(ANY);
  protected readonly sort = signal<{ column: string; direction: 'asc' | 'desc' } | null>({
    column: 'wip',
    direction: 'desc',
  });

  protected readonly typeOptions: MtOption<MatterType | ''>[] = [
    { value: ANY, label: 'All types' },
    ...MATTER_TYPES.map((type) => ({ value: type, label: MATTER_TYPE_LABELS[type] })),
  ];
  protected readonly responsibleOptions = computed((): MtOption<string>[] => {
    const uids = [...new Set((this.result()?.rows ?? []).map((row) => row.responsibleUid))];
    const options = uids
      .map((uid) => ({ value: uid, label: this.screen.memberName(uid) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: ANY, label: 'Everyone' }, ...options];
  });

  protected readonly filtered = computed(() => !!this.responsible() || !!this.type());
  protected readonly rows = computed(() =>
    (this.result()?.rows ?? []).filter(
      (row) =>
        (!this.responsible() || row.responsibleUid === this.responsible()) &&
        (!this.type() || row.type === this.type()),
    ),
  );
  protected readonly closedCount = computed(() => this.rows().filter((row) => row.closed).length);
  protected readonly totalText = computed(() => {
    const rows = this.rows();
    const total = rows.reduce((sum, row) => sum + row.totalCents, 0);
    return `${rows.length} ${rows.length === 1 ? 'matter' : 'matters'} · ${formatAud(total)}`;
  });

  protected readonly columns: MtTableColumn<WipRow>[] = [
    { id: 'number', header: 'Ref', sortable: true, cellClass: 'ref', width: '96px' },
    { id: 'title', header: 'Matter', sortable: true, value: (row) => row.title },
    { id: 'budget', header: 'Of estimate', sortable: true, width: '160px', sortValue: (row) => row.budgetPct },
    {
      id: 'age',
      header: 'Oldest',
      sortable: true,
      width: '96px',
      value: (row) => ageText(row.ageDays),
      sortValue: (row) => row.ageDays,
    },
    {
      id: 'invoiced',
      header: 'Last invoice',
      sortable: true,
      width: '112px',
      value: (row) => (row.lastInvoicedOn ? formatDateOnly(row.lastInvoicedOn) : 'Never'),
      sortValue: (row) => row.lastInvoicedOn,
    },
    {
      id: 'wip',
      header: 'WIP',
      sortable: true,
      numeric: true,
      width: '112px',
      value: (row) => formatAud(row.totalCents),
      sortValue: (row) => row.totalCents,
    },
    { id: 'flags', header: 'Status' },
  ];

  protected readonly rowKey = (row: WipRow) => row.matterId;
  protected readonly rowLabel = (row: WipRow) => `${row.number} ${row.title}`;
  protected asRow(row: unknown): WipRow {
    return row as WipRow;
  }

  protected fee(row: WipRow): string {
    return feeLabel(row.fee);
  }

  protected flags(row: WipRow) {
    return wipFlags(row);
  }

  protected responsibleName(row: WipRow): string {
    return this.screen.memberName(row.responsibleUid);
  }

  protected open(row: WipRow): void {
    void this.router.navigate(['/matters', row.matterId, 'time']);
  }

  /** The unbilled entries behind the shown rows, as CSV. */
  protected async exportCsv(): Promise<void> {
    this.exporting.set(true);
    try {
      const result = await this.screen.api.exportCsv({
        from: '2000-01-01',
        to: this.screen.today(),
        unbilledOnly: true,
        ...(this.responsible() ? { responsibleUid: this.responsible() } : {}),
        ...(this.type() ? { matterType: this.type() as MatterType } : {}),
      });
      downloadText(`wip-${this.screen.today()}.csv`, result.csv, 'text/csv;charset=utf-8');
      if (result.truncated)
        this.toasts.show({
          title: 'Export cut short',
          description: `The file holds the first ${result.rows} entries. Filter by person or type for the rest.`,
          tone: 'neutral',
        });
    } catch (error) {
      this.toasts.show({ title: 'The export didn’t download', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.exporting.set(false);
    }
  }
}
