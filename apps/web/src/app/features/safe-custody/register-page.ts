import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import {
  packetListQuery,
  packetMatchesFilters,
  safeCustodyRepository,
  type PacketFilters,
  type PacketItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  locationLabel,
  SAFE_CUSTODY_ITEM_LABELS,
  SAFE_CUSTODY_STATUS_LABELS,
  type SafeCustodyStatus,
} from '@materia/domain';
import {
  DialogService,
  formatDateOnly,
  MtBadge,
  MtButton,
  MtEmptyState,
  MtNote,
  MtSearchField,
  MtTable,
  MtTableCell,
  ToastService,
  type MtTableColumn,
} from '@materia/ui';

import { PacketDialog, type PacketDialogData, type PacketDialogResult } from './packet-dialog';
import { currentFlag, STATUS_TONES } from './safe-custody-view';
import { CommandRegistry } from '../../core/commands/command-registry';
import { errorCopy } from '../../core/error-copy';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { MtPageActions } from '../../shell/page-header';

type Row = WithId<PacketItem>;

const STATUS_FILTERS: { value: SafeCustodyStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'held', label: 'Held' },
  { value: 'out', label: 'Out' },
  { value: 'released', label: 'Released' },
  { value: 'destroyed', label: 'Destroyed' },
];

/**
 * The will safe custody register (`/safe-custody`, CORE-17): every original will packet the firm
 * holds, newest first, searchable by testator, packet number or location. `r` receives a will, `/`
 * searches; a row opens the packet.
 */
@Component({
  selector: 'mt-safe-custody-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtBadge, MtButton, MtEmptyState, MtNote, MtPageActions, MtSearchField, MtTable, MtTableCell],
  host: { class: 'mt-col mt-safe-custody' },
  template: `
    <ng-template mtPageActions>
      <a mtButton size="sm" variant="secondary" iconStart="check-circle" routerLink="/safe-custody/stocktake">
        Stocktake
      </a>
      @if (canEdit()) {
        <button mtButton variant="primary" size="sm" iconStart="plus" kbd="r" (click)="receive()">
          Receive a will
        </button>
      }
    </ng-template>
    <h1 class="mt-sr">Safe custody</h1>

    <div class="mt-sc-filters">
      <mt-search-field
        #search
        label="Search the register"
        placeholder="Testator, packet number or location"
        shortcut="/"
        (queryChange)="query.set($event)"
      />
      <div class="mt-sc-chips" role="group" aria-label="Status">
        @for (option of statusFilters; track option.value) {
          <button
            type="button"
            class="mt-sc-chip"
            [attr.data-selected]="status() === option.value ? '' : null"
            [attr.aria-pressed]="status() === option.value"
            (click)="status.set(option.value)"
          >
            {{ option.label }}
          </button>
        }
      </div>
    </div>

    @switch (packets.status()) {
      @case ('loading') {
        <p role="status" class="mt-sc-muted">Loading the register…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ listError() }}
          <button mtButton size="sm" (click)="packets.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        <mt-table
          label="Safe custody register"
          density="compact"
          [rows]="rows()"
          [columns]="columns"
          [rowKey]="rowKey"
          [rowLabel]="rowLabel"
          (open)="openPacket($event)"
        >
          <ng-template mtCell="status" let-cell>
            @let row = asRow(cell);
            <mt-badge [tone]="tones[row.status]">{{ statusLabels[row.status] }}</mt-badge>
            @if (row.pendingDestruction) {
              <mt-badge tone="danger">Destruction to confirm</mt-badge>
            }
          </ng-template>
          <div mtTableEmpty>
            @if (filtered()) {
              <mt-empty-state
                title="No packets match"
                description="Try another name, packet number or location, or clear the filter."
                icon="search"
                [headingLevel]="2"
              />
            } @else {
              <mt-empty-state
                title="No wills in safe custody yet"
                description="Original wills, codicils and powers of attorney the firm holds are listed here."
                icon="archive"
                [headingLevel]="2"
              >
                @if (canEdit()) {
                  <button mtButton variant="primary" size="sm" iconStart="plus" (click)="receive()">
                    Receive a will
                  </button>
                }
              </mt-empty-state>
            }
          </div>
        </mt-table>
        @if (packets.hasMore()) {
          <button mtButton size="sm" [loading]="packets.loadingMore()" (click)="packets.loadMore()">
            Show more packets
          </button>
        }
      }
    }
  `,
  styles: `
    :host {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-sc-filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-12);
      align-items: center;
    }
    .mt-sc-filters mt-search-field {
      flex: 1 1 280px;
      max-width: 420px;
    }
    .mt-sc-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
    }
    .mt-sc-chip {
      display: inline-flex;
      align-items: center;
      height: 28px;
      padding: 0 10px;
      border-radius: var(--radius-full);
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      font: 500 12px/16px var(--font-sans);
      color: var(--text-secondary);
      cursor: pointer;
    }
    .mt-sc-chip:hover {
      border-color: var(--border-strong);
      color: var(--text-primary);
    }
    .mt-sc-chip[data-selected] {
      background: var(--bg-selected);
      border-color: var(--border-focus);
      color: var(--text-brand);
    }
    .mt-sc-chip:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .mt-sc-muted {
      margin: 0;
      color: var(--text-tertiary);
    }
  `,
})
export class SafeCustodyRegisterPage {
  private readonly router = inject(Router);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly canEdit = can('safeCustody.edit');
  protected readonly statusFilters = STATUS_FILTERS;
  protected readonly tones = STATUS_TONES;
  protected readonly statusLabels = SAFE_CUSTODY_STATUS_LABELS;
  protected readonly query = signal('');
  protected readonly status = signal<SafeCustodyStatus | ''>('');
  private readonly filters = computed<PacketFilters>(() => ({ query: this.query(), status: this.status() || null }));
  protected readonly filtered = computed(() => !!(this.query().trim() || this.status()));

