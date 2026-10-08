import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import * as D from '@materia/domain';

import { adminStore, type BackfillCounts, type BackfillDoc, type BackfillStore } from './search-tokens.ts';
import { unwrap } from '../seed/interop.ts';

// Namespace import: the workspace lib loads as CommonJS under tsx, so named imports don't resolve.
const domain = unwrap(D);

/**
 * `materia-scripts backfill-matter-copies --project <id> [--dry-run] [--page-size <n>]`
 * (SEC-07c, SEC-07e): gives every record that carries a copy of its matter one that is current:
 *
 * - live deadlines and pending proposals: number, title, type, people and jurisdiction
 *   (`Deadline.matter`, `DeadlineChange.matter`), which the Deadlines and Today screens show;
 * - live matter tasks: number, title and type, or only that the matter is privileged
 *   (`Task.matter`), for Today;
 * - recent matters (`users/{uid}/recent`): number, title, type and the privileged flag
 *   (`RecentMatter.matter`), for Today's Recent matters.
 *
 * Each also says whether the matter is deleted. Until it runs, those screens read the matters of
 * older records one by one, as they did before.
 *
 * It pages through each collection group in document-path order and writes only copies that are
 * missing or differ, so it is idempotent: a second run writes nothing, and a run stopped part-way
 * can simply be run again. Soft-deleted records, and records whose matter is missing or destroyed,
 * are left alone. Leaves `updatedAt` alone. Logs counts only.
 *
 * No `--down`: the previous code ignores the field.
 */

type Data = Record<string, unknown>;

/** One collection group and how its records name their matter and copy it. */
interface CopyTarget {
  group: 'deadlines' | 'deadlineChanges' | 'tasks' | 'recent';
  /** The record's matter path, or null to leave it alone. */
  matterOf(doc: BackfillDoc): string | null;
  copy(matter: Data): object | null;
}

const isLive = (data: Data) => (data['deletedAt'] ?? null) === null;

/** `orgs/{orgId}/matters/{matterId}/{group}/{id}` → the matter's path; null for anything else. */
function matterPathOf(path: string, group: string): string | null {
  const parts = path.split('/');
  return parts.length === 6 && parts[0] === 'orgs' && parts[2] === 'matters' && parts[4] === group
    ? parts.slice(0, 4).join('/')
    : null;
}

const TARGETS: readonly CopyTarget[] = [
  {
    group: 'deadlines',
    matterOf: (doc) => (isLive(doc.data) ? matterPathOf(doc.path, 'deadlines') : null),
    copy: (matter) => domain.deadlineMatterCopy(matter),
  },
  {
    group: 'deadlineChanges',
    matterOf: (doc) => (doc.data['status'] === 'pending' ? matterPathOf(doc.path, 'deadlineChanges') : null),
    copy: (matter) => domain.deadlineMatterCopy(matter),
  },
  {
    // Personal tasks (`orgs/{orgId}/members/{uid}/tasks`) have no matter.
    group: 'tasks',
    matterOf: (doc) => (isLive(doc.data) ? matterPathOf(doc.path, 'tasks') : null),
    copy: (matter) => domain.taskMatterCopy(matter),
  },
  {
    // `users/{uid}/recent/{id}`: a matter's own entry (no `kind` before CORE-15) names it.
    group: 'recent',
    matterOf: ({ path, data }) => {
      const { orgId, matterId } = data;
      return path.startsWith('users/') &&
        (data['kind'] ?? 'matter') === 'matter' &&
        typeof orgId === 'string' &&
        orgId &&
        typeof matterId === 'string' &&
        matterId
        ? `orgs/${orgId}/matters/${matterId}`
        : null;
    },
    copy: (matter) => domain.recentMatterCopy(matter),
  },
];

export type MatterCopiesReport = Record<CopyTarget['group'], BackfillCounts>;

/** Runs the backfill; with `dryRun`, counts what it would write. */
export async function backfillMatterCopies(
  store: BackfillStore,
  options: { pageSize?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<MatterCopiesReport> {
  const report = {} as MatterCopiesReport;
  for (const target of TARGETS) {
    report[target.group] = await backfillGroup(store, target, options);
    const { read, updated } = report[target.group];
    options.log?.(`${target.group}: ${read} read, ${updated} ${options.dryRun ? 'to update' : 'updated'}`);
  }
  return report;
}

async function backfillGroup(
  store: BackfillStore,
  target: CopyTarget,
  options: { pageSize?: number; dryRun?: boolean },
): Promise<BackfillCounts> {
  const pageSize = options.pageSize ?? 300;
  const counts: BackfillCounts = { read: 0, updated: 0 };
  let after: string | null = null;
  for (;;) {
    const page: BackfillDoc[] = await store.page(target.group, after, pageSize);
    if (!page.length) break;
    const records = page.flatMap((doc) => {
      const matter = target.matterOf(doc);
      return matter ? [{ doc, matter }] : [];
    });
    const matterPaths = [...new Set(records.map((record) => record.matter))];
    const matters = matterPaths.length ? await store.getAll(matterPaths) : [];
    // None for a missing matter or a destroyed one's tombstone (CORE-19).
    const copies = new Map(
      matterPaths.map((path, i) => {
        const matter = matters[i] ?? null;
        return [path, matter && !matter['destroyedAt'] ? target.copy(matter) : null] as const;
      }),
    );
    const writes = records.flatMap(({ doc, matter }) => {
      const copy = copies.get(matter) ?? null;
      return copy && !domain.matterCopyIsCurrent(doc.data['matter'], copy)
        ? [{ path: doc.path, patch: { matter: copy } }]
        : [];
    });
    if (writes.length && !options.dryRun) await store.update(writes);
    counts.read += page.length;
    counts.updated += writes.length;
    after = page[page.length - 1]?.path ?? null;
    if (page.length < pageSize) break;
  }
  return counts;
}

export function parseArgs(argv: string[]): { project: string; dryRun: boolean; pageSize: number } {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project') ?? process.env['GCLOUD_PROJECT'];
  if (!project)
    throw new Error('Usage: materia-scripts backfill-matter-copies --project <id> [--dry-run] [--page-size <n>]');
  const pageSize = Number(value('page-size') ?? 300);
  // Each page's writes go in one batch, and a batch holds at most 500.
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('--page-size is 1 to 500');
  return { project, dryRun: argv.includes('--dry-run'), pageSize };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, dryRun, pageSize } = parseArgs(argv);
  const app = initializeApp({ projectId: project }, `backfill-matter-copies-${Date.now()}`);
  try {
    await backfillMatterCopies(adminStore(getFirestore(app)), {
      dryRun,
      pageSize,
      log: (line) => console.log(line),
    });
  } finally {
    await deleteApp(app);
  }
}
