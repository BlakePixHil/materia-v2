import { computed, effect, inject, Injectable, signal } from '@angular/core';

import { fileSha256, injectDocumentUpload } from '@materia/data-access/repository';
import { findVersion, type UploadSource } from '@materia/domain';

import {
  documentStatus,
  duplicateText,
  fileProblem,
  UPLOAD_BATCH_MAX,
  type DocumentCategory,
  type DocumentRow,
  type DocumentStatus,
} from './documents-view';
import { UPLOAD_PORT, UploadCancelled, type UploadHandle } from './upload-port';
import { ActivityHolds } from '../../core/auth/idle-timeout';

/** Where one file is on this side: queued, hashing, sending, sent (the server takes over), or stopped. */
export type UploadPhase = 'waiting' | 'hashing' | 'uploading' | 'sent' | 'failed' | 'cancelled' | 'invalid';

export interface UploadItem {
  /** Local id for this row. */
  key: string;
  matterId: string;
  fileName: string;
  size: number;
  /** A new version of this document; otherwise a new document. */
  documentId?: string;
  /** The current attempt's upload id (the new document's id); a retry gets a new one. */
  uploadId: string | null;
  phase: UploadPhase;
  /** Bytes sent so far. */
  sent: number;
  /** Why it stopped, in plain words. */
  error?: string;
}

export interface UploadOptions {
  documentId?: string;
  category?: DocumentCategory;
  privileged?: boolean;
  /** A phone scan (MOB-05). */
  source?: UploadSource;
}

/** How many files transfer at the same time; the rest wait their turn. */
const CONCURRENT_UPLOADS = 3;

let nextKey = 0;

/**
 * The uploads started in this tab (CORE-12): up to 20 files at a time, hashed (SHA-256, for the
 * server's check) and sent to the pending area a few at a time, each cancellable and retryable.
 * Once the bytes are sent, the server pipeline takes over and the document's own fields say where
 * it is (`uploadStatus`). Root-provided, so an upload keeps going while you move between the
 * Documents tab and a document.
 */
@Injectable({ providedIn: 'root' })
export class DocumentUploads {
  private readonly port = inject(UPLOAD_PORT);
  private readonly plan = injectDocumentUpload();
  private readonly files = new Map<string, File>();
  private readonly options = new Map<string, UploadOptions>();
  private readonly handles = new Map<string, UploadHandle>();
  private readonly cancelled = new Set<string>();

  private readonly list = signal<readonly UploadItem[]>([]);
  readonly items = this.list.asReadonly();
  private readonly active = computed(
    () => this.list().filter((item) => item.phase === 'hashing' || item.phase === 'uploading').length,
  );

  constructor() {
    // Uploads under way (or queued) defer the inactivity sign-out (SEC-04).
    const holds = inject(ActivityHolds);
    let release: (() => void) | null = null;
    effect(() => {
      const busy = this.list().some((item) => ['waiting', 'hashing', 'uploading'].includes(item.phase));
      if (busy && !release) release = holds.hold();
      else if (!busy && release) {
        release();
        release = null;
      }
    });
  }

  /** The uploads for one matter, oldest first. */
  forMatter(matterId: string): UploadItem[] {
    return this.list().filter((item) => item.matterId === matterId);
  }

  /**
   * Queues files for a matter. At most 20 are taken at once (the rest are returned as `dropped`);
   * files that can't be uploaded (type, size, empty) are listed with the reason and not sent.
   * `keys` are the new rows, in the files' order, for following them.
   */
  add(
    matterId: string,
    files: readonly File[],
    options: UploadOptions = {},
  ): { added: number; dropped: number; keys: string[] } {
    const taken = files.slice(0, UPLOAD_BATCH_MAX);
    const items = taken.map((file): UploadItem => {
      const key = `u${++nextKey}`;
      const problem = fileProblem(file);
      if (!problem) {
        this.files.set(key, file);
        this.options.set(key, options);
      }
      return {
        key,
        matterId,
        fileName: file.name,
        size: file.size,
        ...(options.documentId ? { documentId: options.documentId } : {}),
        uploadId: null,
        phase: problem ? 'invalid' : 'waiting',
        sent: 0,
        ...(problem ? { error: problem } : {}),
      };
    });
    this.list.update((list) => [...list, ...items]);
    this.pump();
    return { added: items.length, dropped: files.length - taken.length, keys: items.map((item) => item.key) };
  }

