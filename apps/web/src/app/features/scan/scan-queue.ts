import { computed, effect, inject, Injectable, InjectionToken, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { Connectivity, OrgContext } from '@materia/data-access';
import { ToastService } from '@materia/ui';

import { indexedDbScanStore, type QueuedScan, type ScanStore } from './scan-db';
import { ScanError } from './scan-processor';
import { DocumentUploads, type UploadItem } from '../documents/document-uploads';

/** Where scans wait: IndexedDB in the browser; tests keep them in memory. */
export const SCAN_STORE = new InjectionToken<ScanStore>('SCAN_STORE', {
  providedIn: 'root',
  factory: () => indexedDbScanStore(),
});

/** A waiting scan: no connection, on its way, or stopped (with why). */
export type ScanState = { kind: 'offline' } | { kind: 'uploading' } | { kind: 'failed'; error?: string | undefined };

/**
 * Finished scans on their way to Materia (MOB-05). Each is kept in IndexedDB until its upload's
 * bytes are stored, so a scan saved offline, or one whose upload broke off, survives closing the
 * app and goes when the connection is back. The uploads themselves are the Documents tab's
 * (CORE-12): the same rows, hash check and pipeline, marked `source: 'camera'`. Only the person
 * who saved a scan uploads it, in the org they saved it in; sign-out deletes the queue.
 */
@Injectable({ providedIn: 'root' })
export class ScanQueue {
  private readonly store = inject(SCAN_STORE);
  private readonly uploads = inject(DocumentUploads);
  private readonly online = inject(Connectivity).online;
  private readonly org = inject(OrgContext);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  private readonly all = signal<readonly QueuedScan[]>([]);
  private readonly loaded = signal(false);
  /** Scans on their way: scan id → its upload row. */
  private readonly sending = signal<ReadonlyMap<string, string>>(new Map());

  /** My scans waiting on this device, oldest first. */
  readonly waiting = computed(() => {
    const uid = this.org.uid();
    const orgId = this.org.orgId();
    return this.all().filter((scan) => scan.uid === uid && scan.orgId === orgId);
  });

  constructor() {
    // Signed in (again) or another org: read what waits.
    effect(() => {
      this.org.generation();
      untracked(() => void this.refresh());
    });
    // Online and signed in: send what waits.
    effect(() => {
      if (this.online() && this.loaded() && this.waiting().length) untracked(() => this.drain());
    });
    // A scan leaves this device once its upload's bytes are stored.
    effect(() => {
      const items = this.uploads.items();
      untracked(() => this.follow(items));
    });
  }

  /** Keeps a finished scan and sends it now if the connection allows. */
  async add(scan: QueuedScan): Promise<{ queued: boolean }> {
    try {
      await this.store.put(scan);
    } catch {
      // No IndexedDB (a private window in some browsers): send it now, or say it can't wait.
      if (!untracked(this.online)) {
        throw new ScanError(
          'This browser can’t keep a scan until you’re back online. Save it when you have a connection.',
        );
      }
      this.send(scan);
      return { queued: false };
    }
    this.all.update((all) => [...all.filter((other) => other.id !== scan.id), scan]);
    this.loaded.set(true);
    if (untracked(this.online)) this.drain();
    return { queued: true };
  }

  /** Where a waiting scan is, for the list on Record. */
  stateOf(scan: QueuedScan): ScanState {
    const key = this.sending().get(scan.id);
    const item = key ? this.uploads.items().find((row) => row.key === key) : undefined;
    if (item?.phase === 'failed' || item?.phase === 'invalid') return { kind: 'failed', error: item.error };
    if (!this.online()) return { kind: 'offline' };
    return { kind: 'uploading' };
  }

  /** Starts again every waiting scan whose upload stopped. */
  retry(): void {
    if (untracked(this.online)) this.drain();
  }

  /** Deletes a waiting scan from this device without uploading it. */
  async discard(id: string): Promise<void> {
    const key = untracked(this.sending).get(id);
    if (key) {
      this.uploads.cancel(key);
      this.forget(id);
    }
    this.all.update((all) => all.filter((entry) => entry.id !== id));
    await this.store.delete(id).catch(() => undefined);
  }

  private async refresh(): Promise<void> {
    try {
      this.all.set(await this.store.list());
    } catch {
      this.all.set([]);
    }
    this.loaded.set(true);
  }

  /** Starts an upload for each waiting scan that has none running; a stopped one starts again. */
  private drain(): void {
    const items = untracked(this.uploads.items);
    for (const scan of untracked(this.waiting)) {
      const key = untracked(this.sending).get(scan.id);
      const item = key ? items.find((row) => row.key === key) : undefined;
      if (item) {
        if (item.phase === 'failed' || item.phase === 'cancelled') this.uploads.retry(item.key);
        continue;
      }
      this.send(scan);
    }
  }

  private send(scan: QueuedScan): void {
    const file = new File([scan.pdf], scan.fileName, { type: 'application/pdf' });
    const { keys } = this.uploads.add(scan.matterId, [file], {
      source: 'camera',
      ...(scan.category ? { category: scan.category } : {}),
      ...(scan.privileged ? { privileged: true } : {}),
    });
    const key = keys[0];
    if (key) this.sending.update((sending) => new Map(sending).set(scan.id, key));
  }

  private forget(id: string): void {
    this.sending.update((sending) => {
      const next = new Map(sending);
      next.delete(id);
      return next;
    });
  }

  private follow(items: readonly UploadItem[]): void {
    for (const [id, key] of untracked(this.sending)) {
      const item = items.find((row) => row.key === key);
      // Its row was dismissed: send it again next time.
      if (!item) this.forget(id);
      else if (item.phase === 'sent') {
        this.forget(id);
        void this.done(id);
      }
    }
  }

  private async done(id: string): Promise<void> {
    const scan = untracked(this.all).find((entry) => entry.id === id);
    // Out of the list first, so nothing sends it again while the store forgets it.
    this.all.update((all) => all.filter((entry) => entry.id !== id));
    await this.store.delete(id).catch(() => undefined);
    if (!scan) return;
    // Someone watching the matter's documents sees the row; anyone else hears about it.
    const documents = `/matters/${scan.matterId}/documents`;
    if (this.router.url.split(/[?#]/)[0] === documents) return;
    this.toasts.show({
      title: 'Scan uploaded',
      description: `${scan.fileName} · ${scan.matterLabel}`,
      tone: 'success',
      action: { label: 'Open', run: () => void this.router.navigateByUrl(documents) },
    });
  }
}
