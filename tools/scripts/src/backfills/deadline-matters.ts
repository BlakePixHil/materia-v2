import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import * as D from '@materia/domain';

import { adminStore, type BackfillCounts, type BackfillDoc, type BackfillStore } from './search-tokens.ts';
import { unwrap } from '../seed/interop.ts';

// Namespace import: the workspace lib loads as CommonJS under tsx, so named imports don't resolve.
const domain = unwrap(D);

/**
 * `materia-scripts backfill-deadline-matters --project <id> [--dry-run] [--page-size <n>]`
 * (SEC-07c): gives every live deadline written before SEC-07c a copy of its matter's number, title,
 * people and jurisdiction (`Deadline.matter`), which the Deadlines screen names and filters its rows
 * by. Until it runs, the screen reads those deadlines' matters one by one, as it did before.
 *
 * It pages through the `deadlines` collection group in document-path order and writes only copies
 * that are missing or differ, so it is idempotent: a second run writes nothing, and a run stopped
 * part-way can simply be run again. Soft-deleted deadlines, and deadlines whose matter is missing or
 * destroyed, are left alone. Leaves `updatedAt` alone. Logs counts only.
 *
 * No `--down`: the previous code ignores the field.
 */

type Data = Record<string, unknown>;

/** `orgs/{orgId}/matters/{matterId}/deadlines/{id}` → the matter's path; null for anything else. */
function matterPathOf(path: string): string | null {
  const parts = path.split('/');
  return parts.length === 6 && parts[0] === 'orgs' && parts[2] === 'matters' && parts[4] === 'deadlines'
    ? parts.slice(0, 4).join('/')
    : null;
}

/** Runs the backfill; with `dryRun`, counts what it would write. */
export async function backfillDeadlineMatters(
  store: BackfillStore,
  options: { pageSize?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<BackfillCounts> {
  const pageSize = options.pageSize ?? 300;
  const counts: BackfillCounts = { read: 0, updated: 0 };
  let after: string | null = null;
  for (;;) {
    const page: BackfillDoc[] = await store.page('deadlines', after, pageSize);
    if (!page.length) break;
    const records = page.flatMap((doc) => {
      const matter = matterPathOf(doc.path);
      return matter && (doc.data['deletedAt'] ?? null) === null ? [{ doc, matter }] : [];
    });
    const matterPaths = [...new Set(records.map((record) => record.matter))];
    const matters = matterPaths.length ? await store.getAll(matterPaths) : [];
    const copies = new Map(matterPaths.map((path, i) => [path, copyOf(matters[i] ?? null)]));
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
  options.log?.(`deadlines: ${counts.read} read, ${counts.updated} ${options.dryRun ? 'to update' : 'updated'}`);
  return counts;
}

/** A matter's copy; none for a missing matter or a destroyed one's tombstone (CORE-19). */
function copyOf(matter: Data | null): D.DeadlineMatterCopy | null {
  return matter && !matter['destroyedAt'] ? domain.deadlineMatterCopy(matter) : null;
}

export function parseArgs(argv: string[]): { project: string; dryRun: boolean; pageSize: number } {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project') ?? process.env['GCLOUD_PROJECT'];
  if (!project)
    throw new Error('Usage: materia-scripts backfill-deadline-matters --project <id> [--dry-run] [--page-size <n>]');
  const pageSize = Number(value('page-size') ?? 300);
  // Each page's writes go in one batch, and a batch holds at most 500.
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('--page-size is 1 to 500');
  return { project, dryRun: argv.includes('--dry-run'), pageSize };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, dryRun, pageSize } = parseArgs(argv);
  const app = initializeApp({ projectId: project }, `backfill-deadline-matters-${Date.now()}`);
  try {
    await backfillDeadlineMatters(adminStore(getFirestore(app)), {
      dryRun,
      pageSize,
      log: (line) => console.log(line),
    });
  } finally {
    await deleteApp(app);
  }
}
