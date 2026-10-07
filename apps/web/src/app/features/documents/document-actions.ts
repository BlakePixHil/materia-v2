import { inject, Injectable, InjectionToken, signal } from '@angular/core';

import { documentCallables, matterDocumentRepository, type DocumentItem } from '@materia/data-access/repository';
import {
  DOCUMENTS_ZIP_MAX,
  DomainError,
  type BulkDocumentChange,
  type DocumentVersion,
  type DownloadRendition,
  type StartZipResult,
} from '@materia/domain';
import { DialogService, ToastService } from '@materia/ui';

import { DOCUMENT_CATEGORY_LABELS, documentCount } from './documents-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { MatterScreen } from '../matter-detail/matter-screen';

/**
 * Starts a download: the browser goes to the signed URL, which is served as an attachment, so the
 * page stays where it is. Tests replace it.
 */
export const DOWNLOAD_NAVIGATOR = new InjectionToken<(url: string) => void>('DOWNLOAD_NAVIGATOR', {
  providedIn: 'root',
  factory: () => (url: string) => window.location.assign(url),
});

/** The device's share sheet (the Web Share API), when it has one. Tests replace it. */
export interface WebShare {
  canShare(data: ShareData): boolean;
  share(data: ShareData): Promise<void>;
}

export const WEB_SHARE = new InjectionToken<WebShare | null>('WEB_SHARE', {
  providedIn: 'root',
  factory: () => {
    const nav = typeof navigator === 'undefined' ? null : navigator;
    if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return null;
    return { canShare: (data) => nav.canShare(data), share: (data) => nav.share(data) };
  },
});

