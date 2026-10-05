import type { AdminApi, Operation } from './admin-api.ts';

/**
 * `materia-scripts backup-drill --project <id> [--source backup|export|pitr|all] [--keep]` (SEC-03):
 * the restore drill. Restores the newest managed backup, the newest nightly export (from the
 * backups bucket in australia-southeast2) or a PITR clone into a scratch database `drill-…`,
 * checks every collection group's document count against the live database as of the same
 * snapshot time (PITR), records how long it took, and deletes the scratch database. The
 * quarterly `backup-drill` workflow runs it on dev with `--source all`; results go to the run
 * summary (docs/runbooks/restore.md, "Drill").
 *
 * Measured: RPO, the snapshot's age when the drill started (what a restore would lose), and the
 * restore time (the RTO's largest part; a real restore adds the switch-over, see the runbook).
 */

export type DrillSource = 'backup' | 'export' | 'pitr';

/** What the drill needs from Firestore, so a test can run it against a fake. */
export interface DrillDatabases {
  /** Collection ids found in a database (walked). */
  collectionIds(databaseId: string): Promise<string[]>;
  /** A collection group's count in a database, now or as of a PITR read time. */
  count(databaseId: string, group: string, readTime?: string): Promise<number>;
}

export interface DrillResult {
  source: DrillSource;
  database: string;
  /** Where it came from: the backup's or export's name, or the PITR time. */
  from: string;
  snapshotTime: string;
  rpoMinutes: number;
  restoreSeconds: number;
  verifySeconds: number;
  documents: number;
  groups: { group: string; restored: number; live: number }[];
  mismatches: string[];
  /** False when the snapshot is outside the PITR window, so counts compare against today's data. */
  exact: boolean;
  deleted: boolean;
}

export interface DrillOptions {
  location: string;
  backupsBucket: string;
  keep: boolean;
  now: () => number;
  log: (line: string) => void;
}

const PITR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** `drill-20261006-0930-backup`: a valid, unique-enough database id. */
export function scratchId(source: DrillSource, at: number): string {
  const stamp = new Date(at).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `drill-${stamp}-${source}`;
}

/** The whole minute at least two minutes ago, for a PITR clone. */
export const pitrSnapshot = (now: number) => new Date(Math.floor(now / 60_000) * 60_000 - 120_000).toISOString();

async function restoreInto(
  api: AdminApi,
  source: DrillSource,
  database: string,
  opts: DrillOptions,
): Promise<{ from: string; snapshotTime: string }> {
  let op: Operation;
  let picked: { from: string; snapshotTime: string };
  if (source === 'backup') {
    const [backup] = await api.listBackups(opts.location);
    if (!backup) throw new Error(`No ready managed backup of (default) in ${opts.location}`);
    picked = { from: backup.name, snapshotTime: backup.snapshotTime };
    op = await api.restore(database, backup.name);
  } else if (source === 'export') {
    const [folder] = await api.listExports(opts.backupsBucket);
    if (!folder) throw new Error(`No finished export in gs://${opts.backupsBucket}`);
    picked = { from: folder.uri, snapshotTime: folder.snapshotTime };
    await api.wait(await api.createDatabase(database, opts.location));
    op = await api.importDocuments(database, folder.uri);
  } else {
    const snapshotTime = pitrSnapshot(opts.now());
    picked = { from: `PITR ${snapshotTime}`, snapshotTime };
    op = await api.clone(database, snapshotTime);
  }
  opts.log(`  restoring ${picked.from} (snapshot ${picked.snapshotTime}) into ${database}`);
  await api.wait(op);
  return picked;
}

