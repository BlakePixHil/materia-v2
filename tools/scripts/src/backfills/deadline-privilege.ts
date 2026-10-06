import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { adminStore, type BackfillCounts, type BackfillDoc, type BackfillStore } from './search-tokens.ts';

/**
 * `materia-scripts backfill-deadline-privilege --project <id> [--dry-run] [--page-size <n>]`
 * (CORE-10b): gives every matter event, deadline and deadline proposal written before CORE-10b a
 * copy of its matter's `privileged` flag, which the rules read in cross-matter queries. Until it
 * runs, roles without `privileged.view` don't see those deadlines on the Deadlines screen or Today
 * (their queries ask for `privileged == false`); privileged.view roles see them either way.
 *
 * It pages through each collection group in document-path order and writes only what differs, so
 * it is idempotent: a second run writes nothing, and a run stopped part-way can simply be run again.
 * A record whose matter is missing is marked privileged (hidden rather than shown). Leaves
 * `updatedAt` alone. Logs counts only.
 *
 * No `--down`: the previous rules ignore the field, so a rollback needs nothing undone, and removing
 * it would hide the records from roles without privileged.view.
 */

type Data = Record<string, unknown>;

export const PRIVILEGE_GROUPS = ['events', 'deadlines', 'deadlineChanges'] as const;
export type DeadlinePrivilegeReport = Record<(typeof PRIVILEGE_GROUPS)[number], BackfillCounts>;

/** `orgs/{orgId}/matters/{matterId}/{group}/{id}` → the matter's path; null for anything else. */
function matterPathOf(path: string): string | null {
  const parts = path.split('/');
  return parts.length === 6 && parts[0] === 'orgs' && parts[2] === 'matters' ? parts.slice(0, 4).join('/') : null;
}

/** Runs the backfill over the three collection groups; with `dryRun`, counts what it would write. */
export async function backfillDeadlinePrivilege(
  store: BackfillStore,
  options: { pageSize?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<DeadlinePrivilegeReport> {
  const pageSize = options.pageSize ?? 300;
  const report = {} as DeadlinePrivilegeReport;
  for (const group of PRIVILEGE_GROUPS) {
    const counts: BackfillCounts = { read: 0, updated: 0 };
    let after: string | null = null;
    for (;;) {
      const page: BackfillDoc[] = await store.page(group, after, pageSize);
      if (!page.length) break;
      const records = page.flatMap((doc) => {
        const matter = matterPathOf(doc.path);
        return matter ? [{ doc, matter }] : [];
      });
      const matterPaths = [...new Set(records.map((record) => record.matter))];
      const matters = matterPaths.length ? await store.getAll(matterPaths) : [];
      const flags = new Map(matterPaths.map((path, i) => [path, flagOf(matters[i] ?? null)]));
      const writes = records.flatMap(({ doc, matter }) => {
        const privileged = flags.get(matter) ?? true;
        return doc.data['privileged'] === privileged ? [] : [{ path: doc.path, patch: { privileged } }];
      });
      if (writes.length && !options.dryRun) await store.update(writes);
      counts.read += page.length;
      counts.updated += writes.length;
      after = page[page.length - 1]?.path ?? null;
      if (page.length < pageSize) break;
    }
    report[group] = counts;
    options.log?.(`${group}: ${counts.read} read, ${counts.updated} ${options.dryRun ? 'to update' : 'updated'}`);
  }
  return report;
}

/** A matter's flag; a missing matter counts as privileged. */
function flagOf(matter: Data | null): boolean {
  return matter === null || matter['privileged'] === true;
}

export function parseArgs(argv: string[]): { project: string; dryRun: boolean; pageSize: number } {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project') ?? process.env['GCLOUD_PROJECT'];
  if (!project)
    throw new Error('Usage: materia-scripts backfill-deadline-privilege --project <id> [--dry-run] [--page-size <n>]');
  const pageSize = Number(value('page-size') ?? 300);
  // Each page's writes go in one batch, and a batch holds at most 500.
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('--page-size is 1 to 500');
  return { project, dryRun: argv.includes('--dry-run'), pageSize };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, dryRun, pageSize } = parseArgs(argv);
  const app = initializeApp({ projectId: project }, `backfill-deadline-privilege-${Date.now()}`);
  try {
    await backfillDeadlinePrivilege(adminStore(getFirestore(app)), {
      dryRun,
      pageSize,
      log: (line) => console.log(line),
    });
  } finally {
    await deleteApp(app);
  }
}
