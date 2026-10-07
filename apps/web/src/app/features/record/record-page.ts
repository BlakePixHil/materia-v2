import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { Router } from '@angular/router';

import { can } from '@materia/data-access';
import { DialogService, MtButton, MtEmptyState, MtIcon, MtIconButton, MtSkeleton } from '@materia/ui';

import { intentUrl } from '../../core/commands/intents';
import { recentMatters, type RecentMatter } from '../../core/matters/recent-matters';
import { pickMatter } from '../../core/timer/timer-dialogs';
import { anyScansWaiting, type QueuedScan } from '../scan/scan-db';
import type { ScanQueue, ScanState } from '../scan/scan-queue';
import type { TimeQuickEntryData } from '../time/time-quick-entry';

type RecordTile = 'time' | 'note' | 'scan';

/**
 * Record (`/record`, MOB-02): the phone's capture screen, the TabBar's centre button and the
 * installed app's "Record" shortcut. Big targets for "Log time" (BILL-01's quick entry, a sheet on a
 * phone), "Note" (the matter's Notes tab, ready to write) and "Photo document" (Scan a document,
 * MOB-05), on a recent matter picked from the chips or any matter chosen as you go. Scans saved
 * without a connection are listed under them until they upload. Voice (MOB-03) joins the grid when
 * it ships.
 */
@Component({
  selector: 'mt-record-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/chip.css',
    '../../../../../../libs/ui/src/generated/components/mgroup.css',
  ],
  imports: [MtButton, MtEmptyState, MtIcon, MtIconButton, MtSkeleton],
  host: { class: 'mt-record' },
  template: `
    <h1 class="mt-sr">Record</h1>
    <section class="matter" aria-labelledby="record-matter">
      <h2 class="mt-mgroup" id="record-matter">Matter</h2>
      @if (recents.loading()) {
        <mt-skeleton variant="lines" label="Loading recent matters…" [count]="1" />
      } @else if (recents.items().length) {
        <div class="chips" role="group" aria-labelledby="record-matter">
          @for (matter of recents.items(); track matter.id) {
            <button
              type="button"
              class="mt-chip"
              [attr.aria-pressed]="chosen()?.id === matter.id"
              [attr.data-selected]="chosen()?.id === matter.id ? '' : null"
              (click)="choose(matter)"
            >
              <span class="num">{{ matter.number }}</span
              >&ngsp;<span class="mt-ell">{{ matter.title }}</span>
            </button>
          }
        </div>
      }
      <p class="caption t-3 hint" aria-live="polite">{{ hint() }}</p>
    </section>

    @if (tiles().length) {
      <div class="tiles">
        @for (tile of tiles(); track tile.id) {
          <button type="button" class="tile" [attr.data-record]="tile.id" (click)="run(tile.id)">
            <span class="glyph"><mt-icon [name]="tile.icon" [size]="20" /></span>
            <span class="tt">{{ tile.label }}</span>
            <span class="ts">{{ tile.detail }}</span>
          </button>
        }
      </div>
    } @else {
      <mt-empty-state
        icon="lock"
        title="Nothing to record here"
        description="Your role can’t log time, write file notes or add documents. Ask an owner or admin if you need to."
        [headingLevel]="2"
      />
    }

    @if (queue(); as scans) {
      @if (scans.waiting().length) {
        <section class="waiting" aria-labelledby="record-waiting" data-testid="scans-waiting">
          <h2 class="mt-mgroup" id="record-waiting">Waiting to upload</h2>
          <ul class="scans">
            @for (scan of scans.waiting(); track scan.id) {
              @let state = scans.stateOf(scan);
              <li class="scan">
                <span class="doc"><mt-icon name="document" [size]="16" /></span>
                <span class="text">
                  <span class="tt mt-ell">{{ scan.fileName }}</span>
                  <span class="ts" [attr.data-failed]="state.kind === 'failed' ? '' : null">
                    {{ scan.matterLabel }} · {{ stateText(state) }}
                  </span>
                </span>
                @if (state.kind === 'failed') {
                  <button mtButton size="sm" variant="secondary" (click)="scans.retry()">Try again</button>
                }
                <button
                  mtIconButton
                  icon="trash"
                  size="sm"
                  [label]="'Delete ' + scan.fileName"
                  (click)="discard(scans, scan)"
                ></button>
              </li>
            }
          </ul>
        </section>
      }
    }
  `,
  styles: `
    .mt-record {
      display: flex;
      flex-direction: column;
      gap: var(--space-20);
      max-width: 560px;
    }
    .mt-record .matter {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-record .chips {
      display: flex;
      gap: var(--space-8);
      overflow-x: auto;
      scrollbar-width: none;
      margin: 0 calc(-1 * var(--space-16));
      padding: 2px var(--space-16);
    }
    .mt-record .chips .mt-chip {
      flex: none;
      max-width: 240px;
      min-height: 44px;
      padding: 0 var(--space-12);
      font-size: 13px;
    }
    .mt-record .chips .num {
      font: 500 12px/16px var(--font-mono);
      color: var(--text-tertiary);
    }
    .mt-record .chips [data-selected] .num {
      color: inherit;
    }
    .mt-record .hint {
      margin: 0;
    }
    .mt-record .tiles {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-12);
    }
    .mt-record .tile {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-4);
      min-height: 136px;
      padding: var(--space-16);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      background: var(--bg-surface);
      box-shadow: var(--shadow-card);
      color: var(--text-primary);
      font: inherit;
      text-align: left;
      cursor: pointer;
      outline: none;
      -webkit-tap-highlight-color: transparent;
      transition:
        background-color var(--motion-fast) var(--ease-out),
        transform var(--motion-fast) var(--ease-out);
    }
    .mt-record .tile:active {
      background: var(--bg-pressed);
      transform: scale(0.98);
    }
    .mt-record .tile:focus-visible {
      box-shadow: var(--focus-ring);
    }
    .mt-record .tile .glyph {
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border-radius: var(--radius-md);
      background: var(--bg-brand-subtle);
      color: var(--icon-brand);
    }
    .mt-record .tile .tt {
      margin-top: var(--space-12);
      font: 600 16px/22px var(--font-sans);
    }
    .mt-record .tile .ts {
      font: 400 13px/18px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-record .waiting {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-record .scans {
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      background: var(--bg-surface);
    }
    .mt-record .scan {
      display: flex;
      align-items: center;
      gap: var(--space-12);
      min-height: 56px;
      padding: var(--space-8) var(--space-8) var(--space-8) var(--space-12);
    }
    .mt-record .scan + .scan {
      border-top: 1px solid var(--border-subtle);
    }
    .mt-record .scan .doc {
      display: grid;
      place-items: center;
      flex: none;
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
      color: var(--icon-default);
    }
    .mt-record .scan .text {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }
    .mt-record .scan .tt {
      font: 500 14px/20px var(--font-sans);
    }
    .mt-record .scan .ts {
      font: 400 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-record .scan .ts[data-failed] {
      color: var(--text-danger);
    }
    @media (prefers-reduced-motion: reduce) {
      .mt-record .tile:active {
        transform: none;
      }
    }
  `,
})
export class RecordPage {
  private readonly router = inject(Router);
  private readonly dialogs = inject(DialogService);
  protected readonly recents = recentMatters();
  private readonly canTime = can('time.record');
  private readonly canNote = can('note.write');
  private readonly canScan = can('document.upload');
  /** The scan queue, loaded only when a scan is waiting on this device (MOB-05). */
  protected readonly queue = signal<ScanQueue | null>(null);

