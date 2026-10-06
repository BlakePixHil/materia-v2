import * as z from 'zod';

import { domain } from '../domain.ts';
import { docPathPattern, orgOf, PHASES, TRANSFORMED_FILES, type Phase } from './entities.ts';
import { decodeTagged, type Data } from './values.ts';
import { sha256 } from '../export/jsonl.ts';
import type { RunSink } from '../export/sink.ts';
import { TransformOutputError } from '../files/contract.ts';
import type { CopyReport, FileResult } from '../files/copy.ts';
import { isPlainObject } from '../legacy/snapshot.ts';

/**
 * A run as the load reads it from `gs://materia-v2-<env>-migration/runs/{runId}/`: the
 * transform's files (MIG-03) and the attachment copy's documents (MIG-05), each line checked
 * against its entity's schema, instants decoded and `migration.loadedAt` stamped with the load's
 * time (the transform writes the export's `readTime` there, so its output is byte-identical).
 */

export interface LoadLine {
  path: string;
  legacyPath: string;
  data: Data;
  /** Documents: the legacy object behind the line (MIG-03) and how its copy went (MIG-05). */
  copy?: { md5Hash?: string; sizeBytes?: number };
  outcome?: string;
}

export interface PhaseInput {
  phase: Phase;
  lines: LoadLine[];
}

export interface RunInput {
  orgId: string;
  /** The org document, when the run creates the org (`transform --target-org new`). */
  orgLine: LoadLine | undefined;
  phases: PhaseInput[];
  /** The uids the run makes members (whose claims the load syncs). */
  memberUids: string[];
  /** The transform's `report.json`. */
  report: Data;
  copyReport: CopyReport | null;
  /** Documents whose file isn't in v2: legacy lost it, or the copy didn't finish (`--skip-unfinished-files`). */
  documentsWithoutFile: number;
}

/** A line of a transform file. `copy` and `result` (MIG-05) are read where the load needs them. */
const LineSchema = z.object({
  path: z.string().min(1),
  legacyPath: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  copy: z.unknown().optional(),
  result: z.object({ outcome: z.string() }).loose().optional(),
});

/** The review codes a document without its file gets (D-20). */
export const FILE_MISSING = 'MIG_W_ATTACHMENT_OBJECT_MISSING';
export const FILE_NOT_COPIED = 'MIG_W_ATTACHMENT_NOT_COPIED';

export interface ReadOptions {
  now: Date;
  /** Load documents whose copy is unscanned or failed, as files to review, rather than stopping. */
  skipUnfinishedFiles: boolean;
}

