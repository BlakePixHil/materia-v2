import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import { chunkPages, normaliseText } from '@materia/clerk';
import { DocIdSchema, type DocumentIngest, type DocumentVersion, type IngestSkipReason } from '@materia/domain';

import { reserveOcrPages, refundOcrPages, nextBudgetDay, budgetDay } from './budget';
import { deleteChunks, syncChunksPrivileged, writeChunks, type ChunkRecord } from './chunks';
import { writeDocumentMetaSuggestion } from './classify';
import { OcrUnavailableError, type IngestClerk } from './clerk';
import { openSource, type PageSource } from './extract';
import { detectLanguage } from './language';
import { isDeleted } from '../../contacts/shared';
import type { Log } from '../../core/log';
import type { Clock, EmbeddingPort, TaskQueuePort } from '../../ports';
import type { FileStore } from '../files';
import { documentPath, isClean, versionsOf } from '../shared';

/**
 * Clerk ingestion of one document version (AI-04, ADR-012): extract each page's text (OCR for
 * scanned pages, within the org's daily budget), chunk it without crossing pages, embed the
 * chunks with Vertex AI, store them under the document for vector search, and suggest the
 * document's metadata.
 *
 * - **Idempotent by `(docId, version)`.** A version already `done` or `skipped` is left alone; a
 *   newer version makes the task stale. Chunk ids are `{version}-{ordinal}`, so a retried batch
 *   overwrites itself.
 * - **Resumable.** Pages go in batches of `CHECKPOINT_PAGES`; after each, `ingest.checkpoint`
 *   records the next page and chunk ordinal. A retry, or the continuation task a long PDF hands
 *   over to before the function's time runs out, starts there (ADR-014: a Cloud Tasks-driven
 *   function with checkpointing).
 * - **Cost-bounded.** OCR pages are reserved from the org's daily budget first; past it the
 *   document is `queued` until the next day.
 */

export const INGEST_QUEUE = 'documents-ingest';
export const CHECKPOINT_PAGES = 50;
/** Hand over to a continuation task after this long, leaving room before the 540 s timeout. */
export const TIME_BUDGET_MS = 360_000;
/** Classification reads the first pages only. */
export const CLASSIFY_PAGES = 3;
const CLASSIFY_MAX_CHARS = 24_000;

export const IngestTaskSchema = z.object({
  orgId: DocIdSchema,
  matterId: DocIdSchema,
  docId: DocIdSchema,
  version: z.number().int().min(1),
});
export type IngestTask = z.infer<typeof IngestTaskSchema>;

export interface IngestDeps {
  db: Firestore;
  files: FileStore;
  embedding: EmbeddingPort;
  clerk: IngestClerk;
  tasks: TaskQueuePort;
  clock: Clock;
  log: Log;
  timeBudgetMs?: number;
  /** Milliseconds, for the time budget (tests advance it). */
  now?: () => number;
}

export type IngestOutcome = 'done' | 'skipped' | 'stale' | 'already_done' | 'queued' | 'continued';

/** The document changed under the run (a newer version, or it was removed): stop quietly. */
class StaleIngest extends Error {}

type Data = Record<string, unknown>;

const FINISHED = new Set(['done', 'skipped']);

/** The `ingest` state to write: drops undefined fields (Firestore rejects them). */
const clean = (state: DocumentIngest): DocumentIngest =>
  Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined)) as DocumentIngest;

/** Dedupe key of the task that ingests a version (a suffix tells continuations and requeues apart). */
export const ingestTaskKey = (task: IngestTask, suffix: string) =>
  `ingest#${task.orgId}#${task.matterId}#${task.docId}#v${task.version}#${suffix}`;

