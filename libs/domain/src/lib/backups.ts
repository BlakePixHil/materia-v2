/**
 * Backups (SEC-03, SEC-07h): which collections the nightly Firestore export takes, and the walk that
 * finds a database's collection ids. The export (`backups-exportFirestore`) and the restore drill
 * (`materia-scripts backup-drill`) share both.
 */

/**
 * Collection groups the nightly export leaves out (SEC-07h): Clerk's search chunks
 * (`documents/{id}/chunks`), which carry 768-dimension vectors and are most of the database's bytes
 * once documents are ingested, and are rebuilt from the documents after a restore
 * (`materia-scripts backfill-ingest --rechunk`). PITR and the managed backups still hold them.
 */
export const EXPORT_SKIPPED_COLLECTIONS: readonly string[] = ['chunks'];

/**
 * Every collection id that has a `match` block in firestore.rules (the rules suite checks the two
 * agree). The export takes these whether or not the walk finds them, since the walk only samples:
 * a subcollection that few documents have could be missed, and an export must never miss one.
 */
export const FIRESTORE_COLLECTION_IDS: readonly string[] = [
  'activity', 'assets', 'audit', 'briefs', 'byMember', 'calendars', 'checklistTemplates',
  'chronology', 'chunks', 'clerkDrafts', 'clerkThreads', 'conflictChecks', 'connectorConnections',
  'connectorGrants', 'contacts', 'counters', 'courtBooks', 'courtEvents', 'creditNotes',
  'deadlineChanges', 'deadlines', 'deletedOrgs', 'destructionCertificates', 'destructionQueue',
  'devices', 'digests', 'disbursements', 'distributions', 'docTemplates', 'documentHashes',
  'documents', 'drafts', 'events', 'evidence', 'factCitations', 'insightsNarratives',
  'integrationStates', 'integrationStatus', 'integrations', 'invites', 'invoiceReminders',
  'invoices', 'issues', 'jobs', 'liabilities', 'matterNumbers', 'matters', 'members', 'messages',
  'metrics', 'migrationEnrichments', 'migrations', 'notes', 'notifications', 'offers', 'orders',
  'orgs', 'parties', 'private', 'proceedings', 'recent', 'revisions', 'ruleSets', 'safeCustody',
  'settings', 'shards', 'signIns', 'subpoenas', 'suggestions', 'systemTemplates',
  'taskGroupTemplates', 'tasks', 'templates', 'timeEntries', 'timer', 'trustSnapshots', 'users',
  'versions', 'views', 'xeroContacts',
]; // prettier-ignore

/**
 * The collection ids the export takes: every known one and every one the walk found, less the
 * skipped ones, sorted and unique.
 */
export function exportedCollectionIds(found: readonly string[]): string[] {
  return [...new Set([...FIRESTORE_COLLECTION_IDS, ...found])]
    .filter((id) => !EXPORT_SKIPPED_COLLECTIONS.includes(id))
    .sort();
}

/** A collection as the walk sees it: its id and path, and a sample of its documents. */
export interface WalkCollection {
  id: string;
  path: string;
  sample(limit: number): Promise<{ listCollections(): Promise<WalkCollection[]> }[]>;
}

// orgs/a/matters/b/tasks has the shape orgs/{}/matters/{}/tasks: collections that share a shape.
const shape = (path: string) =>
  path
    .split('/')
    .map((part, index) => (index % 2 ? '{}' : part))
    .join('/');

/**
 * Every collection id under `roots`, found by walking: documents are probed for subcollections, up
 * to `perShape` documents across all collections of the same shape (every matter's tasks share
 * one budget), so the walk is bounded by the schema rather than the data. Materia's collections
 * are uniform, so a sample finds them all. Runs `concurrency` probes at a time.
 */
export async function walkCollectionIds(
  roots: WalkCollection[],
  { perShape = 100, perCollection = 20, concurrency = 16 } = {},
): Promise<string[]> {
  const ids = new Set<string>();
  const budget = new Map<string, number>();
  const queue = [...roots];
  let active = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (!queue.length && !active) return resolve([...ids].sort());
      while (active < concurrency && queue.length) {
        const collection = queue.shift() as WalkCollection;
        ids.add(collection.id);
        const key = shape(collection.path);
        const left = budget.get(key) ?? perShape;
        const take = Math.min(left, perCollection);
        if (take <= 0) continue;
        budget.set(key, left - take);
        active++;
        collection
          .sample(take)
          .then((docs) => Promise.all(docs.map((doc) => doc.listCollections())))
          .then((children) => {
            queue.push(...children.flat());
            active--;
            next();
          }, reject);
      }
      if (!queue.length && !active) resolve([...ids].sort());
    };
    next();
  });
}