export async function readRun(sink: RunSink, runId: string, options: ReadOptions): Promise<RunInput> {
  const reportText = await sink.read('report.json');
  if (reportText === null) {
    throw new TransformOutputError(`Run ${runId} has no report.json: transform it first (MIG-03), or let it finish.`);
  }
  const report = parseObject('report.json', reportText);
  const listed = report['files'];
  if (!isPlainObject(listed) || !Object.keys(listed).length) {
    throw new TransformOutputError(
      `Run ${runId}'s report.json lists no files: the transform rejected records (see its rejects) or didn't ` +
        'finish, so nothing in the run is safe to load.',
    );
  }

  // A file this load doesn't know would be left out silently: the transform's contract changed.
  const unknown = Object.keys(listed).filter(
    (key) => key !== 'idmap.jsonl' && !TRANSFORMED_FILES.has(key.replace(/^transformed\//, '').replace(/\.jsonl$/, '')),
  );
  if (unknown.length) {
    throw new TransformOutputError(
      `The transform wrote ${unknown.join(', ')}, which this load doesn't know: update materia-migrate to load them.`,
    );
  }

  const copyText = await sink.read('files/report.json');
  const copyReport = copyText === null ? null : (parseObject('files/report.json', copyText) as unknown as CopyReport);

  let orgId: string | undefined;
  const phases: PhaseInput[] = [];
  let documentsWithoutFile = 0;
  let transformedDocuments: string | null = null;
  for (const phase of PHASES) {
    const transformedName = `transformed/${phase.file}.jsonl`;
    const transformed = await sink.read(transformedName);
    checkListed(listed, phase.file, transformedName, transformed);
    const name = phase.source ?? transformedName;
    const text = phase.source ? await sink.read(phase.source) : transformed;
    if (phase.file === 'documents') {
      transformedDocuments = transformed;
      if (text === null && hasLines(transformed)) {
        throw new TransformOutputError(
          `Run ${runId} has transformed documents but no ${name}: run copy-files first (MIG-05).`,
        );
      }
    }
    const pattern = docPathPattern(phase.entity.path);
    const lines: LoadLine[] = [];
    let previous = '';
    (text ?? '').split('\n').forEach((row, index) => {
      if (!row.trim()) return;
      const where = `${name} line ${index + 1}`;
      let raw: unknown;
      try {
        raw = JSON.parse(row);
      } catch {
        throw new TransformOutputError(`${where} is not JSON.`);
      }
      const line = LineSchema.safeParse(raw);
      if (!line.success) throw new TransformOutputError(`${where}: ${firstIssue(line.error)}.`);
      const { path, legacyPath } = line.data;
      if (!pattern.test(path)) throw new TransformOutputError(`${where}: ${path} is not a ${phase.file} path.`);
      if (path <= previous) throw new TransformOutputError(`${where}: lines must be sorted by path, without repeats.`);
      previous = path;
      const lineOrg = orgOf(path);
      if (lineOrg) {
        orgId ??= lineOrg;
        if (lineOrg !== orgId) throw new TransformOutputError(`${where}: ${path} is in another org than ${orgId}.`);
      }

      let data: Data;
      try {
        data = decodeTagged(line.data.data) as Data;
      } catch (err) {
        throw new TransformOutputError(`${where}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (phase.file === 'documents') {
        const missing = withoutFile(line.data.result?.outcome, where, options);
        if (missing) {
          documentsWithoutFile += 1;
          // No `at`, so a re-run (and verify) derives the same document.
          data = { ...data, scan: { status: 'error' }, needsReview: addCode(data, missing) };
        }
      }
      data = restamp(phase, data, options.now);
      const parsed = (phase.entity.schema as z.ZodType<Data>).safeParse(data);
      if (!parsed.success) throw new TransformOutputError(`${where}: ${firstIssue(parsed.error)}.`);
      const { copy, result } = line.data;
      lines.push({
        path,
        legacyPath,
        data: parsed.data,
        ...(copy && typeof copy === 'object' ? { copy: copy as NonNullable<LoadLine['copy']> } : {}),
        ...(result ? { outcome: result.outcome } : {}),
      });
    });
    if (phase.file === 'documents' && transformedDocuments !== null) {
      const planned = (transformedDocuments as string)
        .split('\n')
        .filter((row) => row.trim())
        .map((row) => (JSON.parse(row) as { path?: unknown }).path);
      if (planned.join('\n') !== lines.map((line) => line.path).join('\n')) {
        throw new TransformOutputError(
          `${name} doesn't hold the transform's documents (it was copied from an earlier transform): run copy-files again.`,
        );
      }
    }
    phases.push({ phase, lines });
  }

  const orgLines = phases.find((input) => input.phase.file === 'orgs')?.lines ?? [];
  if (orgLines.length > 1) throw new TransformOutputError('transformed/orgs.jsonl has more than one org.');
  if (!orgId) throw new TransformOutputError(`Run ${runId} loads nothing into an org.`);
  const memberUids = (phases.find((input) => input.phase.file === 'members')?.lines ?? []).map((line) =>
    line.path.slice(line.path.lastIndexOf('/') + 1),
  );
  return { orgId, orgLine: orgLines[0], phases, memberUids, report, copyReport, documentsWithoutFile };
}

const hasLines = (text: string | null) => !!text?.trim();

/**
 * A transformed file must be the one the transform's report lists, by sha256: a run transformed
 * again (or once with rejects) may still hold files from before.
 */
function checkListed(listed: Data, file: string, name: string, text: string | null): void {
  const entry = [`${file}.jsonl`, name, file].map((key) => listed[key]).find((value) => value !== undefined);
  if (text === null && entry === undefined) return;
  if (text === null) throw new TransformOutputError(`The transform's report lists ${name}, which isn't in the run.`);
  const expected = isPlainObject(entry) ? entry['sha256'] : undefined;
  if (typeof expected !== 'string') {
    throw new TransformOutputError(`${name} isn't in the transform's report: it is left from an earlier transform.`);
  }
  if (sha256(text) !== expected.toLowerCase()) {
    throw new TransformOutputError(`${name} isn't the file the transform's report lists (its sha256 differs).`);
  }
}

function parseObject(name: string, text: string): Data {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TransformOutputError(`${name} is not JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TransformOutputError(`${name} is not an object.`);
  }
  return value as Data;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join('.') || 'line'} ${issue?.message ?? 'is not valid'}`;
}

/**
 * The review code for a document whose file the copy (MIG-05) didn't put in v2, or none. Legacy
 * lost the file (`missing`): the record still loads, so the user sees the attachment existed.
 * The copy didn't finish (`unscanned`, `failed`): the load stops, unless told to load them as files
 * to review.
 */
function withoutFile(outcome: FileResult['outcome'] | string | undefined, where: string, options: ReadOptions) {
  if (outcome === undefined) throw new TransformOutputError(`${where}: no copy result: run copy-files again.`);
  if (outcome === 'missing') return FILE_MISSING;
  if (outcome === 'unscanned' || outcome === 'failed') {
    if (!options.skipUnfinishedFiles) {
      throw new TransformOutputError(
        `${where}: the copy is ${outcome}. Run copy-files again, or pass --skip-unfinished-files to load it as a file to review.`,
      );
    }
    return FILE_NOT_COPIED;
  }
  return undefined;
}

function addCode(data: Data, code: string): string[] {
  const codes = Array.isArray(data['needsReview']) ? (data['needsReview'] as string[]) : [];
  return codes.includes(code) ? codes : [...codes, code];
}

/**
 * The load's time where the transform wrote the export's: `migration.loadedAt`, and for a new
 * org its MFA grace (`newOrgSecurity`), which would otherwise have started at the export.
 */
function restamp(phase: Phase, data: Data, now: Date): Data {
  const next: Data = { ...data };
  const migration = data['migration'];
  if (migration && typeof migration === 'object') next['migration'] = { ...migration, loadedAt: now };
  const security = data['security'];
  if (phase.file === 'orgs' && security && typeof security === 'object') {
    const fresh = domain.newOrgSecurity(now);
    next['security'] = {
      ...security,
      mfaRequiredSince: fresh.mfaRequiredSince,
      mfaEnforceAfter: fresh.mfaEnforceAfter,
    };
  }
  return next;
}
