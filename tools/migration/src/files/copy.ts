import { createHash } from 'node:crypto';

import type { FileKind } from '@materia/domain';

import {
  assertDistinctTargets,
  AvatarLineSchema,
  DocumentLineSchema,
  orphansOf,
  parseJsonl,
  TransformOutputError,
  type AvatarLine,
  type CopySpec,
  type DocumentLine,
  type Orphan,
} from './contract.ts';
import type { ObjectStore, StoredObject } from './gcs.ts';
import { ScannerUnavailableError, type Scanner } from './scanner.ts';
import { domain } from '../domain.ts';
import { byCodeUnit, canonicalJson } from '../export/jsonl.ts';
import type { RunSink } from '../export/sink.ts';

/**
 * The attachment copy (MIG-05). For each attachment the transform (MIG-03) planned, and the
 * profile photo:
 *
 * 1. **Quarantine:** a server-side copy of exactly the exported generation of the legacy object into
 *    `migration-quarantine/{runId}/{target}` in the v2 files bucket, a path no client can read
 *    (storage.rules), checked against the export's size, MD5 and CRC32C. An image the transform
 *    extracted from a description (`copy.content`) is uploaded there instead, once its bytes match
 *    the transform's sha256.
 * 2. **Read back:** the copy's sha256, and what its bytes are (magic bytes).
 * 3. **Scan:** the ClamAV service (CORE-12a). Infected copies stay in quarantine and are reported;
 *    if the scanner can't be reached, the copy waits there and a re-run scans it.
 * 4. **Final path:** a clean copy moves to `orgs/{O}/matters/{M}/documents/{D}/v1` (or
 *    `users/{uid}/avatar.png`) with `{migrationRunId, legacyPath, sha256, scan, scannedAt}` in its
 *    metadata, and leaves quarantine. A stored version is readable only once its document says
 *    `scan.status: 'clean'`, which happens at the load (MIG-06).
 *
 * A re-run skips every file whose final copy already holds the same legacy content, scanned clean,
 * so it finishes an interrupted run without copying anything twice. The tool deletes only under
 * its own quarantine prefix, never a final copy, and only reads the legacy bucket.
 *
 * Output, beside the transform's files: `files/documents.jsonl` (the transform's lines with
 * version 1, the sha256 and the scan result filled in, which the load reads), `files/avatars.jsonl`
 * and `files/report.json` (counts, plus the missing, infected, unscanned and failed files and the
 * orphans, by legacy path; no file names or content).
 */

export const MIGRATION_QUARANTINE = 'migration-quarantine';
/** The largest file the copy reads back (v2's upload limit; legacy allowed 25 MB). */
export const MAX_FILE_BYTES = domain.DOCUMENT_MAX_BYTES;

export type Outcome = 'copied' | 'skipped' | 'missing' | 'infected' | 'unscanned' | 'failed';
export type FailReason =
  /** The legacy object, or the generation the export listed, is gone (it changed: run a delta). */
  | 'source_gone'
  /** The copy's size or checksums differ from the export's. */
  | 'checksum_mismatch'
  /** The export has no checksum for the object, so its copy can't be verified. */
  | 'no_checksum'
  | 'too_large'
  /** Something other than this legacy file is at the target path. */
  | 'target_taken'
  /** The profile photo isn't a PNG, JPEG or WebP image. */
  | 'not_an_image'
  | 'error';

export interface FileResult {
  outcome: Outcome;
  sha256?: string;
  sizeBytes?: number;
  kind?: FileKind;
  scannedAt?: string;
  signature?: string;
  reason?: FailReason;
  /** Where an infected or unscanned copy waits. */
  quarantine?: string;
  /** The bytes aren't what the extension says. The file is kept: it is the client's record. */
  typeMismatch?: boolean;
}

export interface CopyContext {
  runId: string;
  sourceBucket: string;
  filesBucket: string;
  store: ObjectStore;
  scanner: Scanner;
  now: () => Date;
}

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_TYPES: Partial<Record<FileKind, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

export function quarantinePath(runId: string, target: string): string {
  return `${MIGRATION_QUARANTINE}/${runId}/${target}`;
}

/**
 * Whether a stored object holds what the export listed: the same size, and every checksum both
 * sides report the same, with at least one compared. null when there is nothing to compare.
 */
function sameContent(object: StoredObject, copy: CopySpec): boolean | null {
  if (object.size !== copy.sizeBytes) return false;
  let compared = 0;
  for (const key of ['md5Hash', 'crc32c'] as const) {
    if (!copy[key] || !object[key]) continue;
    if (copy[key] !== object[key]) return false;
    compared++;
  }
  return compared ? true : null;
}