  /** The recent matter picked from the chips, if any. */
  protected readonly chosen = signal<RecentMatter | null>(null);
  protected readonly hint = computed(() => {
    const matter = this.chosen();
    if (matter) return `Recording on ${matter.number}, ${matter.title}.`;
    return this.recents.items().length
      ? 'Pick a recent matter, or choose one as you record.'
      : 'Choose the matter as you record. The ones you open show here.';
  });
  protected readonly tiles = computed(() => [
    ...(this.canTime()
      ? [{ id: 'time', label: 'Log time', detail: 'Units and a narrative', icon: 'timer' } as const]
      : []),
    ...(this.canNote()
      ? [{ id: 'note', label: 'Note', detail: 'A file note on the matter', icon: 'compose' } as const]
      : []),
    ...(this.canScan()
      ? [{ id: 'scan', label: 'Photo document', detail: 'Scan paper pages to a PDF', icon: 'camera' } as const]
      : []),
  ]);
  private busy = false;

  constructor() {
    const injector = inject(Injector);
    let destroyed = false;
    inject(DestroyRef).onDestroy(() => (destroyed = true));
    void (async () => {
      if (!(await anyScansWaiting())) return;
      const { ScanQueue } = await import('../scan/scan-queue');
      if (!destroyed) this.queue.set(injector.get(ScanQueue));
    })().catch(() => undefined);
  }

  protected stateText(state: ScanState): string {
    if (state.kind === 'offline') return 'Waiting for a connection';
    if (state.kind === 'uploading') return 'Uploading…';
    return state.error ?? 'Didn’t upload';
  }

  protected async discard(queue: ScanQueue, scan: QueuedScan): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Delete this scan?',
      body: `${scan.fileName} hasn’t reached Materia. Deleting it removes it from this device, and it can’t be recovered.`,
      confirmLabel: 'Delete scan',
      tone: 'danger',
    });
    if (confirmed) await queue.discard(scan.id);
  }

  protected choose(matter: RecentMatter): void {
    this.chosen.update((current) => (current?.id === matter.id ? null : matter));
  }

  protected async run(id: RecordTile): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (id === 'time') await this.logTime();
      else if (id === 'note') await this.addNote();
      else await this.scan();
    } finally {
      this.busy = false;
    }
  }

  /** Quick time entry (BILL-01) on the chosen matter, or with its matter search when none is. */
  private async logTime(): Promise<void> {
    const { TimeQuickEntry } = await import('../time/time-quick-entry');
    await this.dialogs.open<TimeQuickEntryData>(TimeQuickEntry, { data: { matterId: this.chosen()?.id ?? null } })
      .result;
  }

  /** Scan a document (MOB-05), for the chosen matter if there is one (otherwise chosen there). */
  private async scan(): Promise<void> {
    const matter = this.chosen()?.id;
    await this.router.navigate(['/record/scan'], matter ? { queryParams: { matter } } : {});
  }

  /** The matter's Notes tab with the editor focused, after asking which matter when none is chosen. */
  private async addNote(): Promise<void> {
    const matterId =
      this.chosen()?.id ??
      (await pickMatter(this.dialogs, 'Add a note', 'Choose the matter the note is for.'))?.matterId;
    if (matterId) await this.router.navigateByUrl(intentUrl(`/matters/${matterId}/notes`, 'add-note'));
  }
}
