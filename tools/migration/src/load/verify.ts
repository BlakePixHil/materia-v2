import type { Phase } from './entities.ts';
import { readAll, writeReport, type Env } from './load.ts';
import { reconcile } from './plan.ts';
import { readRun, type LoadLine, type RunInput } from './run-files.ts';
import type { AuthPort, TargetDb } from './target.ts';
import { changedFields, editedAfterLoad, provenanceOf, type Data } from './values.ts';
import type { RunSink } from '../export/sink.ts';
import type { ObjectStore } from '../files/gcs.ts';

/**
 * `materia-migrate verify` (MIG-06): proves a loaded run lost nothing.
 *
 * - **Every record:** each line the run loaded is read back from v2 and compared field by field
 *   (fields v2 maintains itself aside). Missing or different fails; one changed in v2 after the
 *   load, or reloaded by a later run, is counted and passes.
 * - **Files:** each copied attachment's object is where its document says, with the same size,
 *   sha256, and MD5 as the legacy file the export listed.
 * - **Access:** each member's custom claims name the org with their role, and on the emulator
 *   every loaded document is read as them through the security rules.
 * - **Privileged:** nothing migrated is privileged (legacy had no such flag).
 *
 * Writes `verify/report.json` and `verify/verify-report.md` to the run; logs counts only.
 */

export interface VerifyDeps {
  sink: RunSink;
  db: TargetDb;
  auth: AuthPort;
  files: { store: ObjectStore; bucket: string };
  /** Reads documents as a person through the rules and returns the paths refused (emulator only). */
  readAs?: (uid: string, claims: Record<string, unknown>, paths: readonly string[]) => Promise<string[]>;
  now: () => Date;
  log: (line: string) => void;
}

export interface EntityCheck {
  loaded: number;
  matching: number;
  differing: number;
  missing: number;
  editedInV2: number;
  /** Different, and written by another run since (a delta). */
  laterRun: number;
  notMigrated: number;
}

export interface VerifyReport {
  version: 1;
  runId: string;
  env: Env;
  orgId: string;
  checkedAt: string;
  passed: boolean;
  entities: Record<string, EntityCheck>;
  /** The export's counts (manifest.json) and the transform's rejects, for the legacy side. */
  legacy: { manifestCounts: unknown; rejects: number | null };
  differing: { path: string; fields: string[] }[];
  missing: string[];
  files: { checked: number; problems: { path: string; problem: string }[] };
  access: { uid: string; claims: string; reads: string }[];
  privileged: string[];
}

/** Paths listed in a report section, at most. */
const LIST_MAX = 200;

export async function runVerify(args: { runId: string; env: Env }, deps: VerifyDeps): Promise<VerifyReport> {
  const checkedAt = deps.now();
  const input = await readRun(deps.sink, args.runId, { now: checkedAt, skipUnfinishedFiles: true });
  const entities: Record<string, EntityCheck> = {};
  const differing: VerifyReport['differing'] = [];
  const missing: string[] = [];
  const present = new Map<string, Data>();
  const privileged: string[] = [];

  for (const { phase, lines } of input.phases) {
    if (!lines.length) continue;
    const found = await readAll(
      deps.db,
      lines.map((line) => line.path),
    );
    const check: EntityCheck = {
      loaded: lines.length,
      matching: 0,
      differing: 0,
      missing: 0,
      editedInV2: 0,
      laterRun: 0,
      notMigrated: 0,
    };
    for (const line of lines) {
      const existing = found.get(line.path);
      const outcome = compare(phase, line, existing, args.runId);
      check[outcome.result] += 1;
      if (outcome.result === 'missing') missing.push(line.path);
      if (outcome.result === 'differing') differing.push({ path: line.path, fields: outcome.fields });
      if (existing && phase.kind === 'doc') {
        present.set(line.path, existing);
        if (existing['privileged'] === true) privileged.push(line.path);
      }
    }
    entities[phase.file] = check;
  }

  const files = await checkFiles(input, present, deps.files);
  const access = await checkAccess(input, present, deps);
  const manifest = await deps.sink.read('manifest.json');
  const rejects = input.report['rejects'];
  const report: VerifyReport = {
    version: 1,
    runId: args.runId,
    env: args.env,
    orgId: input.orgId,
    checkedAt: checkedAt.toISOString(),
    passed:
      !missing.length &&
      !differing.length &&
      !files.problems.length &&
      access.every((person) => person.claims === 'ok' && !person.reads.startsWith('refused')) &&
      !privileged.length,
    entities,
    legacy: {
      manifestCounts: manifest ? ((JSON.parse(manifest) as Data)['counts'] ?? null) : null,
      rejects: Array.isArray(rejects) ? rejects.length : null,
    },
    differing: differing.slice(0, LIST_MAX),
    missing: missing.slice(0, LIST_MAX),
    files: { checked: files.checked, problems: files.problems.slice(0, LIST_MAX) },
    access,
    privileged: privileged.slice(0, LIST_MAX),
  };
  await writeReport(deps.sink, 'verify/report.json', report);
  const markdown = await deps.sink.create('verify/verify-report.md', 'text/markdown');
  await markdown.write(renderMarkdown(report));
  await markdown.close();
  deps.log(
    `${report.passed ? 'Verified' : 'NOT verified'}: ${missing.length} missing, ${differing.length} different, ` +
      `${files.problems.length} file problems, ${privileged.length} privileged. See verify/verify-report.md.`,
  );
  return report;
}

