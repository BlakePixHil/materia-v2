import { randomUUID } from 'node:crypto';

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  attachmentDisposition,
  DocIdSchema,
  exportDataFileName,
  ORG_EXPORT_DATA_FILE_BYTES,
  ORG_EXPORT_FORMAT,
  ORG_EXPORT_FORMAT_VERSION,
  ORG_EXPORT_QUEUE,
  OrgExportJobInputSchema,
  orgExportFileName,
  orgExportPartPath,
  OrgExportEntrySchema,
  type OrgExportEntry,
  type OrgExportManifest,
} from '@materia/domain';

import { exportGroups, exportReadme, exportRecord, exportSchemas, safeName, schemaFileName } from './org-format';
import { firestoreSource, GroupWalk, type OrgSource } from './org-source';
import { measured, ZipWriter } from './zip-stream';
import { audit } from '../audit/audit';
import type { Log } from '../core/log';
import { defineQueue } from '../core/tasks';
import { storageFiles, type FileStore, type StoredObject } from '../documents/files';
import { notify } from '../notifications/notify';
import type { Clock, Ports } from '../ports';

/**
 * Writes a practice's full export (SEC-05, ADR-058) on the `exports-runOrgFull` queue: zip parts
 * of at most the job's `partBytes` (10 GB), each a complete zip, a task writing parts until about
 * 20 minutes have gone and then handing over to the next task. Between parts the job's
 * `checkpoint` records where the walk stopped and each part's `manifest.json` entries are kept in
 * `jobs/{jobId}/manifest`, so a failed task repeats only its own part. The last part holds the
 * schemas, the README and `manifest.json` with every file's SHA-256.
 *
 * Order: `data/org.jsonl`, then every collection group (path order) as JSONL; then each matter
 * document's current version (or every version) under `files/matters/…`; then the practice's other
 * stored files; then the schemas, README and manifest.
 */

export const RunOrgExportTask = z.object({ orgId: DocIdSchema, jobId: DocIdSchema });

/** Attempts per task; a task that finds another still writing the export waits its turn by failing. */
export const ORG_EXPORT_ATTEMPTS = 8;
/** How long a task writes before it closes its part and enqueues the next. */
export const ORG_EXPORT_TASK_BUDGET_MS = 20 * 60_000;
/** A writer silent this long has died, and another task may take over. */
const WRITER_STALE_MS = 5 * 60_000;
const PAGE_SIZE = 300;
/** Manifest entries per `jobs/{jobId}/manifest` document. */
const MANIFEST_CHUNK = 1000;
const HEARTBEAT_MS = 15_000;
const MAX_WARNINGS = 50;

type Data = Record<string, unknown>;
type Phase = 'data' | 'documents' | 'files' | 'final';

/** The job's `checkpoint` between parts. */
export interface OrgExportCheckpoint {
  /** The part to write next (1-based). */
  part: number;
  phase: Phase;
  /**
   * Data phase: the collection group being walked (by name, so a deploy that adds a group between
   * tasks resumes in the right place); empty before the org document is written.
   */
  group: string;
  /** The last record or file written in this phase (a document path, or a Storage path). */
  after: string | null;
  /** Documents phase: versions already written of the document at `partial`, cut by a part's end. */
  partial: { path: string; done: number } | null;
  /** Each collection's last JSONL file number, and its records. */
  fileNo: Record<string, number>;
  counts: Record<string, number>;
  files: number;
  fileBytes: number;
  parts: { storagePath: string; sizeBytes: number; sha256: string }[];
  /** The task writing now (a part claimed). */
  writer?: { token: string };
}

const initialCheckpoint = (): OrgExportCheckpoint => ({
  part: 1,
  phase: 'data',
  group: '',
  after: null,
  partial: null,
  fileNo: {},
  counts: {},
  files: 0,
  fileBytes: 0,
  parts: [],
});

export interface RunOrgExportDeps {
  db: Firestore;
  files: FileStore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
  /** The queue's retry count for this attempt (0 first). */
  attempt: number;
  source?: OrgSource;
  /** Milliseconds now, for the task's time budget (the wall clock). */
  elapsed?: () => number;
  budgetMs?: number;
  pageSize?: number;
  dataFileBytes?: number;
}

export type RunOrgExportOutcome = 'succeeded' | 'continued' | 'failed' | 'skipped' | 'discarded';