/** Reads a signed URL's bytes. Tests replace it. */
export const FILE_FETCHER = new InjectionToken<(url: string) => Promise<Blob>>('FILE_FETCHER', {
  providedIn: 'root',
  factory: () => async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The file didn’t load (HTTP ${response.status})`);
    return response.blob();
  },
});

/** Bigger files download instead of sharing: the share sheet holds the whole file in memory. */
export const SHARE_MAX_BYTES = 25 * 1024 * 1024;

/** The version a share sends: its number, file name, type and size. */
export type SharedVersion = Pick<DocumentVersion, 'version' | 'fileName' | 'mime' | 'sizeBytes'>;

/** The reason a callable gave (`details.reason`), if any. */
export function errorReason(error: unknown): string | undefined {
  const details = error instanceof DomainError ? error.details : (error as { details?: unknown } | null)?.details;
  const reason = (details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** A failed download or preview in plain words. */
export function downloadErrorCopy(error: unknown): string {
  const reason = errorReason(error);
  if (reason === 'not_scanned') return 'This file hasn’t passed the malware check yet, so it can’t be opened.';
  if (reason === 'rendition_unavailable') return 'Preview not available yet; download instead.';
  if (error instanceof DomainError && error.code === 'NOT_FOUND') {
    return 'This document isn’t available. It may have been removed, or your role can’t open it.';
  }
  return errorCopy(error);
}

/** A zip download that didn't start, in plain words. */
export function zipErrorCopy(error: unknown): string {
  const reason = errorReason(error);
  if (reason === 'nothing_to_zip') {
    return 'None of these documents can be downloaded. They may still be in the malware check, or your role can’t open them.';
  }
  if (reason === 'too_large') return 'These documents are more than 1 GB together. Download fewer at a time.';
  return downloadErrorCopy(error);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the Documents tab and the document viewer do to a matter's documents (CORE-12): metadata
 * edits client-direct through the repository (the rules check the fields and roles), and the
 * `documents-*` callables for downloads, versions, duplicates, bulk changes and email attachments.
 * Provide it on the page, under the matter screen.
 */
@Injectable()
export class DocumentActions {
  private readonly screen = inject(MatterScreen);
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly navigate = inject(DOWNLOAD_NAVIGATOR);
  private readonly webShare = inject(WEB_SHARE);
  private readonly fetchFile = inject(FILE_FETCHER);
  /** The last file read for sharing, so sharing it again doesn't read it again. */
  private shared: { key: string; file: File } | null = null;
  readonly api = documentCallables(inject(CALLABLES));
  readonly repo = matterDocumentRepository(() => this.screen.id());

  /** A bulk change or callable is on its way. */
  readonly busy = signal(false);

  private matterId(): string {
    const id = this.screen.id();
    if (!id) throw new DomainError('FAILED_PRECONDITION', 'No matter');
    return id;
  }

  /** Saves metadata fields (name, category, tags, notes, privileged). True when saved. */
  async update(docId: string, patch: Partial<DocumentItem>, done?: string): Promise<boolean> {
    try {
      await this.repo.update(docId, patch);
      if (done) this.toasts.show({ title: done, tone: 'success' });
      return true;
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t save the change', description: errorCopy(error), tone: 'danger' });
      return false;
    }
  }

  /** This device has a share sheet (Web Share API): phones, and some desktop browsers. */
  readonly canShare = !!this.webShare;

  /**
   * Sends a version through the device's share sheet (MOB-02): the file itself, read through a
   * 5-minute signed URL, never the link, which would expire and could be forwarded. A file too big
   * to share, or a device that can't share files, downloads it instead.
   */
  async share(docId: string, version: SharedVersion): Promise<void> {
    const share = this.webShare;
    if (!share || version.sizeBytes > SHARE_MAX_BYTES) return this.download(docId, version.version);
    const key = `${docId}@${version.version}`;
    let file = this.shared?.key === key ? this.shared.file : null;
    const read = !file;
    if (!file) {
      try {
        const blob = await this.fetchFile(await this.readUrl(docId, version.version, 'original'));
        file = new File([blob], version.fileName, { type: version.mime });
        this.shared = { key, file };
      } catch (error) {
        this.toasts.show({ title: 'Couldn’t share the file', description: downloadErrorCopy(error), tone: 'danger' });
        return;
      }
    }
    const data: ShareData = { files: [file], title: version.fileName };
    if (!share.canShare(data)) return this.download(docId, version.version);
    try {
      await share.share(data);
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      // Closed the share sheet without choosing anything.
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError' && read) {
        // Reading the file took long enough that the browser no longer counts it as the tap: ask for one more.
        this.toasts.show({
          title: 'Ready to share',
          description: version.fileName,
          action: { label: 'Share', run: () => void share.share(data).catch(() => undefined) },
        });
        return;
      }
      this.toasts.show({ title: 'Couldn’t share the file', description: errorCopy(error), tone: 'danger' });
    }
  }

  /** Downloads a version (current by default) through a 5-minute signed URL. */
  async download(docId: string, version?: number): Promise<void> {
    try {
      const { url } = await this.api.getDownloadUrl({
        matterId: this.matterId(),
        docId,
        ...(version ? { version } : {}),
      });
      this.navigate(url);
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t download the file', description: downloadErrorCopy(error), tone: 'danger' });
    }
  }

  /**
   * Starts a zip of documents' current versions (CORE-12b), built by a background job; watch the
   * returned job, then call `downloadZip`. Says how many were left out. Null when it didn't start.
   */
  async startZip(docIds: readonly string[]): Promise<StartZipResult | null> {
    if (docIds.length > DOCUMENTS_ZIP_MAX) {
      this.toasts.show({
        title: 'Too many documents for one zip',
        description: `Select up to ${DOCUMENTS_ZIP_MAX} documents at a time.`,
        tone: 'danger',
      });
      return null;
    }
    try {
      const result = await this.api.startZip({ matterId: this.matterId(), docIds: [...docIds] });
      if (result.skipped) {
        this.toasts.show({
          title: `${plural(result.skipped, 'document')} left out of the zip`,
          description:
            'Removed documents, documents still in the malware check and any your role can’t open aren’t included.',
        });
      }
      return result;
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t prepare the zip', description: zipErrorCopy(error), tone: 'danger' });
      return null;
    }
  }

  /** Downloads a finished zip through a 5-minute signed URL. */
  async downloadZip(jobId: string): Promise<void> {
    try {
      const { url } = await this.api.exportUrl(jobId);
      this.navigate(url);
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t download the zip', description: errorCopy(error), tone: 'danger' });
    }
  }

  /**
   * The stored text of a version's pages (`documents-citationText`), by page: for a scanned PDF page,
   * what OCR read from it. Only the current version keeps it. Throws on failure.
   */
  async pageText(docId: string, version: number, pages: number[]): Promise<Map<number, string>> {
    const result = await this.api.citationText({ matterId: this.matterId(), docId, version, pages });
    return new Map(result.pages.map((page) => [page.page, page.text]));
  }

  /** A signed URL to read a version or one of its renditions in the viewer. Throws on failure. */
  async readUrl(docId: string, version: number | undefined, rendition: DownloadRendition): Promise<string> {
    const { url } = await this.api.getDownloadUrl({
      matterId: this.matterId(),
      docId,
      ...(version ? { version } : {}),
      rendition,
    });
    return url;
  }

  async restoreVersion(docId: string, version: number): Promise<void> {
    await this.run(async () => {
      const result = await this.api.restoreVersion({ matterId: this.matterId(), docId, version });
      this.toasts.show({
        title: `Version ${result.restoredFrom} restored`,
        description: `It is now version ${result.version}. Earlier versions are kept.`,
        tone: 'success',
      });
    }, 'Couldn’t restore the version');
  }

  async resolveDuplicate(docId: string, action: 'keep' | 'discard'): Promise<void> {
    await this.run(async () => {
      await this.api.resolveDuplicate({ matterId: this.matterId(), docId, action });
      this.toasts.show({ title: action === 'keep' ? 'Kept both copies' : 'Copy discarded', tone: 'success' });
    }, 'Couldn’t resolve the duplicate');
  }

  /** Moves documents to a category. */
  async moveToCategory(docIds: readonly string[], category: DocumentItem['category']): Promise<boolean> {
    return this.bulk(
      docIds,
      { op: 'category', category },
      (n) => `${plural(n, 'document')} moved to ${DOCUMENT_CATEGORY_LABELS[category]}`,
    );
  }

  /** Removes documents after asking. They stay resolvable as "Removed document" and can be restored. */
  async remove(docIds: readonly string[]): Promise<boolean> {
    const confirmed = await this.dialogs.confirm({
      title: docIds.length === 1 ? 'Remove this document?' : `Remove ${documentCount(docIds.length)}?`,
      body: 'Anything that cites it will show “Removed document”. Someone who can remove documents can restore it from “Show removed”.',
      confirmLabel: docIds.length === 1 ? 'Remove document' : 'Remove documents',
      tone: 'danger',
    });
    if (!confirmed) return false;
    return this.bulk(docIds, { op: 'delete' }, (n) => `${plural(n, 'document')} removed`);
  }

  async restore(docIds: readonly string[]): Promise<boolean> {
    return this.bulk(docIds, { op: 'restore' }, (n) => `${plural(n, 'document')} restored`);
  }

  /** Saves an email's attachment to the matter; it goes through the same checks as an upload. */
  async saveAttachment(docId: string, version: number | undefined, attachmentIndex: number): Promise<boolean> {
    return this.run(async () => {
      const result = await this.api.saveAttachment({
        matterId: this.matterId(),
        docId,
        ...(version ? { version } : {}),
        attachmentIndex,
      });
      this.toasts.show({
        title: `${result.fileName} saved to the matter`,
        description: 'It shows in Documents once the malware check is done.',
        tone: 'success',
      });
    }, 'Couldn’t save the attachment');
  }

  private async bulk(
    docIds: readonly string[],
    change: BulkDocumentChange,
    summary: (updated: number) => string,
  ): Promise<boolean> {
    return this.run(async () => {
      const result = await this.api.bulkUpdate({ matterId: this.matterId(), docIds: [...docIds], change });
      const skipped = result.skipped.length;
      this.toasts.show({
        title: summary(result.updated),
        ...(skipped ? { description: `${plural(skipped, 'document')} didn’t need changing.` } : {}),
        tone: 'success',
      });
    }, 'Couldn’t change the documents');
  }

  private async run(work: () => Promise<void>, failure: string): Promise<boolean> {
    this.busy.set(true);
    try {
      await work();
      return true;
    } catch (error) {
      this.toasts.show({ title: failure, description: downloadErrorCopy(error), tone: 'danger' });
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