export async function ingestDocument(task: IngestTask, deps: IngestDeps): Promise<IngestOutcome> {
  const { db, log } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.timeBudgetMs ?? TIME_BUDGET_MS;
  const ids = { matterId: task.matterId, docId: task.docId, version: task.version };
  const ref = db.doc(documentPath(task.orgId, task.matterId, task.docId));

  const doc = (await ref.get()).data();
  if (!doc || isDeleted(doc) || !isClean(doc) || doc['version'] !== task.version) return 'stale';
  const previous = (doc['ingest'] ?? { status: 'pending' }) as DocumentIngest;
  if (previous.version === task.version && FINISHED.has(previous.status)) return 'already_done';
  const version = versionsOf(doc).find((v) => v.version === task.version);
  if (!version) return 'stale';

  /** Writes `ingest` while the document is still on this version (else the run is stale). */
  const save = async (state: DocumentIngest) => {
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (!current || isDeleted(current) || current['version'] !== task.version) throw new StaleIngest();
      tx.update(ref, { ingest: clean(state) });
    });
  };

  const resuming = previous.version === task.version && !!previous.checkpoint && !FINISHED.has(previous.status);
  let state: DocumentIngest = resuming
    ? { ...previous, status: 'running' }
    : {
        status: 'running',
        version: task.version,
        pages: 0,
        ocrPages: 0,
        chars: 0,
        chunks: 0,
        checkpoint: { nextPage: 1, nextOrdinal: 0 },
      };

  const finishSkipped = async (reason: IngestSkipReason) => {
    await deleteChunks(db, ref);
    await save({ status: 'skipped', version: task.version, reason, at: deps.clock.now() });
    log.info('ingest skipped', { ...ids, reason });
    return 'skipped' as const;
  };

  let source: PageSource | undefined;
  try {
    // A fresh run (a new version, or a re-ingest) starts with no chunks.
    if (!resuming) await deleteChunks(db, ref);
    if (doc['encrypted'] === true || version.encrypted) return await finishSkipped('encrypted');

    // HEIC photos have a JPEG preview (CORE-12a) that OCR can read; other files are read as stored.
    let fileName = version.fileName;
    let path = version.storagePath;
    if (/\.heic$/i.test(fileName) && version.renditions?.previewImage) {
      fileName = 'preview.jpg';
      path = version.renditions.previewImage;
    }
    const data = await deps.files.read(path);
    if (!data) throw new Error('Stored version not found');
    const opened = await openSource(fileName, data);
    if (!opened.ok) return await finishSkipped(opened.reason);
    source = opened.source;
    state = { ...state, pages: source.pageCount };
    await save(state);

    let ocrOff = false;
    let firstPages = '';
    const languages: string[] = [];

    for (;;) {
      const checkpoint = state.checkpoint ?? { nextPage: 1, nextOrdinal: 0 };
      if (checkpoint.nextPage > source.pageCount) break;
      if (now() - started > budget) {
        await save(state);
        await deps.tasks.enqueue(INGEST_QUEUE, task, { dedupeKey: ingestTaskKey(task, `p${checkpoint.nextPage}`) });
        log.info('ingest continues in a new task', { ...ids, nextPage: checkpoint.nextPage });
        return 'continued';
      }
      const to = Math.min(checkpoint.nextPage + CHECKPOINT_PAGES - 1, source.pageCount);
      const pages = (await source.pages(checkpoint.nextPage, to)).map((p) => ({ ...p, ocr: false }));

      // OCR the scanned pages, as far as today's budget goes.
      const needing = pages.filter((p) => p.needsOcr);
      let stopAt: number | undefined;
      let lowConfidence: number[] = [];
      let ocrUnavailable = 0;
      let ocrDone = 0;
      if (needing.length && !ocrOff) {
        const granted = await reserveOcrPages(db, task.orgId, needing.length, deps.clock.now());
        if (granted < needing.length) stopAt = needing[granted]?.page;
        try {
          for (const page of needing.slice(0, granted)) {
            const input = await source.ocrInput(page.page);
            const out = await deps.clerk.ocr({
              orgId: task.orgId,
              docId: task.docId,
              version: task.version,
              page: page.page,
              fileName: version.fileName,
              pdfBase64: input.base64,
            });
            ocrDone++;
            page.text = normaliseText(out.text);
            page.ocr = true;
            if (out.lowConfidence) lowConfidence.push(page.page);
            if (out.language) languages.push(out.language);
          }
        } catch (error) {
          await refundOcrPages(db, task.orgId, granted - ocrDone, deps.clock.now());
          if (!(error instanceof OcrUnavailableError)) throw error;
          ocrOff = true;
          // Without OCR the rest of the document is read as far as its text layer goes, today.
          stopAt = undefined;
          log.info('ocr unavailable', { ...ids, code: error.code });
        }
      }
      const kept = stopAt === undefined ? pages : pages.filter((p) => p.page < stopAt);
      ocrUnavailable = kept.filter((p) => p.needsOcr && !p.ocr).length;
      lowConfidence = lowConfidence.filter((page) => stopAt === undefined || page < stopAt);

      // Chunk, embed, store.
      const chunks = chunkPages(
        kept.map((p) => ({ page: p.page, text: p.text })),
        { startOrdinal: checkpoint.nextOrdinal },
      );
      const ocrPages = new Set(kept.filter((p) => p.ocr).map((p) => p.page));
      const vectors = chunks.length
        ? await deps.embedding.embed(
            chunks.map((c) => c.text),
            { task: 'document' },
          )
        : [];
      const privileged = (await ref.get()).get('privileged') === true;
      const records: ChunkRecord[] = chunks.map((chunk, i) => ({
        orgId: task.orgId,
        matterId: task.matterId,
        text: chunk.text,
        page: chunk.page,
        docVersion: task.version,
        ordinal: chunk.ordinal,
        privileged,
        ...(ocrPages.has(chunk.page) ? { ocr: true } : {}),
        embedding: vectors[i] ?? [],
      }));
      await writeChunks(db, ref, records, deps.clock.now());

      for (const p of kept.filter((p) => p.page <= CLASSIFY_PAGES && p.text)) {
        firstPages += `--- Page ${p.page} ---\n${p.text}\n\n`;
      }
      if (languages.length === 0 && !state.language) {
        const guess = detectLanguage(
          kept
            .map((p) => p.text)
            .join(' ')
            .slice(0, 20_000),
        );
        if (guess === 'und') languages.push('und');
      }
      const low = [...(state.lowConfidencePages ?? []), ...lowConfidence].slice(0, 1000);
      state = {
        ...state,
        ocrPages: (state.ocrPages ?? 0) + ocrPages.size,
        ocr: (state.ocrPages ?? 0) + ocrPages.size > 0,
        chars: (state.chars ?? 0) + kept.reduce((sum, p) => sum + p.text.length, 0),
        chunks: (state.chunks ?? 0) + chunks.length,
        ...(low.length ? { lowConfidencePages: low } : {}),
        ...(ocrUnavailable ? { ocrUnavailablePages: (state.ocrUnavailablePages ?? 0) + ocrUnavailable } : {}),
        ...(nonEnglish(languages) ? { language: nonEnglish(languages) } : {}),
        checkpoint: { nextPage: stopAt ?? to + 1, nextOrdinal: checkpoint.nextOrdinal + chunks.length },
      };

      if (stopAt !== undefined) {
        // Over today's OCR budget: queued until tomorrow ("Queued"), resuming at this page.
        const until = nextBudgetDay(deps.clock.now());
        state = { ...state, status: 'queued', queuedUntil: until };
        await save(state);
        await deps.tasks.enqueue(INGEST_QUEUE, task, {
          scheduleTime: until,
          dedupeKey: ingestTaskKey(task, `q${budgetDay(until)}p${stopAt}`),
        });
        log.info('ingest queued (ocr budget)', { ...ids, nextPage: stopAt });
        return 'queued';
      }
      await save(state);
    }

    // Finished: classify, make sure the privileged flag held, record the result.
    if (!state.chunks) return await finishSkipped(state.ocrUnavailablePages ? 'ocr_unavailable' : 'empty');
    let language = state.language;
    const classification = await classify(task, deps, ref, version, firstPages, state);
    if (classification) {
      const code = classification.output.language.toLowerCase();
      if (code && code !== 'en' && !language) language = code;
    }
    await deleteChunks(db, ref, task.version);
    const current = (await ref.get()).get('privileged') === true;
    await syncChunksPrivileged(db, ref, current);
    const rest = { ...state };
    delete rest.checkpoint;
    delete rest.queuedUntil;
    await save({ ...rest, status: 'done', ...(language ? { language } : {}), at: deps.clock.now() });
    log.info('ingested', {
      ...ids,
      pages: state.pages,
      ocrPages: state.ocrPages,
      chunks: state.chunks,
      chars: state.chars,
      classified: !!classification,
    });
    return 'done';
  } catch (error) {
    if (error instanceof StaleIngest) {
      log.info('ingest stale', ids);
      return 'stale';
    }
    throw error;
  } finally {
    await source?.close();
  }
}