  cancel(key: string): void {
    const item = this.find(key);
    if (!item || !['waiting', 'hashing', 'uploading'].includes(item.phase)) return;
    this.cancelled.add(key);
    this.handles.get(key)?.cancel();
    this.patch(key, { phase: 'cancelled', sent: 0 });
    this.pump();
  }

  /** Sends the file again under a new upload id (a refused or interrupted upload can't be resumed). */
  retry(key: string): void {
    const item = this.find(key);
    if (!item || !this.files.has(key) || ['waiting', 'hashing', 'uploading'].includes(item.phase)) return;
    this.cancelled.delete(key);
    this.patch(key, { phase: 'waiting', sent: 0, uploadId: null, error: undefined });
    this.pump();
  }

  /** Removes a row (cancelling it first if it's still running). */
  dismiss(key: string): void {
    this.cancel(key);
    this.files.delete(key);
    this.options.delete(key);
    this.handles.delete(key);
    this.list.update((list) => list.filter((item) => item.key !== key));
  }

  /** Removes the matter's rows that need nothing more from anyone. */
  clear(keys: readonly string[]): void {
    for (const key of keys) this.dismiss(key);
  }

  private find(key: string): UploadItem | undefined {
    return this.list().find((item) => item.key === key);
  }

  private patch(key: string, change: Partial<Omit<UploadItem, 'error'>> & { error?: string | undefined }): void {
    this.list.update((list) =>
      list.map((item) => {
        if (item.key !== key) return item;
        const next = { ...item, ...change } as UploadItem & { error?: string | undefined };
        if (next.error === undefined) delete next.error;
        return next as UploadItem;
      }),
    );
  }

  /** Starts waiting uploads while fewer than three are running. */
  private pump(): void {
    let running = this.active();
    for (const item of this.list()) {
      if (running >= CONCURRENT_UPLOADS) return;
      if (item.phase !== 'waiting') continue;
      running++;
      void this.run(item.key);
    }
  }

  private async run(key: string): Promise<void> {
    const file = this.files.get(key);
    const item = this.find(key);
    if (!file || !item) return;
    const options = this.options.get(key) ?? {};
    this.patch(key, { phase: 'hashing' });
    try {
      const sha256 = await fileSha256(file);
      if (this.cancelled.has(key)) return;
      const planned = this.plan(item.matterId, {
        fileName: file.name,
        sha256,
        ...(options.documentId ? { documentId: options.documentId } : {}),
        ...(options.category ? { category: options.category } : {}),
        ...(options.privileged ? { privileged: true } : {}),
        ...(options.source ? { source: options.source } : {}),
      });
      this.patch(key, { phase: 'uploading', uploadId: planned.uploadId, sent: 0 });
      const handle = this.port.upload(planned.path, file, planned.settings, ({ sent }) => {
        if (!this.cancelled.has(key)) this.patch(key, { sent });
      });
      this.handles.set(key, handle);
      await handle.done;
      if (!this.cancelled.has(key)) this.patch(key, { phase: 'sent', sent: file.size });
    } catch (error) {
      if (this.cancelled.has(key) || error instanceof UploadCancelled) return;
      this.patch(key, { phase: 'failed', error: uploadErrorCopy(error) });
    } finally {
      this.handles.delete(key);
      this.pump();
    }
  }
}

/** A failed transfer in plain words (no server or SDK text). */
export function uploadErrorCopy(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'storage/unauthorized') return 'Your role can’t add documents to this matter.';
  if (code === 'storage/quota-exceeded') return 'There’s no room to store this file right now. Try again later.';
  if (code === 'INVALID_ARGUMENT') return 'This type of file can’t be added.';
  return 'The upload didn’t finish. Check your connection and try again.';
}

