import type { AuthPort, Doc, TargetDb, WriteFailure, WriteOp } from './target.ts';
import { provenanceOf, type Data } from './values.ts';

/** The collection a document path is in (its second-last segment). */
const collectionOf = (path: string) => path.split('/').at(-2);

/**
 * The v2 database in memory, for the load's tests: documents by path, the writes logged, and
 * paths that fail every write (`failOn`).
 */
export function memoryDb(initial: Record<string, Data> = {}) {
  const docs = new Map<string, Data>(Object.entries(initial).map(([path, data]) => [path, structuredClone(data)]));
  const writes: WriteOp[] = [];
  const failOn = new Set<string>();
  const snapshot = (path: string): Doc => ({ path, data: structuredClone(docs.get(path) as Data) });

  const db: TargetDb = {
    async getAll(paths) {
      return new Map(paths.filter((path) => docs.has(path)).map((path) => [path, snapshot(path).data]));
    },
    async apply(ops) {
      const failures: WriteFailure[] = [];
      for (const op of ops) {
        writes.push(op);
        if (failOn.has(op.path)) {
          failures.push({ path: op.path, message: 'made-up failure' });
          continue;
        }
        if (op.op === 'delete') docs.delete(op.path);
        else if (op.op === 'set') docs.set(op.path, structuredClone(op.data));
        else {
          const current = docs.get(op.path);
          if (!current) failures.push({ path: op.path, message: 'no document to update' });
          else docs.set(op.path, { ...current, ...structuredClone(op.data) });
        }
      }
      return failures;
    },
    async loadedBy(group, runId) {
      return [...docs.keys()]
        .filter((path) => collectionOf(path) === group && provenanceOf(docs.get(path))?.runId === runId)
        .sort()
        .map(snapshot);
    },
    async descendants(path) {
      return [...docs.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .sort()
        .map(snapshot);
    },
    async collection(path) {
      const depth = path.split('/').length + 1;
      return [...docs.keys()]
        .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === depth)
        .sort()
        .map(snapshot);
    },
  };

  return {
    db,
    docs,
    writes,
    failOn,
    get: (path: string) => docs.get(path),
    paths: (prefix = '') => [...docs.keys()].filter((path) => path.startsWith(prefix)).sort(),
  };
}

/** Auth accounts in memory: uid → custom claims. */
export function memoryAuth(accounts: Record<string, Record<string, unknown>> = {}) {
  const claims = new Map(Object.entries(accounts));
  const auth: AuthPort = {
    async claimsOf(uid) {
      return claims.has(uid) ? structuredClone(claims.get(uid) as Record<string, unknown>) : null;
    },
    async setClaims(uid, value) {
      if (!claims.has(uid)) throw new Error(`No account ${uid}`);
      claims.set(uid, structuredClone(value));
    },
  };
  return { auth, claims };
}