/** The first non-English language code seen, if any. */
function nonEnglish(codes: string[]): string | undefined {
  return codes.map((code) => code.toLowerCase().slice(0, 8)).find((code) => code && code !== 'en');
}

/** Classification is best effort: any failure is logged and the document is still ingested. */
async function classify(
  task: IngestTask,
  deps: IngestDeps,
  ref: DocumentReference,
  version: Pick<DocumentVersion, 'fileName' | 'uploadedBy'>,
  firstPages: string,
  state: DocumentIngest,
) {
  const ids = { matterId: task.matterId, docId: task.docId, version: task.version };
  try {
    let text = firstPages;
    // A resumed run no longer has the first pages in memory: rebuild them from the stored chunks.
    if (!text) {
      const snaps = await ref.collection('chunks').where('page', '<=', CLASSIFY_PAGES).get();
      const chunks = snaps.docs
        .map((s) => s.data() as Data)
        .filter((c) => c['docVersion'] === task.version)
        .sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']));
      text = chunks.map((c) => `--- Page ${String(c['page'])} ---\n${String(c['text'])}\n\n`).join('');
    }
    if (!text.trim()) return null;
    const result = await deps.clerk.classify({
      orgId: task.orgId,
      docId: task.docId,
      version: task.version,
      fileName: version.fileName,
      text: text.slice(0, CLASSIFY_MAX_CHARS),
      pageCount: Math.min(CLASSIFY_PAGES, state.pages ?? CLASSIFY_PAGES),
    });
    if (!result) return null;
    await writeDocumentMetaSuggestion(
      { db: deps.db, orgId: task.orgId, clock: deps.clock, log: deps.log, ports: { tasks: deps.tasks } },
      {
        matterId: task.matterId,
        docId: task.docId,
        version: task.version,
        uploaderUid: version.uploadedBy,
        output: result.output,
        model: result.model,
        promptRef: result.promptRef,
      },
    );
    return result;
  } catch (error) {
    deps.log.warn('classification failed', { ...ids, errorType: error instanceof Error ? error.name : typeof error });
    return null;
  }
}