type Outcome = { result: Exclude<keyof EntityCheck, 'loaded'>; fields: string[] };

function compare(phase: Phase, line: LoadLine, existing: Data | undefined, runId: string): Outcome {
  const result = (r: Outcome['result'], fields: string[] = []): Outcome => ({ result: r, fields });
  if (!existing) return result('missing');
  if (phase.kind === 'counter') {
    return Number(existing['next']) >= Number(line.data['next']) ? result('matching') : result('differing', ['next']);
  }
  if (phase.kind === 'reservation') {
    return existing['matterId'] === line.data['matterId'] ? result('matching') : result('differing', ['matterId']);
  }
  const loaded = provenanceOf(existing);
  if (!loaded) return result('notMigrated');
  if (editedAfterLoad(existing)) return result('editedInV2');
  // As loaded, by whichever run wrote it last (a delta leaves what it finds unchanged as it was).
  const expected: Data = { ...reconcile(phase, line.data, existing), migration: existing['migration'] };
  // Fields only v2 adds (a trigger's denormalisation) aren't the migration's to check.
  const fields = changedFields(expected, existing).filter((field) => field in expected);
  if (!fields.length) return result('matching');
  return loaded.runId === runId ? result('differing', fields) : result('laterRun');
}

async function checkFiles(input: RunInput, present: Map<string, Data>, files: VerifyDeps['files']) {
  const problems: { path: string; problem: string }[] = [];
  let checked = 0;
  const documents = input.phases.find((item) => item.phase.file === 'documents')?.lines ?? [];
  for (const line of documents) {
    if (line.outcome !== 'copied' && line.outcome !== 'skipped') continue;
    const doc = present.get(line.path);
    if (!doc) continue;
    checked += 1;
    const storagePath = doc['storagePath'];
    if (typeof storagePath !== 'string') {
      problems.push({ path: line.path, problem: 'no storagePath' });
      continue;
    }
    const object = await files.store.stat(files.bucket, storagePath);
    if (!object) problems.push({ path: line.path, problem: 'file missing' });
    else if (object.size !== doc['sizeBytes']) problems.push({ path: line.path, problem: 'size differs' });
    else if (object.metadata['sha256'] !== doc['sha256']) problems.push({ path: line.path, problem: 'sha256 differs' });
    else if (line.copy?.md5Hash && object.md5Hash !== line.copy.md5Hash) {
      problems.push({ path: line.path, problem: 'MD5 differs from the legacy file' });
    }
  }
  return { checked, problems };
}

async function checkAccess(input: RunInput, present: Map<string, Data>, deps: VerifyDeps) {
  const members = await deps.db.getAll(input.memberUids.map((uid) => `orgs/${input.orgId}/members/${uid}`));
  const access: VerifyReport['access'] = [];
  for (const uid of input.memberUids) {
    const member = members.get(`orgs/${input.orgId}/members/${uid}`);
    const claims = await deps.auth.claimsOf(uid);
    const orgs = (claims?.['orgs'] ?? {}) as Record<string, unknown>;
    let claimsCheck = 'ok';
    if (!claims) claimsCheck = 'no account';
    else if (!member || member['status'] !== 'active') claimsCheck = 'not an active member';
    else if (orgs[input.orgId] !== member['role']) claimsCheck = "the claims don't give the org's role";
    let reads = 'not checked here (the emulator rehearsal reads as the person)';
    if (deps.readAs && claims) {
      const refused = await deps.readAs(uid, claims, [...present.keys()]);
      reads = refused.length
        ? `refused ${refused.length} of ${present.size}, for example ${refused[0]}`
        : `all ${present.size} read`;
    }
    access.push({ uid, claims: claimsCheck, reads });
  }
  return access;
}

function renderMarkdown(report: VerifyReport): string {
  const rows = Object.entries(report.entities).map(
    ([file, c]) =>
      `| ${file} | ${c.loaded} | ${c.matching} | ${c.differing} | ${c.missing} | ${c.editedInV2} | ${c.laterRun} | ${c.notMigrated} |`,
  );
  const list = (title: string, items: string[]) =>
    items.length ? [`## ${title}`, '', ...items.map((item) => `- ${item}`), ''] : [];
  return [
    `# Verify: run ${report.runId} (${report.env})`,
    '',
    `**${report.passed ? 'Passed' : 'Failed'}** at ${report.checkedAt}, org \`${report.orgId}\`.`,
    '',
    '| Records | Loaded | Matching | Different | Missing | Changed in v2 | Reloaded later | Left alone |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Legacy (export manifest): \`${JSON.stringify(report.legacy.manifestCounts)}\`. Rejected by the transform: ${report.legacy.rejects ?? 'unknown'}.`,
    '',
    `Files checked: ${report.files.checked}, problems: ${report.files.problems.length}.`,
    '',
    '## Access',
    '',
    ...report.access.map((person) => `- \`${person.uid}\`: claims ${person.claims}; reads ${person.reads}`),
    '',
    ...list(
      'Missing',
      report.missing.map((path) => `\`${path}\``),
    ),
    ...list(
      'Different',
      report.differing.map((item) => `\`${item.path}\`: ${item.fields.join(', ')}`),
    ),
    ...list(
      'File problems',
      report.files.problems.map((item) => `\`${item.path}\`: ${item.problem}`),
    ),
    ...list(
      'Privileged (none expected)',
      report.privileged.map((path) => `\`${path}\``),
    ),
  ].join('\n');
}
