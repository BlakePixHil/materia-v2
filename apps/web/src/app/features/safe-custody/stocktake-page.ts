import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can, type JobView } from '@materia/data-access';
import {
  heldPacketsQuery,
  safeCustodyCallables,
  safeCustodyRepository,
  type PacketItem,
  type WithId,
} from '@materia/data-access/repository';
import { SAFE_CUSTODY_ITEM_LABELS } from '@materia/domain';
import {
  formatDateOnly,
  MT_TODAY,
  MtButton,
  MtEmptyState,
  MtNote,
  MtSelect,
  MtTable,
  ToastService,
  type MtOption,
  type MtTableColumn,
  type MtTableGroup,
} from '@materia/ui';

import { EXPORT_NAVIGATOR, safeCustodyErrorCopy } from './safe-custody-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { JobProgress } from '../../core/jobs/job-progress';
import { MtPageActions } from '../../shell/page-header';

type Row = WithId<PacketItem>;

/** `safeCustody-verify` takes at most this many packets at once. */
const VERIFY_BATCH = 200;

/**
 * The annual stocktake (`/safe-custody/stocktake`, CORE-17): every held packet in shelf order, by
 * site and cabinet. Tick the packets found and mark them verified today; print the list as a PDF
 * to tick off on paper.
 */
@Component({
  selector: 'mt-safe-custody-stocktake',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, JobProgress, MtButton, MtEmptyState, MtNote, MtPageActions, MtSelect, MtTable],
  host: { class: 'mt-col mt-sc-stocktake' },
  template: `
    <ng-template mtPageActions>
      @if (canEdit()) {
        <button mtButton size="sm" variant="secondary" iconStart="document" [loading]="starting()" (click)="report()">
          Stocktake PDF
        </button>
      }
    </ng-template>
    <h1 class="mt-sr">Safe custody stocktake</h1>

    <div class="mt-row mt-sc-bar">
      @if (siteOptions().length > 2) {
        <mt-select
          label="Site"
          [native]="true"
          [options]="siteOptions()"
          [ngModel]="site()"
          (ngModelChange)="site.set($event ?? ''); selection.set([])"
        />
      }
      <p class="mt-sc-muted" role="status">
        {{ rows().length === 1 ? '1 packet held' : rows().length + ' packets held' }}
        @if (selection().length) {
          · {{ selection().length }} ticked
        }
      </p>
      @if (canEdit()) {
        <button
          mtButton
          size="sm"
          variant="primary"
          iconStart="check"
          [disabled]="!selection().length"
          [loading]="verifying()"
          (click)="verify()"
        >
          Mark found {{ todayLabel }}
        </button>
      }
    </div>

    @if (jobId(); as id) {
      <mt-job-progress [jobId]="id" label="Stocktake report" (finished)="download(id, $event)" />
    }

    @switch (packets.status()) {
      @case ('loading') {
        <p role="status" class="mt-sc-muted">Loading held packets…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ listError() }}</mt-note>
      }
      @default {
        <mt-table
          label="Held packets"
          density="compact"
          [selectable]="canEdit()"
          [rows]="rows()"
          [columns]="columns"
          [rowKey]="rowKey"
          [rowLabel]="rowLabel"
          [groupBy]="groupBy"
          [(selection)]="selection"
        >
          <div mtTableEmpty>
            <mt-empty-state
              title="Nothing is held"
              description="Packets held in safe custody are listed here for the stocktake."
              icon="archive"
              [headingLevel]="2"
            />
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
    .mt-sc-bar {
      flex-wrap: wrap;
      gap: var(--space-12);
      align-items: end;
    }
    .mt-sc-muted {
      margin: 0;
      color: var(--text-tertiary);
    }
    .mt-sc-bar p {
      flex: 1;
    }
  `,
})
export class SafeCustodyStocktakePage {
  private readonly toasts = inject(ToastService);
  private readonly navigate = inject(EXPORT_NAVIGATOR);
  private readonly today = inject(MT_TODAY);
  private readonly api = safeCustodyCallables(inject(CALLABLES));