/** Copies one file through quarantine to its final path (see the module comment). */
export async function copyFile(
  ctx: CopyContext,
  item: { legacyPath: string; copy: CopySpec },
  role: 'document' | 'avatar',
): Promise<FileResult> {
  const { store, filesBucket, runId } = ctx;
  const { copy } = item;
  if (!copy.source && !copy.content) return { outcome: 'missing' };
  if (copy.sizeBytes > MAX_FILE_BYTES) return { outcome: 'failed', reason: 'too_large' };
  if (!copy.md5Hash && !copy.crc32c) return { outcome: 'failed', reason: 'no_checksum' };

  const held = quarantinePath(runId, copy.target);
  /** Deletes the quarantined copy: the only deletes the copy makes. */
  const release = async (object: StoredObject) => {
    if (object.name !== held) throw new Error(`Refusing to delete ${object.name}: outside the run's quarantine.`);
    await store.remove(filesBucket, held, object.generation);
  };

  const existing = await store.stat(filesBucket, copy.target);
  if (existing) {
    if (existing.metadata['legacyPath'] !== item.legacyPath) return { outcome: 'failed', reason: 'target_taken' };
    const sha256 = existing.metadata['sha256'] ?? '';
    if (sameContent(existing, copy) && existing.metadata['scan'] === 'clean' && SHA256.test(sha256)) {
      // A run stopped between the final copy and leaving quarantine leaves a copy behind.
      const stale = await store.stat(filesBucket, held);
      if (stale) await release(stale);
      return {
        outcome: 'skipped',
        sha256,
        sizeBytes: existing.size,
        ...(existing.metadata['kind'] ? { kind: existing.metadata['kind'] as FileKind } : {}),
        scannedAt: existing.metadata['scannedAt'] ?? ctx.now().toISOString(),
        ...(existing.metadata['typeMismatch'] === 'true' ? { typeMismatch: true } : {}),
      };
    }
  }

  let holding = await store.stat(filesBucket, held);
  if (holding && !sameContent(holding, copy)) {
    await release(holding);
    holding = null;
  }
  const baseMetadata = { migrationRunId: runId, legacyPath: item.legacyPath };
  if (!holding) {
    const resource = { contentType: copy.mime, metadata: { ...baseMetadata, scan: 'pending' } };
    if (copy.source) {
      holding = await store.rewrite(
        { bucket: ctx.sourceBucket, name: copy.source, ...(copy.generation ? { generation: copy.generation } : {}) },
        { bucket: filesBucket, name: held },
        resource,
      );
    } else {
      // Bytes the transform extracted: they must be what it hashed before they go anywhere.
      const bytes = Buffer.from(copy.content?.data ?? '', 'base64');
      if (
        bytes.length !== copy.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== copy.content?.sha256
      ) {
        return { outcome: 'failed', reason: 'checksum_mismatch' };
      }
      holding = await store.upload(filesBucket, held, bytes, resource);
    }
    if (!holding) return { outcome: 'failed', reason: 'source_gone' };
    if (!sameContent(holding, copy)) {
      await release(holding);
      return { outcome: 'failed', reason: 'checksum_mismatch' };
    }
  } else if (holding.metadata['scan'] === 'infected' && SHA256.test(holding.metadata['sha256'] ?? '')) {
    // An earlier attempt found it infected: it stays in quarantine.
    return {
      outcome: 'infected',
      sha256: holding.metadata['sha256'] as string,
      sizeBytes: holding.size,
      scannedAt: holding.metadata['scannedAt'] ?? ctx.now().toISOString(),
      signature: holding.metadata['signature'] ?? 'unknown',
      quarantine: held,
    };
  }

  const bytes = await store.read(filesBucket, held, MAX_FILE_BYTES);
  if (bytes.length !== copy.sizeBytes) {
    await release(holding);
    return { outcome: 'failed', reason: 'checksum_mismatch' };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const kind = domain.detectFileKind(bytes);
  const imageType = IMAGE_TYPES[kind];
  if (role === 'avatar' && !imageType) {
    await release(holding);
    return { outcome: 'failed', reason: 'not_an_image', sha256, sizeBytes: bytes.length, kind };
  }
  const extension = domain.uploadExtension(copy.fileName);
  const typeMismatch = role === 'document' && extension !== null && !domain.kindMatchesExtension(kind, extension);
  const facts = { sha256, sizeBytes: bytes.length, kind, ...(typeMismatch ? { typeMismatch: true } : {}) };

  let verdict;
  try {
    verdict = await ctx.scanner(bytes);
  } catch (err) {
    if (err instanceof ScannerUnavailableError) return { outcome: 'unscanned', ...facts, quarantine: held };
    throw err;
  }
  const scannedAt = ctx.now().toISOString();
  if (verdict.verdict === 'infected') {
    const signature = verdict.signature ?? 'unknown';
    await store.patchMetadata(filesBucket, held, { scan: 'infected', scannedAt, sha256, signature });
    return { outcome: 'infected', ...facts, scannedAt, signature, quarantine: held };
  }

  const final = await store.rewrite(
    { bucket: filesBucket, name: held, generation: holding.generation },
    { bucket: filesBucket, name: copy.target },
    {
      contentType: role === 'avatar' ? (imageType as string) : copy.mime,
      // Never shown inline (D-13); downloads are attachments anyway.
      ...(copy.downloadOnly ? { contentDisposition: domain.attachmentDisposition(copy.fileName) } : {}),
      metadata: {
        ...baseMetadata,
        sha256,
        scan: 'clean',
        scannedAt,
        kind,
        ...(typeMismatch ? { typeMismatch: 'true' } : {}),
      },
    },
  );
  if (!final || sameContent(final, copy) === false) {
    throw new Error(`The copy to ${copy.target} doesn't match its quarantined copy.`);
  }
  await release(holding);
  return { outcome: 'copied', ...facts, scannedAt };
}

/** `fn` over `items`, at most `size` at a time, results in the items' order. */
export async function inPool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return results;
}

