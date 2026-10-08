import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * `materia-scripts backfill-ingest --project <id> [--dry-run] [--rechunk] [--page-size <n>]` (AI-04):
 * has Clerk ingest the documents uploaded before AI-04 (and any whose ingest failed), and reports
 * where every document's ingest stands, so a dry run doubles as the live check that ingestion works.
 *
 * `--rechunk` (SEC-07h) also re-ingests the documents that were ingested but whose chunks are gone:
 * after a restore from the nightly export, which leaves Clerk's chunks out. It re-reads their text
 * (OCR pages again, within the org's daily OCR budget) and re-embeds them; the report says how many
 * documents and OCR pages that is, so run it with `--dry-run` first.
 *
 * It doesn't enqueue tasks itself: it moves each due document's `ingest` to `queued`, then back to
 * `pending` for its current version. That is a transition into "needs ingesting", so the deployed
 * `documents-onIngestChange` trigger queues `documents-ingest` exactly as it does for an upload.
 * Documents already done, skipped, running or queued for their current version are left alone, so
 * a second run writes nothing. Logs counts only, never names.
 */

type Data = Record<string, unknown>;

export interface IngestDoc {
  /** The full path (`orgs/o1/matters/m1/documents/d1`). */
  path: string;
  data: Data;
}

/** What the backfill needs from Firestore, so a test can run it against a fake. */
export interface IngestStore {
  /** Up to `limit` documents of the `documents` collection group, by path, after the path `after`. */
  page(after: string | null, limit: number): Promise<IngestDoc[]>;
  /** Replaces the document's `ingest` field. */
  setIngest(path: string, ingest: Data): Promise<void>;
  /** Whether one of the document's chunks for this version carries a 768-dimension embedding. */
  embedded(path: string, version: number): Promise<boolean>;
  /** Whether the document has any chunk for this version (`--rechunk`, SEC-07h). */
  chunked(path: string, version: number): Promise<boolean>;
  /** How many times each trigger function ran in the last week, from its `eventGuards` (optional). */
  triggerRuns?(fns: readonly string[]): Promise<Record<string, number>>;
}

/**
 * The triggers every document write runs. If `documents-onIngestChange` ran far less often than
 * `documents-onWrite`, the trigger isn't seeing the writes that should queue ingestion.
 */
export const DOCUMENT_TRIGGERS = ['documents-onWrite', 'documents-onIngestChange', 'audit-onMatterWrite'] as const;

export const EMBEDDING_DIMENSIONS = 768;

export interface IngestReport {
  read: number;
  /** Deleted, not scanned clean yet, or without a version. */
  notReady: number;
  done: number;
  /** Chunks of the done documents (from `ingest.chunks`). */
  chunks: number;
  /** Done documents with chunks whose sampled chunk has a 768-dimension embedding. */
  embedded: number;
  skipped: number;
  inProgress: number;
  /** Pending (never ingested, or an older version) or failed: queued by this run. */
  due: number;
  /** Migrated and not read yet: left to the migration's enrichment (MIG-09). */
  migrated: number;
  ocrPages: number;
  /** Why documents are due, skipped or in progress (`failed: TypeError`, `skipped: encrypted`, …). Counts only. */
  reasons: Record<string, number>;
  /** Runs of the document triggers in the last week (when the store can count them). */
  triggerRuns?: Record<string, number>;
  /** With `--rechunk` (SEC-07h): ingested documents whose chunks are gone, queued again, and their OCR pages. */
  rechunk?: { documents: number; ocrPages: number };
}

const isDeleted = (doc: Data) => doc['deletedAt'] !== undefined && doc['deletedAt'] !== null;

export type IngestState = 'notReady' | 'done' | 'skipped' | 'inProgress' | 'due' | 'migrated';

/**
 * A migrated document Clerk hasn't read: the migration's enrichment reads it once an owner approves
 * the cost (MIG-09), so the backfill leaves it alone. Mirrors `awaitsMigrationEnrichment` in @materia/domain.
 */
function awaitsEnrichment(doc: Data): boolean {
  const runId = (doc['migration'] as { runId?: unknown } | undefined)?.runId;
  if (typeof runId !== 'string' || !runId) return false;
  const ingest = doc['ingest'] as { status?: unknown; version?: unknown } | undefined;
  return !ingest || (ingest.status === 'pending' && ingest.version === undefined);
}

/** Where a document's current version stands. Mirrors `needsIngest` in apps/functions. */
export function ingestState(doc: Data): IngestState {
  const version = Number(doc['version'] ?? 0);
  if (isDeleted(doc) || (doc['scan'] as { status?: string } | undefined)?.status !== 'clean' || version < 1) {
    return 'notReady';
  }
  if (awaitsEnrichment(doc)) return 'migrated';
  const ingest = (doc['ingest'] ?? { status: 'pending' }) as { status?: string; version?: number };
  if (ingest.version !== undefined && ingest.version !== version) return 'due';
  switch (ingest.status) {
    case 'done':
      return 'done';
    case 'skipped':
      return 'skipped';
    case 'running':
    case 'queued':
      return 'inProgress';
    default:
      return 'due';
  }
}

/** A short, name-free label for why a document is in its state (logged as a count). */
export function stateReason(doc: Data, state: IngestState): string | null {
  const version = Number(doc['version'] ?? 0);
  const ingest = doc['ingest'] as { status?: string; version?: number; reason?: string; error?: string } | undefined;
  switch (state) {
    case 'due':
      if (!ingest) return 'due: never ingested';
      if (ingest.version !== undefined && ingest.version !== version) return 'due: older version';
      if (ingest.status === 'failed') return `due: failed (${ingest.error ?? 'no error recorded'})`;
      return `due: ${ingest.status ?? 'pending'}`;
    case 'skipped':
      return `skipped: ${ingest?.reason ?? 'no reason recorded'}`;
    case 'inProgress':
      return `in progress: ${ingest?.status}`;
    default:
      return null;
  }
}

/** Runs the backfill; with `dryRun`, only reports. */
export async function backfillIngest(
  store: IngestStore,
  options: { pageSize?: number; dryRun?: boolean; rechunk?: boolean; log?: (line: string) => void } = {},
): Promise<IngestReport> {
  const pageSize = options.pageSize ?? 300;
  const report: IngestReport = {
    read: 0,
    notReady: 0,
    done: 0,
    chunks: 0,
    embedded: 0,
    skipped: 0,
    inProgress: 0,
    due: 0,
    migrated: 0,
    ocrPages: 0,
    reasons: {},
    ...(options.rechunk ? { rechunk: { documents: 0, ocrPages: 0 } } : {}),
  };
  const queue = async (path: string, version: number) => {
    await store.setIngest(path, { status: 'queued', version });
    await store.setIngest(path, { status: 'pending', version });
  };
  let after: string | null = null;
  for (;;) {
    const page = await store.page(after, pageSize);
    if (!page.length) break;
    for (const doc of page) {
      // Only matter documents (`orgs/{o}/matters/{m}/documents/{d}`) are ingested.
      if (doc.path.split('/').length !== 6) continue;
      report.read++;
      const state = ingestState(doc.data);
      report[state]++;
      const reason = stateReason(doc.data, state);
      if (reason) report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
      const version = Number(doc.data['version']);
      const ingest = (doc.data['ingest'] ?? {}) as { chunks?: number; ocrPages?: number };
      if (state === 'done') {
        report.chunks += ingest.chunks ?? 0;
        report.ocrPages += ingest.ocrPages ?? 0;
        if ((ingest.chunks ?? 0) > 0 && (await store.embedded(doc.path, version))) report.embedded++;
        else if (report.rechunk && (ingest.chunks ?? 0) > 0 && !(await store.chunked(doc.path, version))) {
          // Ingested, but its chunks are gone (a restore from the export, SEC-07h): ingest it again.
          report.rechunk.documents++;
          report.rechunk.ocrPages += ingest.ocrPages ?? 0;
          if (!options.dryRun) await queue(doc.path, version);
        }
      }
      if (state === 'due' && !options.dryRun) await queue(doc.path, version);
    }
    after = page[page.length - 1]?.path ?? null;
    if (page.length < pageSize) break;
  }
  if (store.triggerRuns) report.triggerRuns = await store.triggerRuns(DOCUMENT_TRIGGERS);
  const log = options.log;
  if (log) {
    log(`documents: ${report.read} read, ${report.notReady} not ready (deleted, unscanned or infected)`);
    log(
      `ingested: ${report.done} done (${report.chunks} chunks, ${report.ocrPages} OCR pages), ` +
        `${report.embedded} with ${EMBEDDING_DIMENSIONS}-dimension embeddings`,
    );
    log(`skipped: ${report.skipped}, in progress: ${report.inProgress}`);
    log(`due (never ingested, older version or failed): ${report.due} ${options.dryRun ? 'to queue' : 'queued'}`);
    if (report.migrated) log(`migrated, waiting for the migration's Clerk reading (MIG-09): ${report.migrated}`);
    if (report.rechunk)
      log(
        `ingested but without chunks (restored from the export): ${report.rechunk.documents} ` +
          `${options.dryRun ? 'to queue' : 'queued'}, ${report.rechunk.ocrPages} OCR pages to read again`,
      );
    for (const [reason, count] of Object.entries(report.reasons).sort()) log(`  ${reason}: ${count}`);
    if (report.triggerRuns) {
      const runs = Object.entries(report.triggerRuns).map(([fn, count]) => `${fn} ${count}`);
      log(`trigger runs in the last week: ${runs.join(', ')}`);
    }
  }
  return report;
}

/** The Admin SDK store. */
export function adminStore(db: Firestore): IngestStore {
  return {
    async page(after, limit) {
      let query = db.collectionGroup('documents').orderBy(FieldPath.documentId()).limit(limit);
      if (after) query = query.startAfter(db.doc(after));
      const snap = await query.get();
      return snap.docs.map((doc) => ({ path: doc.ref.path, data: doc.data() }));
    },
    async setIngest(path, ingest) {
      await db.doc(path).update({ ingest });
    },
    async embedded(path, version) {
      const snap = await db
        .collection(`${path}/chunks`)
        .where('docVersion', '==', version)
        .select('embedding')
        .limit(1)
        .get();
      // A VectorValue (FieldValue.vector) reads back with toArray().
      const embedding = snap.docs[0]?.get('embedding') as { toArray?: () => number[] } | undefined;
      return embedding?.toArray?.().length === EMBEDDING_DIMENSIONS;
    },
    async chunked(path, version) {
      const snap = await db.collection(`${path}/chunks`).where('docVersion', '==', version).select().limit(1).get();
      return !snap.empty;
    },
    async triggerRuns(fns) {
      const counts = await Promise.all(
        fns.map(async (fn) => (await db.collection('eventGuards').where('fn', '==', fn).count().get()).data().count),
      );
      return Object.fromEntries(fns.map((fn, i) => [fn, counts[i] ?? 0]));
    },
  };
}

export function parseArgs(argv: string[]): { project: string; dryRun: boolean; rechunk: boolean; pageSize: number } {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project') ?? process.env['GCLOUD_PROJECT'];
  if (!project)
    throw new Error('Usage: materia-scripts backfill-ingest --project <id> [--dry-run] [--rechunk] [--page-size <n>]');
  const pageSize = Number(value('page-size') ?? 300);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('--page-size is 1 to 500');
  return { project, dryRun: argv.includes('--dry-run'), rechunk: argv.includes('--rechunk'), pageSize };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, dryRun, rechunk, pageSize } = parseArgs(argv);
  const app = initializeApp({ projectId: project }, `backfill-ingest-${Date.now()}`);
  try {
    await backfillIngest(adminStore(getFirestore(app)), {
      dryRun,
      rechunk,
      pageSize,
      log: (line) => console.log(line),
    });
  } finally {
    await deleteApp(app);
  }
}