/** What an upload row shows: the transfer, then the document's own pipeline status. */
export interface UploadView {
  text: string;
  tone: DocumentStatus['tone'];
  /** 0–100 while sending. */
  percent: number | null;
  /** The document it became (to open it), once it exists. */
  docId: string | null;
  canCancel: boolean;
  canRetry: boolean;
  /** Needs a decision: keep both copies or discard this one. */
  duplicate: boolean;
  /** Nothing more will happen: it is ready, or refused for good. */
  finished: boolean;
}

/**
 * The row for an upload, given the documents the tab can see. A new document's id is its upload
 * id; a new version shows the target document's `upload` while that is this upload, and is done
 * once a version came from it.
 */
export function uploadView(item: UploadItem, docs: ReadonlyMap<string, DocumentRow>): UploadView {
  const base = { percent: null, docId: null, canCancel: false, canRetry: false, duplicate: false, finished: false };
  switch (item.phase) {
    case 'invalid':
      return { ...base, text: item.error ?? 'This file can’t be added.', tone: 'danger', finished: true };
    case 'waiting':
      return { ...base, text: 'Waiting…', tone: 'neutral', canCancel: true };
    case 'hashing':
      return { ...base, text: 'Preparing…', tone: 'neutral', canCancel: true };
    case 'uploading': {
      const percent = item.size ? Math.min(100, Math.round((item.sent / item.size) * 100)) : 0;
      return { ...base, text: `Uploading ${percent}%`, tone: 'info', percent, canCancel: true };
    }
    case 'cancelled':
      return { ...base, text: 'Cancelled', tone: 'neutral', canRetry: true, finished: true };
    case 'failed':
      return { ...base, text: item.error ?? 'The upload didn’t finish.', tone: 'danger', canRetry: true };
    case 'sent':
      return serverView(item, docs, base);
  }
}

function serverView(
  item: UploadItem,
  docs: ReadonlyMap<string, DocumentRow>,
  base: Omit<UploadView, 'text' | 'tone'>,
): UploadView {
  const waiting = { ...base, text: 'Checking the file…', tone: 'info' as const };
  if (item.documentId) {
    const doc = docs.get(item.documentId);
    if (!doc) return waiting;
    const version = doc.versions.find((entry) => entry.uploadId === item.uploadId);
    if (version) {
      return { ...base, text: `Added as version ${version.version}`, tone: 'success', docId: doc.id, finished: true };
    }
    if (doc.upload?.uploadId !== item.uploadId) return { ...waiting, docId: doc.id };
    return pipelineView(documentStatus({ ...doc, version: 1, duplicateOf: undefined }), doc.id, base);
  }
  const doc = item.uploadId ? docs.get(item.uploadId) : undefined;
  if (!doc) return waiting;
  const status = documentStatus(doc);
  if (status.kind === 'duplicate') {
    return {
      ...base,
      text: duplicateText(doc.duplicateOf ? docs.get(doc.duplicateOf) : undefined),
      tone: 'warning',
      docId: doc.id,
      duplicate: true,
    };
  }
  if (status.kind === 'removed') return { ...base, text: 'Discarded', tone: 'neutral', finished: true };
  if (status.kind === 'ready' || status.kind === 'queued') {
    const version = findVersion(doc);
    return {
      ...base,
      text: version ? 'Ready' : 'Checking the file…',
      tone: 'success',
      docId: doc.id,
      finished: !!version,
    };
  }
  return pipelineView(status, doc.id, base);
}

function pipelineView(status: DocumentStatus, docId: string, base: Omit<UploadView, 'text' | 'tone'>): UploadView {
  const refused = status.kind === 'infected' || status.kind === 'rejected' || status.kind === 'expired';
  const text = status.detail && refused ? `${status.label}: ${status.detail}` : status.label;
  return {
    ...base,
    text,
    tone: status.tone,
    docId,
    // A refused file can be sent again (unless it was infected); a quarantined one is gone.
    canRetry: status.kind === 'rejected' || status.kind === 'expired',
    finished: refused,
  };
}