  protected readonly canEdit = can('safeCustody.edit');
  protected readonly todayLabel = formatDateOnly(this.today());
  protected readonly site = signal('');
  protected readonly selection = signal<readonly string[]>([]);
  protected readonly verifying = signal(false);
  protected readonly starting = signal(false);
  protected readonly jobId = signal<string | null>(null);

  protected readonly packets = safeCustodyRepository().watchQuery(heldPacketsQuery());
  private readonly held = computed(() => this.packets.value().filter((row) => !row.deletedAt && row.status === 'held'));
  protected readonly rows = computed(() => {
    const site = this.site();
    return site ? this.held().filter((row) => row.location.site === site) : this.held();
  });
  protected readonly siteOptions = computed<MtOption<string>[]>(() => [
    { value: '', label: 'All sites' },
    ...[...new Set(this.held().map((row) => row.location.site))].sort().map((site) => ({ value: site, label: site })),
  ]);
  protected readonly listError = computed(() => errorCopy(this.packets.error()));

  protected readonly columns: MtTableColumn<Row>[] = [
    { id: 'slot', header: 'Slot', value: (row) => row.location.slot, width: '80px' },
    { id: 'packetNo', header: 'Packet', cellClass: 'ref', width: '112px' },
    { id: 'testatorName', header: 'Testator', cellClass: 'title' },
    {
      id: 'items',
      header: 'Originals',
      value: (row) => row.items.map((item) => SAFE_CUSTODY_ITEM_LABELS[item.kind]).join(', '),
    },
    {
      id: 'verified',
      header: 'Last found',
      value: (row) => (row.lastVerified ? formatDateOnly(row.lastVerified.on) : 'Never'),
      sortValue: (row) => row.lastVerified?.on ?? '',
    },
  ];
  protected readonly rowKey = (row: Row) => row.id;
  protected readonly rowLabel = (row: Row) => `${row.packetNo} ${row.testatorName}`;
  protected readonly groupBy = (row: Row): MtTableGroup => ({
    key: `${row.location.site}|${row.location.cabinet}`,
    label: [row.location.site, row.location.cabinet || 'No cabinet'].join(' · '),
  });

  protected async verify(): Promise<void> {
    const ids = [...this.selection()];
    if (!ids.length || this.verifying()) return;
    this.verifying.set(true);
    let verified = 0;
    let skipped = 0;
    try {
      for (let start = 0; start < ids.length; start += VERIFY_BATCH) {
        const result = await this.api.verify({ ids: ids.slice(start, start + VERIFY_BATCH), on: this.today() });
        verified += result.verified.length;
        skipped += result.skipped.length;
      }
      this.selection.set([]);
      this.toasts.show({
        title: verified === 1 ? '1 packet marked found' : `${verified} packets marked found`,
        ...(skipped ? { description: `${skipped} weren’t held any more, so they were left alone.` } : {}),
        tone: 'success',
      });
    } catch (error) {
      this.toasts.show({
        title: 'The stocktake wasn’t saved',
        description: safeCustodyErrorCopy(error),
        tone: 'danger',
      });
    } finally {
      this.verifying.set(false);
    }
  }

  protected async report(): Promise<void> {
    if (this.starting()) return;
    this.starting.set(true);
    try {
      const site = this.site();
      const { jobId } = await this.api.stocktakeReport(site ? { site } : {});
      this.jobId.set(jobId);
    } catch (error) {
      this.toasts.show({ title: 'The report didn’t start', description: safeCustodyErrorCopy(error), tone: 'danger' });
    } finally {
      this.starting.set(false);
    }
  }

  protected async download(jobId: string, job: JobView): Promise<void> {
    if (job.status !== 'succeeded') return;
    try {
      const { url } = await this.api.exportUrl(jobId);
      this.navigate(url);
    } catch (error) {
      this.toasts.show({
        title: 'The report didn’t download',
        description: safeCustodyErrorCopy(error),
        tone: 'danger',
      });
    }
  }
}
