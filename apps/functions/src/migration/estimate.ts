import type { Firestore } from 'firebase-admin/firestore';

import { costMicros, type ClerkUsage } from '@materia/clerk';
import { ESTATE_MATTER_TYPES, type MigrationEnrichmentEstimate } from '@materia/domain';

import { documentRef } from './shared';
import { isDeleted } from '../contacts/shared';
import { CLOSED_STATUSES } from '../deadlines/shared';
import type { FileStore } from '../documents/files';
import { CHECKPOINT_PAGES } from '../documents/ingest/pipeline';
import { openSource } from '../documents/ingest/extract';
import { isClean, versionsOf } from '../documents/shared';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/**
 * The estimate an owner approves before the enrichment spends anything (MIG-09, D-21). The pages
 * are counted by opening each stored file, as ingestion would (no Clerk calls); the cost is those
 * counts at the org's model's list price, with each call's tokens taken at an average. Embeddings
 * (Vertex AI, a fraction of a cent per document) are not Clerk's spend and are left out.
 */

/** Tokens a call is costed at before it runs: averages, to check against the dev rehearsal (MIG-07). */
export const ESTIMATE_TOKENS = {
  /** One scanned page read by OCR (`ocr@1`): the page image and prompt, and its text. */
  ocrPage: { input: 2_500, output: 900 },
  /** One document's metadata from its first pages (`classify-document@1`). */
  classification: { input: 3_500, output: 400 },
  /** One estate matter's key dates (`events-from-file@1`, medium effort): its context budget, and the reply with thinking. */
  matterEvents: { input: 30_000, output: 3_000 },
} as const;

/** Characters an OCR'd page is counted at (its text isn't known before it is read). */
export const OCR_PAGE_CHARS = 2_000;

const usage = (calls: number, tokens: { input: number; output: number }): ClerkUsage => ({
  inputTokens: calls * tokens.input,
  outputTokens: calls * tokens.output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** The estimate's cost in US cents (rounded up) at `model`'s price. */
export function estimateCostCents(
  counts: Pick<MigrationEnrichmentEstimate, 'documents' | 'ocrPages' | 'unreadable' | 'matters'>,
  model: string,
): number {
  const readable = Math.max(0, counts.documents - counts.unreadable);
  const micros =
    costMicros(model, usage(counts.ocrPages, ESTIMATE_TOKENS.ocrPage), model).micros +
    costMicros(model, usage(readable, ESTIMATE_TOKENS.classification), model).micros +
    costMicros(model, usage(counts.matters, ESTIMATE_TOKENS.matterEvents), model).micros;
  return Math.ceil(micros / 10_000);
}

/** What one document adds to the estimate. */
export interface DocumentCount {
  pages: number;
  ocrPages: number;
  chars: number;
  unreadable: boolean;
}

/**
 * Counts a document's pages the way ingestion reads them: its current version's file opened, each
 * page's text layer read, pages without one counted as OCR pages. An encrypted, damaged or
 * unsupported file is unreadable (ingestion skips it); a missing one counts as nothing.
 */
export async function countDocument(files: FileStore, doc: Data): Promise<DocumentCount> {
  const none = { pages: 0, ocrPages: 0, chars: 0, unreadable: false };
  const version = versionsOf(doc).find((v) => v.version === doc['version']);
  if (!version) return none;
  if (doc['encrypted'] === true || version.encrypted) return { ...none, unreadable: true };
  let fileName = version.fileName;
  let path = version.storagePath;
  if (/\.heic$/i.test(fileName) && version.renditions?.previewImage) {
    fileName = 'preview.jpg';
    path = version.renditions.previewImage;
  }
  const data = await files.read(path);
  if (!data) return none;
  const opened = await openSource(fileName, data);
  if (!opened.ok) return { ...none, unreadable: opened.reason !== 'empty' };
  const source = opened.source;
  try {
    let ocrPages = 0;
    let chars = 0;
    for (let from = 1; from <= source.pageCount; from += CHECKPOINT_PAGES) {
      const pages = await source.pages(from, Math.min(from + CHECKPOINT_PAGES - 1, source.pageCount));
      for (const page of pages) {
        if (page.needsOcr) {
          ocrPages++;
          chars += OCR_PAGE_CHARS;
        } else chars += page.text.length;
      }
    }
    return { pages: source.pageCount, ocrPages, chars, unreadable: false };
  } finally {
    await source.close();
  }
}

/** The ingest states that mean Clerk has read (or passed over) the document's current version. */
const READ = new Set(['done', 'skipped']);

/**
 * What the run loaded that Clerk should read, in a stable order: the live, clean documents it
 * loaded (or re-stamped) whose current version Clerk hasn't read, and its open estate matters
 * (archived and closed ones are left alone: suggestions can't be made on them).
 */
export async function listRunWork(
  db: Firestore,
  orgId: string,
  runId: string,
): Promise<{ documents: string[]; matters: string[] }> {
  const documents: string[] = [];
  const matters: string[] = [];
  const all = await db.collection(`orgs/${orgId}/matters`).get();
  for (const matter of all.docs) {
    const data = matter.data();
    if (isDeleted(data)) continue;
    const loaded = (data['migration'] as { runId?: unknown } | undefined)?.runId === runId;
    if (
      loaded &&
      (ESTATE_MATTER_TYPES as readonly unknown[]).includes(data['type']) &&
      !CLOSED_STATUSES.has(data['status'])
    )
      matters.push(matter.id);
    const docs = await db
      .collection(`${matterPath(orgId, matter.id)}/documents`)
      .where('migration.runId', '==', runId)
      .get();
    for (const doc of [...docs.docs].sort((a, b) => a.id.localeCompare(b.id))) {
      const d = doc.data();
      if (isDeleted(d) || !isClean(d) || Number(d['version'] ?? 0) < 1) continue;
      const ingest = (d['ingest'] ?? {}) as { status?: string; version?: number };
      if (ingest.version === d['version'] && READ.has(ingest.status ?? '')) continue;
      documents.push(documentRef(matter.id, doc.id));
    }
  }
  return { documents, matters };
}