const toDate = (value: unknown): Date | undefined =>
  value instanceof Date ? value : ((value as { toDate?: () => Date } | undefined)?.toDate?.() ?? undefined);

/** The creator is still an active owner. */
async function stillOwner(db: Firestore, orgId: string, uid: string): Promise<boolean> {
  const member = await db.doc(`orgs/${orgId}/members/${uid}`).get();
  return member.get('status') === 'active' && member.get('role') === 'owner';
}

/** Is this Storage object one of the practice's "other" files (not a matter document, preview, upload or export)? */
export function otherFile(orgId: string, path: string): boolean {
  const relative = path.slice(`orgs/${orgId}/`.length);
  if (!relative || relative.startsWith('exports/')) return false;
  if (/^matters\/[^/]+\/(documents|pending)\//.test(relative)) return false;
  return !relative.split('/').includes('renditions');
}

interface DocumentVersionRef {
  version: number;
  storagePath: string;
  fileName: string;
  sizeBytes: number;
  sha256?: string;
}

/** The versions of a matter document the export takes: the current one, or every one. */
export function exportedVersions(data: Data, allVersions: boolean): DocumentVersionRef[] {
  const versions = (Array.isArray(data['versions']) ? (data['versions'] as Data[]) : [])
    .filter((v) => typeof v['storagePath'] === 'string' && typeof v['version'] === 'number')
    .map((v) => ({
      version: v['version'] as number,
      storagePath: v['storagePath'] as string,
      fileName: typeof v['fileName'] === 'string' ? (v['fileName'] as string) : String(data['name'] ?? 'document'),
      sizeBytes: typeof v['sizeBytes'] === 'number' ? (v['sizeBytes'] as number) : 0,
      ...(typeof v['sha256'] === 'string' ? { sha256: v['sha256'] as string } : {}),
    }))
    .sort((a, b) => a.version - b.version);
  if (allVersions) return versions;
  const current = versions.find((v) => v.version === data['version']) ?? versions.at(-1);
  return current ? [current] : [];
}

/** One part being written. */
interface PartRun {
  orgId: string;
  jobId: string;
  orgName: string;
  createdAt: Date;
  createdBy: string;
  allVersions: boolean;
  partBytes: number;
  cp: OrgExportCheckpoint;
  zip: ZipWriter;
  entries: OrgExportEntry[];
  warnings: { code: string; message: string; retryable: boolean }[];
  source: OrgSource;
  files: FileStore;
  pageSize: number;
  dataFileBytes: number;
  overBudget: () => boolean;
  heartbeat: () => Promise<void>;
  /** The final phase's manifest entries from earlier parts. */
  earlier: () => Promise<OrgExportEntry[]>;
  done: boolean;
}

/** Whether the part should end before something of `next` bytes (it always takes at least one entry). */
const full = (run: PartRun, next = 0) =>
  run.zip.count > 0 && (run.zip.offset + next >= run.partBytes || run.overBudget());

async function* dataPhase(run: PartRun): AsyncGenerator<Uint8Array, 'full' | 'done'> {
  const { cp, zip, orgId } = run;
  if (cp.group === '') {
    const org = await run.source.org();
    if (org) {
      const line = Buffer.from(`${JSON.stringify(exportRecord(orgId, `orgs/${orgId}`, org))}\n`);
      const name = exportDataFileName('org');
      const result = yield* zip.entry(name, [line], { compress: true });
      cp.fileNo['org'] = 1;
      cp.counts['org'] = 1;
      run.entries.push({
        path: name,
        part: cp.part,
        kind: 'data',
        bytes: result.bytes,
        sha256: result.sha256,
        collection: 'org',
        records: 1,
      });
    }
    cp.after = null;
  }
  // Groups are walked in name order; a checkpoint names the one it stopped in.
  for (const group of exportGroups().filter((name) => name >= cp.group)) {
    if (group !== cp.group) {
      cp.group = group;
      cp.after = null;
    }
    const walk = new GroupWalk(run.source, group, cp.after, run.pageSize);
    for (;;) {
      const head = await walk.peek();
      if (!head) break;
      if (full(run)) return 'full';
      const collection = head.collection;
      const fileNo = (cp.fileNo[collection] ?? 0) + 1;
      const name = exportDataFileName(collection, fileNo);
      let records = 0;
      let bytes = 0;
      const lines = async function* (): AsyncGenerator<Uint8Array> {
        for (;;) {
          const next = await walk.peek();
          if (!next || next.collection !== collection) return;
          if (records > 0 && (bytes >= run.dataFileBytes || full(run))) return;
          await walk.take();
          const line = Buffer.from(`${JSON.stringify(exportRecord(orgId, next.path, next.data))}\n`);
          records++;
          bytes += line.length;
          cp.after = next.path;
          if (records % 200 === 0) await run.heartbeat();
          yield line;
        }
      };
      const result = yield* zip.entry(name, lines(), { compress: true });
      cp.fileNo[collection] = fileNo;
      cp.counts[collection] = (cp.counts[collection] ?? 0) + records;
      run.entries.push({
        path: name,
        part: cp.part,
        kind: 'data',
        bytes: result.bytes,
        sha256: result.sha256,
        collection,
        records,
      });
    }
  }
  return 'done';
}

function warn(run: PartRun, code: string, message: string) {
  if (run.warnings.length < MAX_WARNINGS) run.warnings.push({ code, message, retryable: false });
}

async function* documentsPhase(run: PartRun): AsyncGenerator<Uint8Array, 'full' | 'done'> {
  const { cp, zip } = run;
  const resume = cp.partial;
  const walk = new GroupWalk(run.source, 'documents', resume?.path ?? cp.after, run.pageSize, { inclusive: !!resume });
  for (;;) {
    const doc = await walk.peek();
    if (!doc) return 'done';
    if (doc.collection !== 'matters.documents') {
      await walk.take();
      continue;
    }
    const [, , , matterId, , documentId] = doc.path.split('/') as string[];
    const versions = exportedVersions(doc.data, run.allVersions);
    const skip = resume && cp.partial?.path === doc.path ? cp.partial.done : 0;
    for (let i = skip; i < versions.length; i++) {
      const version = versions[i] as DocumentVersionRef;
      if (full(run, version.sizeBytes)) {
        cp.partial = { path: doc.path, done: i };
        return 'full';
      }
      const bytes = await run.files.read(version.storagePath);
      if (!bytes) {
        warn(run, 'FILE_MISSING', `Version ${version.version} of document ${documentId} wasn’t found in storage`);
        continue;
      }
      const name = `files/matters/${safeName(matterId as string)}/${safeName(documentId as string)}/v${version.version}/${safeName(version.fileName, 'document')}`;
      const result = yield* zip.entry(name, [bytes], { compress: false });
      if (version.sha256 && version.sha256 !== result.sha256) {
        warn(
          run,
          'CHECKSUM_MISMATCH',
          `Version ${version.version} of document ${documentId} doesn’t match its recorded checksum`,
        );
      }
      cp.files++;
      cp.fileBytes += result.bytes;
      run.entries.push({
        path: name,
        part: cp.part,
        kind: 'file',
        bytes: result.bytes,
        sha256: result.sha256,
        storagePath: version.storagePath,
        matterId: matterId as string,
        documentId: documentId as string,
        version: version.version,
      });
      await run.heartbeat();
    }
    await walk.take();
    cp.after = doc.path;
    cp.partial = null;
  }
}

async function* filesPhase(run: PartRun): AsyncGenerator<Uint8Array, 'full' | 'done'> {
  const { cp, zip, orgId } = run;
  const objects: StoredObject[] = (await run.files.list(`orgs/${orgId}/`, `orgs/${orgId}/**`))
    .filter((object) => otherFile(orgId, object.path) && (cp.after === null || object.path > cp.after))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const object of objects) {
    if (full(run, object.size)) return 'full';
    const bytes = await run.files.read(object.path);
    if (!bytes) continue;
    const relative = object.path.slice(`orgs/${orgId}/`.length);
    const name = `files/${relative
      .split('/')
      .map((part) => safeName(part))
      .join('/')}`;
    const result = yield* zip.entry(name, [bytes], { compress: false });
    cp.files++;
    cp.fileBytes += result.bytes;
    cp.after = object.path;
    run.entries.push({
      path: name,
      part: cp.part,
      kind: 'file',
      bytes: result.bytes,
      sha256: result.sha256,
      storagePath: object.path,
    });
    await run.heartbeat();
  }
  return 'done';
}

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function* finalPhase(run: PartRun): AsyncGenerator<Uint8Array> {
  const { cp, zip } = run;
  for (const [collection, schema] of exportSchemas()) {
    const name = schemaFileName(collection);
    const result = yield* zip.entry(name, [json(schema)], { compress: true });
    run.entries.push({
      path: name,
      part: cp.part,
      kind: 'schema',
      bytes: result.bytes,
      sha256: result.sha256,
      collection,
    });
  }
  const summary = {
    format: ORG_EXPORT_FORMAT,
    version: ORG_EXPORT_FORMAT_VERSION,
    orgId: run.orgId,
    orgName: run.orgName,
    createdAt: run.createdAt.toISOString(),
    createdBy: run.createdBy,
    allVersions: run.allVersions,
    parts: cp.part,
    collections: Object.fromEntries(Object.entries(cp.counts).sort(([a], [b]) => a.localeCompare(b))),
  } satisfies Omit<OrgExportManifest, 'entries'>;
  const readme = yield* zip.entry(
    'README.md',
    [Buffer.from(exportReadme({ ...summary, files: cp.files, fileBytes: cp.fileBytes }))],
    {
      compress: true,
    },
  );
  run.entries.push({ path: 'README.md', part: cp.part, kind: 'readme', bytes: readme.bytes, sha256: readme.sha256 });
  const manifest: OrgExportManifest = { ...summary, entries: [...(await run.earlier()), ...run.entries] };
  yield* zip.entry('manifest.json', [json(manifest)], { compress: true });
  run.done = true;
}