export async function drill(
  api: AdminApi,
  dbs: DrillDatabases,
  source: DrillSource,
  opts: DrillOptions,
): Promise<DrillResult> {
  const started = opts.now();
  const database = scratchId(source, started);
  opts.log(`backup-drill ${source}: ${api.project}`);
  let deleted = false;
  let result: Omit<DrillResult, 'deleted'>;
  try {
    const picked = await restoreInto(api, source, database, opts);
    const restored = opts.now();
    const snapshotMs = new Date(picked.snapshotTime).getTime();
    const exact = restored - snapshotMs < PITR_WINDOW_MS - 10 * 60 * 1000;
    const ids = [
      ...new Set([...(await dbs.collectionIds(database)), ...(await dbs.collectionIds('(default)'))]),
    ].sort();
    const groups = [];
    for (const group of ids) {
      groups.push({
        group,
        restored: await dbs.count(database, group),
        live: await dbs.count('(default)', group, exact ? picked.snapshotTime : undefined),
      });
    }
    const mismatches = groups
      .filter((g) => g.restored !== g.live)
      .map((g) => `${g.group}: restored ${g.restored}, live ${g.live}`);
    const verified = opts.now();
    for (const line of mismatches) opts.log(`  MISMATCH ${line}`);
    result = {
      source,
      database,
      ...picked,
      rpoMinutes: Math.round((started - snapshotMs) / 60_000),
      restoreSeconds: Math.round((restored - started) / 1000),
      verifySeconds: Math.round((verified - restored) / 1000),
      documents: groups.reduce((sum, g) => sum + g.restored, 0),
      groups,
      mismatches,
      exact,
    };
  } finally {
    if (!opts.keep) {
      try {
        await api.wait(await api.deleteDatabase(database));
        deleted = true;
        opts.log(`  deleted ${database}`);
      } catch (error) {
        // A restore that never started leaves nothing to delete.
        opts.log(`  could not delete ${database}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { ...result, deleted };
}

/** The drill results as the Markdown the workflow writes to the run summary. */
export function summary(results: readonly DrillResult[]): string {
  const lines = [
    '### Restore drill',
    '',
    '| Source | Snapshot | RPO | Restore | Verify | Documents | Groups | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const result = r.mismatches.length
      ? `❌ ${r.mismatches.length} mismatched`
      : r.exact
        ? '✅ counts match'
        : '⚠️ counts vs today';
    lines.push(
      `| ${r.source} | ${r.snapshotTime} | ${r.rpoMinutes} min | ${r.restoreSeconds} s | ${r.verifySeconds} s | ${r.documents} | ${r.groups.length} | ${result} |`,
    );
  }
  const mismatched = results.flatMap((r) => r.mismatches.map((m) => `- ${r.source}: ${m}`));
  if (mismatched.length) lines.push('', '**Mismatches**', '', ...mismatched);
  return lines.join('\n');
}

export interface DrillArgs {
  project: string;
  sources: DrillSource[];
  keep: boolean;
}

export function parseArgs(argv: string[]): DrillArgs {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project');
  if (!project)
    throw new Error('Usage: materia-scripts backup-drill --project <id> [--source backup|export|pitr|all] [--keep]');
  if (project.endsWith('-prod')) throw new Error('The drill runs on dev; restore prod by the runbook');
  const source = value('source') ?? 'backup';
  const sources: DrillSource[] =
    source === 'all'
      ? ['backup', 'export']
      : source === 'backup' || source === 'export' || source === 'pitr'
        ? [source]
        : [];
  if (!sources.length) throw new Error(`--source is backup, export, pitr or all (got "${source}")`);
  return { project, sources, keep: argv.includes('--keep') };
}

export async function main(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv);
  const { initializeApp, deleteApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { AdminApi } = await import('./admin-api.ts');
  const { apiDeps, collectionIds, countGroup } = await import('./firestore.ts');
  const { appendFile } = await import('node:fs/promises');

  const app = initializeApp({ projectId: args.project }, `backup-drill-${Date.now()}`);
  const api = new AdminApi(apiDeps(), args.project);
  const dbs: DrillDatabases = {
    collectionIds: (id) => collectionIds(getFirestore(app, id)),
    count: (id, group, readTime) => countGroup(getFirestore(app, id), group, readTime),
  };
  const results: DrillResult[] = [];
  try {
    for (const source of args.sources) {
      results.push(
        await drill(api, dbs, source, {
          location: 'australia-southeast1',
          backupsBucket: `${args.project}-backups`,
          keep: args.keep,
          now: Date.now,
          log: (line) => console.log(line),
        }),
      );
    }
  } finally {
    await deleteApp(app);
  }
  const markdown = summary(results);
  console.log(markdown);
  console.log(JSON.stringify(results.map((r) => ({ ...r, groups: r.groups.length }))));
  if (process.env['GITHUB_STEP_SUMMARY']) await appendFile(process.env['GITHUB_STEP_SUMMARY'], `${markdown}\n`);
  if (results.some((r) => r.mismatches.length)) throw new Error('Restore drill: counts differ (see above)');
}