  protected readonly packets = safeCustodyRepository().watchQuery(() => packetListQuery(this.filters()));
  protected readonly rows = computed(() =>
    this.packets.value().filter((row) => packetMatchesFilters(row, this.filters())),
  );
  protected readonly listError = computed(() => errorCopy(this.packets.error()));

  protected readonly columns: MtTableColumn<Row>[] = [
    { id: 'packetNo', header: 'Packet', cellClass: 'ref', width: '112px' },
    { id: 'testatorName', header: 'Testator', cellClass: 'title' },
    { id: 'contents', header: 'Originals', value: (row) => contents(row) },
    { id: 'location', header: 'Location', value: (row) => locationLabel(row.location) },
    { id: 'status', header: 'Status', value: (row) => SAFE_CUSTODY_STATUS_LABELS[row.status] },
    {
      id: 'receivedOn',
      header: 'Received',
      value: (row) => formatDateOnly(row.receivedOn),
      sortValue: (row) => row.receivedOn,
    },
  ];
  protected readonly rowKey = (row: Row) => row.id;
  protected readonly rowLabel = (row: Row) => `${row.packetNo} ${row.testatorName}`;

  private readonly search = viewChild<MtSearchField>('search');
  private readonly dialogOpen = signal(false);

  constructor() {
    const shortcuts = inject(ShortcutService);
    const commands = inject(CommandRegistry);
    const free = () => !this.dialogOpen();
    const cleanups = [
      shortcuts.register({
        combo: 'r',
        description: 'Receive a will',
        group: 'Safe custody',
        scope: 'route',
        when: () => free() && this.canEdit(),
        handler: () => void this.receive(),
      }),
      shortcuts.register({
        combo: '/',
        description: 'Search the register',
        group: 'Safe custody',
        scope: 'route',
        when: free,
        handler: () => this.search()?.focus(),
      }),
      commands.register({
        id: 'safe-custody.receive',
        title: 'Receive a will into safe custody',
        group: 'Safe custody',
        icon: 'archive',
        keywords: ['original', 'will', 'packet', 'safe'],
        shortcut: 'r',
        when: () => this.canEdit(),
        run: () => void this.receive(),
      }),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));
  }

  /** The table's cell templates are untyped; its rows are always packets. */
  protected asRow(cell: unknown): Row {
    return cell as Row;
  }

  protected openPacket(row: Row): void {
    void this.router.navigate(['/safe-custody', row.id]);
  }

  async receive(): Promise<void> {
    if (!this.canEdit() || this.dialogOpen()) return;
    this.dialogOpen.set(true);
    try {
      const result = await this.dialogs.open<PacketDialogData, PacketDialogResult>(PacketDialog, { data: {} }).result;
      if (!result) return;
      this.toasts.show({ title: `${result.packetNo} received`, tone: 'success' });
      void this.router.navigate(['/safe-custody', result.id]);
    } finally {
      this.dialogOpen.set(false);
    }
  }
}

/** "Will, Codicil (current)": the originals, the current will marked when there's more than one. */
function contents(row: PacketItem): string {
  const current = currentFlag(row.items);
  return row.items
    .map((item, index) => `${SAFE_CUSTODY_ITEM_LABELS[item.kind]}${index === current ? ' (current)' : ''}`)
    .join(', ');
}