async function* writePart(run: PartRun): AsyncGenerator<Uint8Array> {
  const { cp } = run;
  const next = (phase: Phase) => {
    cp.phase = phase;
    cp.after = null;
    cp.partial = null;
  };
  if (cp.phase === 'data') {
    if ((yield* dataPhase(run)) === 'full') return yield* run.zip.finish();
    next('documents');
  }
  if (cp.phase === 'documents') {
    if ((yield* documentsPhase(run)) === 'full') return yield* run.zip.finish();
    next('files');
  }
  if (cp.phase === 'files') {
    if ((yield* filesPhase(run)) === 'full') return yield* run.zip.finish();
    next('final');
  }
  yield* finalPhase(run);
  yield* run.zip.finish();
}

const manifestPath = (orgId: string, jobId: string) => `orgs/${orgId}/jobs/${jobId}/manifest`;

async function deleteManifest(db: Firestore, orgId: string, jobId: string): Promise<void> {
  const chunks = await db.collection(manifestPath(orgId, jobId)).get();
  for (let i = 0; i < chunks.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of chunks.docs.slice(i, i + 400)) batch.delete(doc.ref);
    await batch.commit();
  }
}

/** Removes every part written (a failed or refused export). */
async function discardParts(deps: RunOrgExportDeps, orgId: string, jobId: string, cp: OrgExportCheckpoint) {
  for (let part = 1; part <= cp.part; part++) await deps.files.remove(orgExportPartPath(orgId, jobId, part));
  await deleteManifest(deps.db, orgId, jobId);
}

