import { randomUUID } from 'node:crypto';

import {
  countByCollection,
  diffSubtrees,
  readSubtree,
  type Data,
  type SubtreeDiff,
  type SubtreeReader,
} from './subtree.ts';

/**
 * `materia-scripts restore-matter` (SEC-03): puts one matter and everything under it back as it
 * was at a PITR timestamp (`--read-time`, within the last 7 days) or in a restored database
 * (`--from-database`, a managed backup or an import restored next to the live one; see
 * docs/runbooks/restore.md). A dry run by default: it lists what it would create, overwrite and
 * leave alone; `--apply` writes it, `--delete-extra` also deletes what was added since. Logs paths'
 * collection names and counts only, never document contents.
 *
 * It refuses a matter that was destroyed (CORE-19: a `destructionCertificates/dc-{matterId}` or a
 * tombstone in the target) or whose practice was deleted (SEC-05: `deletedOrgs/{orgId}`), so a
 * restore never brings destroyed data back, and refuses to write
 * while a migration run is in progress in the org (Legacy migration plan; coordinate by run id).
 * The restore is audited as `matter.restored` with a run id; the audit trigger also records each
 * document it writes.
 */

export interface RestoreTarget extends SubtreeReader {
  /** Writes each document whole (replacing what's there). */
  write(docs: { path: string; data: Data }[]): Promise<void>;
  delete(paths: readonly string[]): Promise<void>;
  /** Ids of the org's migration runs with status `running`. */
  runningMigrations(orgId: string): Promise<string[]>;
  /** Appends an audit entry for the org; returns its id. */
  audit(orgId: string, entry: Data): Promise<string>;
}

export interface RestoreOptions {
  orgId: string;
  matterId: string;
  /** Says where the data came from, for the report and the audit entry. */
  source: { readTime: string } | { database: string };
  apply: boolean;
  deleteExtra: boolean;
  now: Date;
  runId?: string;
  log: (line: string) => void;
}

export interface RestoreReport {
  runId: string;
  matterPath: string;
  diff: SubtreeDiff;
  applied: boolean;
  deleted: number;
  auditId?: string;
}

