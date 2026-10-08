import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, type Firestore } from 'firebase-admin/firestore';

import * as D from '@materia/domain';

import { unwrap } from '../seed/interop.ts';

// Namespace import: the workspace lib loads as CommonJS under tsx, so named imports don't resolve.
const domain = unwrap(D);

/**
 * `materia-scripts backfill-search-tokens --project <id> [--dry-run] [--page-size <n>]` (CORE-15):
 * brings every `search` array up to the CORE-15 tokeniser (NFKD, prefixes 2–10, the matter number
 * in every form) and gives the documents and tasks written before CORE-15 theirs; gives each matter
 * its clients' display names, `clientNames`, which the Matters list shows (SEC-07d); stamps the
 * recent entries CORE-14 wrote with `kind: 'matter'` (Today's Recent matters reads by kind).
 * A destroyed matter's tombstone (CORE-19) is left as `matters-destroy` wrote it.
 *
 * It pages through each collection group in document-path order and writes only what differs, so
 * it is idempotent: a second run writes nothing, and a run stopped part-way can simply be run again.
 * It leaves `updatedAt` alone (recency ranks the results), and the triggers that maintain `search`
 * find nothing to change after it. Logs counts only, never names.
 */

type Data = Record<string, unknown>;

export interface BackfillDoc {
  /** The full path (`orgs/o1/matters/m1`). */
  path: string;
  data: Data;
}

/** What the backfill needs from Firestore, so a test can run it against a fake. */
export interface BackfillStore {
  /** Up to `limit` documents of a collection group, by path, after the path `after`. */
  page(group: string, after: string | null, limit: number): Promise<BackfillDoc[]>;
  /** The documents at these paths (null where missing). */
  getAll(paths: readonly string[]): Promise<(Data | null)[]>;
  /** Merges each patch into its document (one batch). */
  update(writes: readonly { path: string; patch: Data }[]): Promise<void>;
}

export interface BackfillCounts {
  read: number;
  updated: number;
}

export type BackfillReport = Record<'matters' | 'contacts' | 'tasks' | 'documents' | 'recent', BackfillCounts>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `orgs/{orgId}/…` → orgId. */
function orgOf(path: string): string | null {
  const [root, orgId] = path.split('/');
  return root === 'orgs' && orgId ? orgId : null;
}

/** A matter's tokens as `matters-denormalise` writes them (number, title, client and deceased names, external ref). */
export function matterTokens(matter: Data, names: ReadonlyMap<string, string>): string[] {
  const clients = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
  const deceased = (matter['deceased'] as { contactId?: string } | undefined)?.contactId;
  const deceasedName = deceased ? names.get(deceased) : undefined;
  const externalRef = text(matter['externalRef']);
  return domain.matterSearchTokens({
    number: text(matter['number']),
    title: text(matter['title']),
    clientNames: clients.map((id) => names.get(id)).filter((name): name is string => !!name),
    ...(deceasedName ? { deceasedName } : {}),
    ...(externalRef ? { externalRef } : {}),
  });
}

/** The contact ids a page of matters' tokens read: clients and the deceased. */
function contactIds(matter: Data): string[] {
  const clients = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
  const deceased = (matter['deceased'] as { contactId?: string } | undefined)?.contactId;
  return [...clients, ...(deceased ? [deceased] : [])];
}

async function contactNames(store: BackfillStore, matters: readonly BackfillDoc[]): Promise<Map<string, string>> {
  const paths = [
    ...new Set(
      matters.flatMap((doc) => {
        const orgId = orgOf(doc.path);
        return orgId ? contactIds(doc.data).map((id) => `orgs/${orgId}/contacts/${id}`) : [];
      }),
    ),
  ];
  const names = new Map<string, string>();
  if (!paths.length) return names;
  const rows = await store.getAll(paths);
  rows.forEach((row, i) => {
    const name = row ? domain.contactDisplayName(row as Partial<D.Contact>) : '';
    // Keyed by org and id: contact ids are only unique within an org.
    if (name) names.set(paths[i] as string, name);
  });
  return names;
}

/** What each collection group's documents should hold; null when nothing is due. */
type Planner = (page: readonly BackfillDoc[], store: BackfillStore) => Promise<(Data | null)[]>;