/**
 * Runs one task of a full export: claims the job (another task still writing it makes this one
 * fail, so the queue retries it later), writes parts until done or out of time, and either
 * finishes the job (`export_ready` to the owner who asked) or enqueues the next task.
 */
export async function runOrgExport(
  deps: RunOrgExportDeps,
  task: z.infer<typeof RunOrgExportTask>,
): Promise<RunOrgExportOutcome> {
  const { db, clock, log } = deps;
  const { orgId, jobId } = task;
  const ref = db.doc(`orgs/${orgId}/jobs/${jobId}`);
  const token = randomUUID();
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const job = snap.data();
    if (!job || job['type'] !== 'org.export' || job['status'] === 'succeeded' || job['status'] === 'failed') {
      return { state: 'skipped' as const };
    }
    const now = clock.now();
    const cp = { ...initialCheckpoint(), ...((job['checkpoint'] as Partial<OrgExportCheckpoint> | undefined) ?? {}) };
    const heartbeat = toDate(job['heartbeatAt']);
    if (cp.writer && heartbeat && now.getTime() - heartbeat.getTime() < WRITER_STALE_MS) {
      return { state: 'busy' as const };
    }
    tx.update(ref, {
      status: 'running',
      'checkpoint.writer': { token },
      attempts: Number(job['attempts'] ?? 0) + 1,
      ...(job['startedAt'] ? {} : { startedAt: now }),
      heartbeatAt: now,
      updatedAt: now,
    });
    return { state: 'claimed' as const, job, cp };
  });
  if (claim.state === 'skipped') {
    log.info('org export skipped', { jobId });
    return 'skipped';
  }
  if (claim.state === 'busy') {
    log.warn('org export busy: another task is writing it', { jobId });
    throw new Error('Another task is writing this export');
  }
  const { job } = claim;
  let cp = claim.cp;
  delete cp.writer;
  const uid = String(job['createdBy']);
  const input = OrgExportJobInputSchema.parse(job['input']);
  const createdAt = toDate(job['createdAt']) ?? clock.now();
  const at = () => clock.now();
  const fail = async (code: string, message: string, retryable: boolean) => {
    await discardParts(deps, orgId, jobId, cp);
    await ref.update({
      status: 'failed',
      error: { code, message, retryable },
      checkpoint: FieldValue.delete(),
      finishedAt: at(),
      updatedAt: at(),
    });
  };

  if (!(await stillOwner(db, orgId, uid))) {
    await fail('PERMISSION_DENIED', 'Only an owner of the practice can export it', false);
    log.warn('org export refused: no longer an owner', { jobId });
    return 'discarded';
  }

  const source = deps.source ?? firestoreSource(db, orgId);
  const elapsed = deps.elapsed ?? (() => Date.now());
  const started = elapsed();
  const budget = deps.budgetMs ?? ORG_EXPORT_TASK_BUDGET_MS;
  const orgName = String((await source.org())?.['name'] ?? 'Practice');
  let lastBeat = elapsed();
  /** Records and files so far (the total isn't known until the end). */
  const progress = (state: OrgExportCheckpoint, stage: string) => {
    const done = Object.values(state.counts).reduce((sum, n) => sum + n, 0) + state.files;
    return { done, total: done, stage };
  };

  try {
    let done = false;
    while (!done) {
      const part = cp.part;
      const path = orgExportPartPath(orgId, jobId, part);
      // What a crashed attempt may have left at this part's path is replaced.
      await deps.files.remove(path);
      const working: OrgExportCheckpoint = structuredClone(cp);
      const run: PartRun = {
        orgId,
        jobId,
        orgName,
        createdAt,
        createdBy: uid,
        allVersions: input.allVersions,
        partBytes: input.partBytes,
        cp: working,
        zip: new ZipWriter({ modified: createdAt }),
        entries: [],
        warnings: [],
        source,
        files: deps.files,
        pageSize: deps.pageSize ?? PAGE_SIZE,
        dataFileBytes: deps.dataFileBytes ?? ORG_EXPORT_DATA_FILE_BYTES,
        overBudget: () => elapsed() - started >= budget,
        heartbeat: async () => {
          if (elapsed() - lastBeat < HEARTBEAT_MS) return;
          lastBeat = elapsed();
          await ref.update({ heartbeatAt: at(), updatedAt: at(), progress: progress(working, working.phase) });
        },
        earlier: async () => {
          const chunks = await db.collection(manifestPath(orgId, jobId)).get();
          return chunks.docs
            .map((doc) => doc.data() as { part: number; seq: number; entries: unknown[] })
            .sort((a, b) => a.part - b.part || a.seq - b.seq)
            .flatMap((chunk) => chunk.entries.map((entry) => OrgExportEntrySchema.parse(entry)));
        },
        done: false,
      };
      const counted = measured(writePart(run));
      const fileName = orgExportFileName(orgName, createdAt.toISOString().slice(0, 10), part);
      const written = await deps.files.writeStream(path, counted.chunks, {
        contentType: 'application/zip',
        disposition: attachmentDisposition(fileName),
        resumable: true,
      });
      if (written === 'exists') throw new Error('Another task wrote this part');
      const file = { storagePath: path, ...counted.result() };
      done = run.done;
      // Out of time: hand over to the next task (releasing the job); otherwise keep writing here.
      const handOver = !done && elapsed() - started >= budget;
      working.parts = [...working.parts, file];
      if (!done) working.part = part + 1;
      if (!done && !handOver) working.writer = { token };
      else delete working.writer;

      // The part's manifest entries and the checkpoint, only while this task still holds the job.
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).get('checkpoint') as OrgExportCheckpoint | undefined;
        if (current?.writer?.token !== token) throw new Error('Another task took over this export');
        if (!done) {
          for (let i = 0; i < run.entries.length; i += MANIFEST_CHUNK) {
            const seq = i / MANIFEST_CHUNK;
            tx.set(db.doc(`${manifestPath(orgId, jobId)}/${String(part).padStart(5, '0')}-${seq}`), {
              part,
              seq,
              entries: run.entries.slice(i, i + MANIFEST_CHUNK),
            });
          }
        }
        const now = at();
        tx.update(ref, {
          checkpoint: working,
          heartbeatAt: now,
          updatedAt: now,
          progress: progress(working, done ? 'done' : working.phase),
          ...(run.warnings.length ? { warnings: FieldValue.arrayUnion(...run.warnings) } : {}),
        });
      });
      cp = working;
      log.info('org export part written', {
        jobId,
        part,
        sizeBytes: file.sizeBytes,
        entries: run.entries.length,
        done,
      });
      if (handOver) {
        await deps.ports.tasks.enqueue(
          ORG_EXPORT_QUEUE,
          { orgId, jobId },
          { dedupeKey: `org-export-${jobId}-${cp.part}` },
        );
        log.info('org export continues in another task', { jobId, nextPart: cp.part });
        return 'continued';
      }
    }

    if (!(await stillOwner(db, orgId, uid))) {
      await fail('PERMISSION_DENIED', 'Only an owner of the practice can export it', false);
      log.warn('org export discarded: no longer an owner', { jobId });
      return 'discarded';
    }
    const records = Object.values(cp.counts).reduce((sum, n) => sum + n, 0);
    const sizeBytes = cp.parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    const first = cp.parts[0] as OrgExportCheckpoint['parts'][number];
    const finishedAt = at();
    await ref.update({
      status: 'succeeded',
      output: {
        storagePath: first.storagePath,
        sizeBytes,
        sha256: first.sha256,
        pages: 0,
        rows: records,
        parts: cp.parts,
      },
      checkpoint: FieldValue.delete(),
      progress: { done: records + cp.files, total: records + cp.files, stage: 'done' },
      finishedAt,
      updatedAt: finishedAt,
    });
    await deleteManifest(db, orgId, jobId);
    await audit(
      { uid: 'system', orgId, requestId: `org-export-${jobId}`, db, clock },
      {
        action: 'export.org_completed',
        entity: { path: ref.path },
        summary: 'Full export of the practice written',
        data: { parts: cp.parts.length, records, files: cp.files, sizeBytes },
      },
    );
    const sent = await notify(
      { db, orgId, clock, log, ports: deps.ports },
      {
        kind: 'export_ready',
        exportId: jobId,
        recipients: [uid],
        title: 'Your full export of the practice is ready',
        body:
          cp.parts.length > 1
            ? `${cp.parts.length} zip files. They are kept for 7 days.`
            : 'One zip file. It is kept for 7 days.',
        link: `/exports/${jobId}`,
        key: `export-${jobId}`,
      },
    );
    log.info('org export written', {
      jobId,
      parts: cp.parts.length,
      records,
      files: cp.files,
      notified: sent.ids.length,
    });
    return 'succeeded';
  } catch (error) {
    const errorType = error instanceof Error ? error.name : typeof error;
    if (deps.attempt + 1 < ORG_EXPORT_ATTEMPTS) {
      // Let the next attempt in at once rather than wait for this claim to go stale.
      await ref.update({ 'checkpoint.writer': FieldValue.delete() }).catch(() => undefined);
      log.warn('org export attempt failed; retrying', { jobId, attempt: deps.attempt, errorType });
      throw error;
    }
    await fail('UNAVAILABLE', 'The export couldn’t be written', true);
    log.error('org export failed', { jobId, attempt: deps.attempt, errorType });
    return 'failed';
  }
}

/** `exports-runOrgFull` (SEC-05): one task writes zip parts for up to 20 minutes, then hands over. */
export const runOrgFull = defineQueue({
  name: ORG_EXPORT_QUEUE,
  input: RunOrgExportTask,
  retry: { maxAttempts: ORG_EXPORT_ATTEMPTS, minBackoffSeconds: 60, maxBackoffSeconds: 600 },
  rateLimits: { maxConcurrentDispatches: 2 },
  timeoutSeconds: 1800,
  memory: '2GiB',
  handler: async (task, ctx) => {
    await runOrgExport(
      {
        db: ctx.db,
        files: storageFiles(),
        clock: ctx.ports.clock,
        log: ctx.log,
        ports: ctx.ports,
        attempt: ctx.attempt,
      },
      task,
    );
  },
});