export class RestoreRefused extends Error {
  override readonly name = 'RestoreRefused';
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** The org's audit retention in years (`retentionYears`, default 7), as functions compute `expireAt`. */
function retentionYears(org: Data | null): number {
  const value = org?.['retentionYears'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 7;
}

export async function restoreMatter(
  source: SubtreeReader,
  target: RestoreTarget,
  opts: RestoreOptions,
): Promise<RestoreReport> {
  if (!ID.test(opts.orgId) || !ID.test(opts.matterId)) throw new Error('--org and --matter must be document ids');
  const runId = opts.runId ?? `restore-${randomUUID()}`;
  const matterPath = `orgs/${opts.orgId}/matters/${opts.matterId}`;
  const { log } = opts;

  // A deleted practice (SEC-05, ADR-058) stays deleted: its tombstone outlives everything else.
  if (await target.get(`deletedOrgs/${opts.orgId}`)) {
    throw new RestoreRefused(
      `Practice ${opts.orgId} was deleted (SEC-05); restoring any of it would bring deleted data back. Nothing was written.`,
    );
  }
  const certificate = await target.get(`orgs/${opts.orgId}/destructionCertificates/dc-${opts.matterId}`);
  const live = await target.get(matterPath);
  if (certificate || live?.['destroyedAt'] || live?.['certificateId']) {
    throw new RestoreRefused(
      `Matter ${opts.matterId} was destroyed (CORE-19); restoring it would bring destroyed data back. Nothing was written.`,
    );
  }

  const from = await readSubtree(source, matterPath);
  if (!from.has(matterPath)) {
    throw new RestoreRefused(
      `Matter ${opts.matterId} isn’t in the source (${describe(opts.source)}). Nothing was written.`,
    );
  }
  const current = await readSubtree(target, matterPath);
  const diff = diffSubtrees(from, current);

  log(`restore-matter ${runId}: ${matterPath} from ${describe(opts.source)}${opts.apply ? '' : ' (dry run)'}`);
  log(`  source documents: ${from.size} ${JSON.stringify(countByCollection([...from.keys()]))}`);
  log(`  create ${diff.create.length} ${JSON.stringify(countByCollection(diff.create))}`);
  log(`  overwrite ${diff.overwrite.length} ${JSON.stringify(countByCollection(diff.overwrite))}`);
  log(`  unchanged ${diff.unchanged.length}`);
  log(
    `  added since ${diff.extra.length} ${JSON.stringify(countByCollection(diff.extra))}${opts.deleteExtra ? ' (deleted with --apply)' : ' (kept; --delete-extra deletes them)'}`,
  );
  for (const path of [...diff.create, ...diff.overwrite]) log(`    write ${path}`);
  if (opts.deleteExtra) for (const path of diff.extra) log(`    delete ${path}`);

  const report: RestoreReport = { runId, matterPath, diff, applied: false, deleted: 0 };
  if (!opts.apply) {
    log('  dry run: nothing written. Run again with --apply to restore.');
    return report;
  }

  const running = await target.runningMigrations(opts.orgId);
  if (running.length) {
    throw new RestoreRefused(
      `Migration run ${running.join(', ')} is in progress in org ${opts.orgId}; wait for it to finish (or roll it back) first. Nothing was written.`,
    );
  }

  const writes = [...diff.create, ...diff.overwrite].map((path) => ({ path, data: from.get(path) as Data }));
  await target.write(writes);
  const deletes = opts.deleteExtra ? diff.extra : [];
  if (deletes.length) await target.delete(deletes);

  const at = opts.now;
  const org = await target.get(`orgs/${opts.orgId}`);
  const auditId = await target.audit(opts.orgId, {
    at,
    actor: 'system',
    action: 'matter.restored',
    entity: { path: matterPath, collection: 'matters', id: opts.matterId, matterId: opts.matterId },
    summary: `Matter restored from backup: ${writes.length} documents written, ${deletes.length} deleted`,
    data: {
      ...('readTime' in opts.source ? { readTime: opts.source.readTime } : { database: opts.source.database }),
      created: diff.create.length,
      overwritten: diff.overwrite.length,
      unchanged: diff.unchanged.length,
      addedSince: diff.extra.length,
      deleted: deletes.length,
    },
    runId,
    source: 'job',
    expireAt: new Date(at.getTime() + retentionYears(org) * YEAR_MS),
    createdAt: at,
    createdBy: 'system',
    updatedAt: at,
    updatedBy: 'system',
    schemaVersion: 1,
  });
  log(`  restored: ${writes.length} written, ${deletes.length} deleted; audit ${auditId}`);
  return { ...report, applied: true, deleted: deletes.length, auditId };
}

const describe = (source: RestoreOptions['source']) =>
  'readTime' in source ? `PITR ${source.readTime}` : `database ${source.database}`;

const PITR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Checks a PITR read time against Firestore's rules: in the past, within 7 days, and on a whole
 * minute when it's more than an hour old. Returns it normalised to RFC 3339 UTC.
 */
export function checkReadTime(value: string, now: Date): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime()))
    throw new Error(`--read-time "${value}" isn’t a timestamp (use 2026-10-05T14:59:00Z)`);
  const age = now.getTime() - time.getTime();
  if (age <= 0) throw new Error('--read-time must be in the past');
  if (age > PITR_WINDOW_MS)
    throw new Error('--read-time is older than the 7-day PITR window; restore a backup and use --from-database');
  if (age > 60 * 60 * 1000 && time.getTime() % 60_000 !== 0)
    throw new Error('--read-time more than an hour old must be a whole minute (Firestore PITR)');
  return time.toISOString();
}

export interface RestoreArgs {
  project: string;
  orgId: string;
  matterId: string;
  readTime?: string;
  fromDatabase?: string;
  targetDatabase: string;
  apply: boolean;
  deleteExtra: boolean;
}

const USAGE =
  'Usage: materia-scripts restore-matter --project <id> --org <orgId> --matter <matterId> (--read-time <RFC 3339> | --from-database <id>) [--target-database <id>] [--apply] [--delete-extra]';

export function parseArgs(argv: string[], now = new Date()): RestoreArgs {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project');
  const orgId = value('org');
  const matterId = value('matter');
  const readTime = value('read-time');
  const fromDatabase = value('from-database');
  const targetDatabase = value('target-database') ?? '(default)';
  if (!project || !orgId || !matterId) throw new Error(USAGE);
  if (!readTime === !fromDatabase) throw new Error(`Give exactly one of --read-time or --from-database.\n${USAGE}`);
  if (fromDatabase === targetDatabase) throw new Error('--from-database is the target database');
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('--apply and --dry-run together');
  return {
    project,
    orgId,
    matterId,
    ...(readTime ? { readTime: checkReadTime(readTime, now) } : {}),
    ...(fromDatabase ? { fromDatabase } : {}),
    targetDatabase,
    apply: argv.includes('--apply'),
    deleteExtra: argv.includes('--delete-extra'),
  };
}

export async function main(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv);
  const { openRestore } = await import('./firestore.ts');
  const { source, target, close } = await openRestore(args);
  try {
    await restoreMatter(source, target, {
      orgId: args.orgId,
      matterId: args.matterId,
      source: args.readTime ? { readTime: args.readTime } : { database: args.fromDatabase as string },
      apply: args.apply,
      deleteExtra: args.deleteExtra,
      now: new Date(),
      log: (line) => console.log(line),
    });
  } finally {
    await close();
  }
}