const PLANNERS: Record<keyof BackfillReport, Planner> = {
  matters: async (page, store) => {
    const live = page.filter((doc) => !doc.data['destroyedAt']);
    const names = await contactNames(store, live);
    return page.map((doc) => {
      const orgId = orgOf(doc.path);
      if (!orgId || doc.data['destroyedAt']) return null;
      const scoped = new Map(
        contactIds(doc.data).flatMap((id) => {
          const name = names.get(`orgs/${orgId}/contacts/${id}`);
          return name ? [[id, name] as const] : [];
        }),
      );
      const search = matterTokens(doc.data, scoped);
      const clientNames = domain.matterClientNames(doc.data['clientContactIds'], scoped);
      const patch = {
        ...(same(doc.data['search'], search) ? {} : { search }),
        ...(same(doc.data['clientNames'], clientNames) ? {} : { clientNames }),
      };
      return Object.keys(patch).length ? patch : null;
    });
  },
  contacts: async (page) =>
    page.map((doc) => {
      const search = domain.contactSearchTokens(doc.data as Partial<D.Contact>);
      return same(doc.data['search'], search) ? null : { search };
    }),
  tasks: async (page) =>
    page.map((doc) => {
      const search = domain.taskSearchTokens(text(doc.data['title']));
      return same(doc.data['search'], search) ? null : { search };
    }),
  documents: async (page) =>
    page.map((doc) => {
      // Only matter documents (`orgs/{o}/matters/{m}/documents/{d}`) carry search.
      if (doc.path.split('/').length !== 6) return null;
      const search = domain.documentSearchTokens(text(doc.data['name']));
      return same(doc.data['search'], search) ? null : { search };
    }),
  recent: async (page) => page.map((doc) => (doc.data['kind'] ? null : { kind: 'matter' })),
};

/** Runs the backfill over every collection group; with `dryRun`, counts what it would write. */
export async function backfillSearchTokens(
  store: BackfillStore,
  options: { pageSize?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<BackfillReport> {
  const pageSize = options.pageSize ?? 300;
  const report = {} as BackfillReport;
  for (const group of Object.keys(PLANNERS) as (keyof BackfillReport)[]) {
    const counts: BackfillCounts = { read: 0, updated: 0 };
    let after: string | null = null;
    for (;;) {
      const page = await store.page(group, after, pageSize);
      if (!page.length) break;
      const patches = await PLANNERS[group](page, store);
      const writes = page.flatMap((doc, i) => {
        const patch = patches[i];
        return patch ? [{ path: doc.path, patch }] : [];
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

/** The Admin SDK store: collection-group pages by document path, batched writes. */
export function adminStore(db: Firestore): BackfillStore {
  return {
    async page(group, after, limit) {
      let query = db.collectionGroup(group).orderBy(FieldPath.documentId()).limit(limit);
      if (after) query = query.startAfter(db.doc(after));
      const snap = await query.get();
      return snap.docs.map((doc) => ({ path: doc.ref.path, data: doc.data() }));
    },
    async getAll(paths) {
      const snaps = await db.getAll(...paths.map((path) => db.doc(path)));
      return snaps.map((snap) => (snap.exists ? (snap.data() as Data) : null));
    },
    async update(writes) {
      const batch = db.batch();
      for (const { path, patch } of writes) batch.update(db.doc(path), patch);
      await batch.commit();
    },
  };
}

export function parseArgs(
  argv: string[],
  command = 'backfill-search-tokens',
): { project: string; dryRun: boolean; pageSize: number } {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project') ?? process.env['GCLOUD_PROJECT'];
  if (!project) throw new Error(`Usage: materia-scripts ${command} --project <id> [--dry-run] [--page-size <n>]`);
  const pageSize = Number(value('page-size') ?? 300);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('--page-size is 1 to 500');
  return { project, dryRun: argv.includes('--dry-run'), pageSize };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, dryRun, pageSize } = parseArgs(argv);
  const app = initializeApp({ projectId: project }, `backfill-search-tokens-${Date.now()}`);
  try {
    await backfillSearchTokens(adminStore(getFirestore(app)), { dryRun, pageSize, log: (line) => console.log(line) });
  } finally {
    await deleteApp(app);
  }
}
