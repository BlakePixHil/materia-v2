/**
 * Reading and comparing a document subtree (a matter and everything under it) for the restore
 * tooling (SEC-03). The reader is an interface so tests run on an in-memory fake; `firestore.ts`
 * has the Admin SDK versions (a live or restored database, or a PITR read time).
 */

export type Data = Record<string, unknown>;

export interface SubtreeReader {
  /** The document's data, or null when it doesn't exist. */
  get(path: string): Promise<Data | null>;
  /** The collection ids directly under a document. */
  collections(docPath: string): Promise<string[]>;
  /** The documents of a collection; `data` is null for a missing document that only has subcollections. */
  documents(collectionPath: string): Promise<{ path: string; data: Data | null }[]>;
}

/**
 * Every document under `rootPath`, the root included, by path. Missing documents that only hold
 * subcollections are walked through but left out.
 */
export async function readSubtree(reader: SubtreeReader, rootPath: string): Promise<Map<string, Data>> {
  const docs = new Map<string, Data>();
  const root = await reader.get(rootPath);
  if (root) docs.set(rootPath, root);
  const visit = async (docPath: string): Promise<void> => {
    for (const id of await reader.collections(docPath)) {
      for (const doc of await reader.documents(`${docPath}/${id}`)) {
        if (doc.data) docs.set(doc.path, doc.data);
        await visit(doc.path);
      }
    }
  };
  await visit(rootPath);
  return docs;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A plain, key-sorted form of a Firestore value, so two documents read from different databases
 * compare equal when their contents are: timestamps by seconds and nanoseconds, references by path,
 * vectors by their numbers, bytes as base64.
 */
export function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  const v = value as Record<string, unknown>;
  if (typeof v['toDate'] === 'function' && typeof v['seconds'] === 'number')
    return { $ts: `${String(v['seconds'])}.${String(v['nanoseconds'])}` };
  if (typeof v['path'] === 'string' && typeof v['id'] === 'string' && 'firestore' in v) return { $ref: v['path'] };
  if (typeof v['toArray'] === 'function') return { $vector: (v['toArray'] as () => number[]).call(v) };
  if (typeof v['latitude'] === 'number' && typeof v['longitude'] === 'number' && typeof v['isEqual'] === 'function')
    return { $geo: [v['latitude'], v['longitude']] };
  if (!isRecord(v)) return String(value);
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((key) => [key, canonical(v[key])]),
  );
}

export const sameData = (a: Data, b: Data) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export interface SubtreeDiff {
  /** In the source, not in the target. */
  create: string[];
  /** In both, with different data. */
  overwrite: string[];
  unchanged: string[];
  /** In the target only (written after the restore point). */
  extra: string[];
}

export function diffSubtrees(source: ReadonlyMap<string, Data>, target: ReadonlyMap<string, Data>): SubtreeDiff {
  const diff: SubtreeDiff = { create: [], overwrite: [], unchanged: [], extra: [] };
  for (const [path, data] of source) {
    const current = target.get(path);
    if (!current) diff.create.push(path);
    else if (sameData(data, current)) diff.unchanged.push(path);
    else diff.overwrite.push(path);
  }
  for (const path of target.keys()) if (!source.has(path)) diff.extra.push(path);
  for (const list of Object.values(diff) as string[][]) list.sort();
  return diff;
}

/** Counts by collection id (`orgs/o/matters/m/tasks/t` → `tasks`; the root counts as its own collection). */
export function countByCollection(paths: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of paths) {
    const collection = path.split('/').at(-2) ?? '';
    counts[collection] = (counts[collection] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