// ---------- records ----------

type Data = Record<string, unknown>;

/**
 * The transform's document with the copy's result: version 1 (its storage path, type, size,
 * sha256, file name, and the attachment's creation as its upload) and `scan: clean` for a copied
 * file; `scan: infected` with no version for an infected one (never readable, as CORE-12 records an
 * infected first upload); unchanged otherwise.
 */
export function documentRecord(line: DocumentLine, result: FileResult): Data {
  const data: Data = { ...line.data };
  const at = { $timestamp: result.scannedAt };
  if (
    (result.outcome === 'copied' || result.outcome === 'skipped') &&
    result.sha256 &&
    result.sizeBytes !== undefined
  ) {
    const createdBy = data['createdBy'];
    const version = {
      version: 1,
      storagePath: line.copy.target,
      fileName: line.copy.fileName,
      mime: line.copy.mime,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      uploadedAt: data['createdAt'] ?? at,
      uploadedBy: typeof createdBy === 'string' && createdBy ? createdBy : 'system',
    };
    Object.assign(data, {
      storagePath: line.copy.target,
      mime: line.copy.mime,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      version: 1,
      versionSeq: 1,
      versions: [version],
      scan: { status: 'clean', at },
    });
  } else if (result.outcome === 'infected') {
    data['scan'] = { status: 'infected', at };
  }
  return data;
}

// ---------- the run ----------

export interface CopyFilesArgs {
  runId: string;
  env: string;
  sourceBucket: string;
  filesBucket: string;
  concurrency: number;
  toolVersion: string;
}

export interface CopyFilesDeps {
  /** The run in the migration bucket: reads the transform's files, writes `files/*`. */
  sink: RunSink;
  store: ObjectStore;
  scanner: Scanner;
  now: () => Date;
  log: (line: string) => void;
}

export interface CopyReport {
  version: 1;
  runId: string;
  env: string;
  sourceBucket: string;
  filesBucket: string;
  startedAt: string;
  finishedAt: string;
  toolVersion: string;
  counts: Record<'documents' | 'avatars' | Outcome | 'typeMismatches', number> & { orphans: number | null };
  /** Nothing waits for a re-run: no file unscanned or failed. */
  complete: boolean;
  missing: string[];
  infected: { legacyPath: string; signature: string; quarantine: string }[];
  unscanned: string[];
  failed: { legacyPath: string; reason: FailReason }[];
  typeMismatches: { legacyPath: string; kind: string; extension: string }[];
  /** Legacy objects no document names (the transform's report), for a decision (D-13); null if unknown. */
  orphans: Orphan[] | null;
}

const OUTCOMES: Outcome[] = ['copied', 'skipped', 'missing', 'infected', 'unscanned', 'failed'];

async function writeText(sink: RunSink, name: string, contentType: string, text: string): Promise<void> {
  const file = await sink.create(name, contentType);
  await file.write(text);
  await file.close();
}

const jsonl = (lines: unknown[]) => lines.map((line) => `${canonicalJson(line)}\n`).join('');