/** Marks a version's ingest as failed (the task ran out of retries). */
/**
 * A short label for a failed ingest: the error's name, its code when it has one, and the start of
 * its message up to the first path-like word (storage paths can hold file names).
 */
export function ingestErrorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  const code = (error as { code?: unknown }).code;
  // Everything from the first path-like word on goes: a storage path can end in a file name with spaces.
  const words = error.message.split(/\s+/).filter(Boolean);
  const cut = words.findIndex((word) => word.includes('/'));
  const message = (cut < 0 ? words : [...words.slice(0, cut), '[path]']).join(' ').slice(0, 120);
  return `${error.name}${code !== undefined ? ` (${String(code)})` : ''}${message ? `: ${message}` : ''}`.slice(0, 200);
}

export async function markIngestFailed(db: Firestore, task: IngestTask, error: unknown, at: Date): Promise<void> {
  const ref = db.doc(documentPath(task.orgId, task.matterId, task.docId));
  await db.runTransaction(async (tx) => {
    const doc = (await tx.get(ref)).data();
    if (!doc || doc['version'] !== task.version) return;
    const ingest = (doc['ingest'] ?? {}) as DocumentIngest;
    if (FINISHED.has(ingest.status)) return;
    tx.update(ref, {
      ingest: clean({
        ...ingest,
        status: 'failed',
        version: task.version,
        error: ingestErrorLabel(error),
        at,
      }),
    });
  });
}