export async function runCopyFiles(args: CopyFilesArgs, deps: CopyFilesDeps): Promise<CopyReport> {
  const { sink, log } = deps;
  const documentsText = await sink.read('transformed/documents.jsonl');
  if (documentsText === null) {
    throw new TransformOutputError(
      `${sink.location} has no transformed/documents.jsonl: run the transform (MIG-03) on this run first.`,
    );
  }
  const documents = parseJsonl('transformed/documents.jsonl', documentsText, DocumentLineSchema);
  const avatarsText = await sink.read('transformed/avatars.jsonl');
  const avatars = avatarsText === null ? [] : parseJsonl('transformed/avatars.jsonl', avatarsText, AvatarLineSchema);
  assertDistinctTargets([...documents, ...avatars]);
  const orphans = orphansOf(await sink.read('report.json'));

  const startedAt = deps.now().toISOString();
  log(
    `Copying ${documents.length} attachments and ${avatars.length} profile photos from gs://${args.sourceBucket} ` +
      `to gs://${args.filesBucket}, ${args.concurrency} at a time.`,
  );
  const ctx: CopyContext = {
    runId: args.runId,
    sourceBucket: args.sourceBucket,
    filesBucket: args.filesBucket,
    store: deps.store,
    scanner: deps.scanner,
    now: deps.now,
  };
  const safely = async (item: { legacyPath: string; copy: CopySpec }, role: 'document' | 'avatar') => {
    try {
      return await copyFile(ctx, item, role);
    } catch {
      // One file's error doesn't stop the run; the report lists it for a re-run.
      return { outcome: 'failed', reason: 'error' } satisfies FileResult;
    }
  };
  const documentResults = await inPool(documents, args.concurrency, (line) => safely(line, 'document'));
  const avatarResults = await inPool(avatars, args.concurrency, (line) => safely(line, 'avatar'));

  const documentLines = documents
    .map((line, i) => {
      const result = documentResults[i] as FileResult;
      return {
        path: line.path,
        legacyPath: line.legacyPath,
        data: documentRecord(line, result),
        copy: line.copy,
        result,
      };
    })
    .sort((a, b) => byCodeUnit(a.path, b.path));
  const avatarLines = avatars
    .map((line: AvatarLine, i) => ({ ...line, result: avatarResults[i] as FileResult }))
    .sort((a, b) => byCodeUnit(a.path, b.path));

  const all = [...documentLines, ...avatarLines];
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>;
  for (const { result } of all) counts[result.outcome]++;
  const pick = (outcome: Outcome) => all.filter((line) => line.result.outcome === outcome);
  const report: CopyReport = {
    version: 1,
    runId: args.runId,
    env: args.env,
    sourceBucket: args.sourceBucket,
    filesBucket: args.filesBucket,
    startedAt,
    finishedAt: deps.now().toISOString(),
    toolVersion: args.toolVersion,
    counts: {
      documents: documents.length,
      avatars: avatars.length,
      ...counts,
      typeMismatches: all.filter((line) => line.result.typeMismatch).length,
      orphans: orphans?.length ?? null,
    },
    complete: counts.unscanned === 0 && counts.failed === 0,
    missing: pick('missing').map((line) => line.legacyPath),
    infected: pick('infected').map((line) => ({
      legacyPath: line.legacyPath,
      signature: line.result.signature ?? 'unknown',
      quarantine: line.result.quarantine ?? '',
    })),
    unscanned: pick('unscanned').map((line) => line.legacyPath),
    failed: pick('failed').map((line) => ({ legacyPath: line.legacyPath, reason: line.result.reason ?? 'error' })),
    typeMismatches: all
      .filter((line) => line.result.typeMismatch)
      .map((line) => ({
        legacyPath: line.legacyPath,
        kind: line.result.kind ?? 'unknown',
        extension: domain.uploadExtension(line.copy.fileName) ?? '',
      })),
    orphans,
  };

  await writeText(sink, 'files/documents.jsonl', 'application/x-ndjson', jsonl(documentLines));
  await writeText(sink, 'files/avatars.jsonl', 'application/x-ndjson', jsonl(avatarLines));
  await writeText(sink, 'files/report.json', 'application/json', `${JSON.stringify(report, null, 2)}\n`);

  log(
    `Copied ${counts.copied}, already there ${counts.skipped}, missing in legacy ${counts.missing}, ` +
      `infected ${counts.infected}, unscanned ${counts.unscanned}, failed ${counts.failed}.`,
  );
  if (report.typeMismatches.length)
    log(`${report.typeMismatches.length} files aren't what their extension says (kept).`);
  if (orphans) log(`${orphans.length} legacy objects no document names (listed in files/report.json, D-13).`);
  if (counts.infected) log(`${counts.infected} infected files stay in ${MIGRATION_QUARANTINE}/${args.runId}/.`);
  log(`Wrote files/documents.jsonl, files/avatars.jsonl and files/report.json to ${sink.location}.`);
  return report;
}
