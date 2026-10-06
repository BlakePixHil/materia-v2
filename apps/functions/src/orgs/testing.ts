import type { Auth, UserRecord } from 'firebase-admin/auth';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';

/**
 * Test doubles for the orgs and contacts unit tests: an in-memory Firestore with just what that
 * code uses (doc and collection refs, `==`, `in`, `array-contains` and range filters on dotted paths,
 * paging by document id,
 * field masks, collection groups, getAll, batches and serial transactions, `FieldValue.increment`,
 * `FieldValue.delete` and `FieldValue.vector` with `findNearest`, and document listeners),
 * and an Admin Auth with users and custom claims.
 */

type Data = Record<string, unknown>;

/** Dates are stored as Timestamps, as Firestore does; `FieldValue.increment` and `arrayUnion` are applied. */
function stored(value: unknown, previous: unknown): unknown {
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (value && typeof value === 'object' && value.constructor?.name === 'VectorValue') return value;
  if (value && typeof value === 'object' && value.constructor?.name === 'NumericIncrementTransform') {
    return (typeof previous === 'number' ? previous : 0) + (value as { operand: number }).operand;
  }
  if (value && typeof value === 'object' && value.constructor?.name === 'ArrayUnionTransform') {
    const items = (value as unknown as { elements: unknown[] }).elements.map((item) => stored(item, undefined));
    return [...(Array.isArray(previous) ? previous : []), ...items];
  }
  if (Array.isArray(value)) return value.map((item) => stored(item, undefined));
  if (value && typeof value === 'object' && !(value instanceof Timestamp)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stored(v, undefined)]));
  }
  return value;
}

const isDeleteSentinel = (value: unknown) =>
  !!value && typeof value === 'object' && value.constructor?.name === 'DeleteTransform';

function apply(previous: Data | undefined, data: Data): Data {
  const next: Data = { ...previous };
  for (const [key, value] of Object.entries(data)) {
    next[key] = isDeleteSentinel(value) ? value : stored(value, previous?.[key]);
  }
  return Object.fromEntries(Object.entries(next).filter(([, value]) => !isDeleteSentinel(value)));
}

function distance(a: number[], b: number[], measure: 'COSINE' | 'EUCLIDEAN' | 'DOT_PRODUCT'): number {
  const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
  if (measure === 'DOT_PRODUCT') return -dot;
  if (measure === 'EUCLIDEAN') return Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)));
  return 1 - dot / (Math.hypot(...a) * Math.hypot(...b) || 1);
}

export function memoryFirestore(initial: Record<string, Data> = {}) {
  const docs = new Map<string, Data>();
  let autoId = 0;
  /** Document listeners (`onSnapshot`), called with the current snapshot and after each write. */
  const listeners = new Map<string, Set<(snap: unknown) => void>>();
  const notify = (path: string) => {
    for (const listener of listeners.get(path) ?? []) listener(snapshot(path));
  };

  const snapshot = (path: string) => {
    const data = docs.get(path);
    const ref = docRef(path);
    return {
      id: ref.id,
      ref,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
      // A dotted path reads into maps, as Firestore's `get('prefs.notifications')` does.
      get: (field: string) => valueAt(data, field),
    };
  };

  function docRef(path: string) {
    const parts = path.split('/');
    const id = parts.at(-1) as string;
    const collectionPath = parts.slice(0, -1).join('/');
    const ref = {
      id,
      path,
      get parent(): unknown {
        return collectionRef(collectionPath);
      },
      get: async () => snapshot(path),
      set: async (data: Data, options?: { merge?: boolean }) => write.set(path, data, options),
      update: async (data: Data) => write.update(path, data),
      create: async (data: Data) => write.create(path, data),
      delete: async () => void docs.delete(path),
      collection: (name: string) => collectionRef(`${path}/${name}`),
      onSnapshot: (next: (snap: unknown) => void) => {
        const set = listeners.get(path) ?? new Set();
        listeners.set(path, set.add(next));
        queueMicrotask(() => set.has(next) && next(snapshot(path)));
        return () => void set.delete(next);
      },
    };
    return ref;
  }

  const write = {
    set(path: string, data: Data, options?: { merge?: boolean }) {
      docs.set(path, apply(options?.merge ? docs.get(path) : undefined, data));
      notify(path);
    },
    update(path: string, data: Data) {
      if (!docs.has(path)) throw Object.assign(new Error(`No document to update: ${path}`), { code: 5 });
      const previous = docs.get(path) as Data;
      // `update` reads a dotted key as a field path into maps (`deceased.dateOfDeath`, `settings.clerk.model`).
      const setPath = (target: Data, keys: string[], value: unknown): Data => {
        const [head, ...rest] = keys as [string, ...string[]];
        if (!rest.length) return apply(target, { [head]: value });
        return { ...target, [head]: setPath((target[head] ?? {}) as Data, rest, value) };
      };
      let next: Data = previous;
      for (const [key, value] of Object.entries(data)) next = setPath(next, key.split('.'), value);
      docs.set(path, next);
      notify(path);
    },
    create(path: string, data: Data) {
      if (docs.has(path)) throw Object.assign(new Error(`Already exists: ${path}`), { code: 6 });
      docs.set(path, apply(undefined, data));
      notify(path);
    },
  };

  type Op = '==' | '!=' | 'array-contains' | 'in' | '<' | '<=' | '>' | '>=';
  type Filter = [string, Op, unknown];
  /** A field by dotted path (`deceased.contactId`). */
  const valueAt = (data: Data | undefined, field: string): unknown =>
    field.split('.').reduce<unknown>((value, key) => (value as Data | undefined)?.[key], data);
  const matchesFilter = (data: Data | undefined, [field, op, value]: Filter) => {
    const actual = valueAt(data, field);
    if (op === 'array-contains') return Array.isArray(actual) && actual.includes(value);
    if (op === 'in') return (value as unknown[]).includes(actual);
    if (op === '==') return actual === value;
    // As in Firestore, `!=` never matches a document without the field.
    if (op === '!=') return actual !== undefined && actual !== value;
    // Range filters compare strings, numbers or instants (date-only strings sort as dates); a
    // missing field never matches.
    if (actual === undefined || actual === null) return false;
    const comparable = (v: unknown) =>
      v instanceof Timestamp ? v.toMillis() : v instanceof Date ? v.getTime() : (v as string | number);
    const a = comparable(actual);
    const b = comparable(value);
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  };
  function query(matches: (path: string) => boolean, filters: Filter[] = [], max = Infinity, after?: string) {
    return {
      where: (field: string, op: Op, value: unknown) => query(matches, [...filters, [field, op, value]], max, after),
      limit: (n: number) => query(matches, filters, n, after),
      // Field masks don't change what the fakes return; results are always in document-path order.
      select: () => query(matches, filters, max, after),
      orderBy: () => query(matches, filters, max, after),
      /** Pages by document id (with `orderBy(FieldPath.documentId())`). */
      startAfter: (id: string) => query(matches, filters, max, id),
      get: async () => {
        const found = select().map(snapshot);
        return { docs: found, empty: found.length === 0, size: found.length };
      },
      /** A count aggregation (`query.count().get()`). */
      count: () => ({ get: async () => ({ data: () => ({ count: select().length }) }) }),
      /** `count` and `sum` aggregations (`query.aggregate({ total: AggregateField.sum('amountCents') })`). */
      aggregate: (spec: Record<string, { aggregateType: string; _field?: string }>) => ({
        get: async () => {
          const found = select();
          const result: Record<string, number> = {};
          for (const [name, field] of Object.entries(spec)) {
            if (field.aggregateType === 'count') result[name] = found.length;
            else {
              const values = found
                .map((path) => valueAt(docs.get(path), String(field._field)))
                .filter((value): value is number => typeof value === 'number');
              const total = values.reduce((sum, value) => sum + value, 0);
              result[name] = field.aggregateType === 'avg' ? (values.length ? total / values.length : NaN) : total;
            }
          }
          return { data: () => result };
        },
      }),
      /** Vector search (`findNearest`), COSINE or EUCLIDEAN, with the distance in `distanceResultField`. */
      findNearest: (options: {
        vectorField: string;
        queryVector: { toArray(): number[] };
        limit: number;
        distanceMeasure: 'COSINE' | 'EUCLIDEAN' | 'DOT_PRODUCT';
        distanceResultField?: string;
      }) => ({
        get: async () => {
          const target = options.queryVector.toArray();
          const scored = select()
            .map((path) => {
              const vector = valueAt(docs.get(path), options.vectorField) as { toArray?: () => number[] } | undefined;
              return vector?.toArray
                ? { path, distance: distance(vector.toArray(), target, options.distanceMeasure) }
                : null;
            })
            .filter((entry): entry is { path: string; distance: number } => entry !== null)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, options.limit);
          const found = scored.map(({ path, distance: d }) => {
            const snap = snapshot(path);
            const field = options.distanceResultField;
            return field ? { ...snap, data: () => ({ ...snap.data(), [field]: d }) } : snap;
          });
          return { docs: found, empty: found.length === 0, size: found.length };
        },
      }),
    };
    function select() {
      return [...docs.keys()]
        .filter((path) => matches(path))
        .filter((path) => after === undefined || (path.split('/').at(-1) as string) > after)
        .filter((path) => filters.every((filter) => matchesFilter(docs.get(path), filter)))
        .sort()
        .slice(0, max);
    }
  }

  function collectionRef(path: string): Record<string, unknown> {
    const depth = path.split('/').length + 1;
    const inCollection = (doc: string) => doc.startsWith(`${path}/`) && doc.split('/').length === depth;
    const parts = path.split('/');
    return {
      id: parts.at(-1) as string,
      path,
      get parent(): unknown {
        return parts.length > 1 ? docRef(parts.slice(0, -1).join('/')) : null;
      },
      doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++autoId}`}`),
      add: async (data: Data) => {
        const ref = docRef(`${path}/auto-${++autoId}`);
        write.create(ref.path, data);
        return ref;
      },
      ...query(inCollection),
    };
  }

  type Ref = { path: string };
  type Query = { get: () => Promise<unknown> };
  const db = {
    doc: docRef,
    collection: collectionRef,
    collectionGroup: (name: string) => query((path) => path.split('/').at(-2) === name),
    getAll: async (...refs: Ref[]) => refs.map((ref) => snapshot(ref.path)),
    batch: () => {
      const ops: (() => void)[] = [];
      const batch = {
        create: (ref: Ref, data: Data) => (ops.push(() => write.create(ref.path, data)), batch),
        set: (ref: Ref, data: Data, options?: { merge?: boolean }) => (
          ops.push(() => write.set(ref.path, data, options)),
          batch
        ),
        update: (ref: Ref, data: Data) => (ops.push(() => write.update(ref.path, data)), batch),
        delete: (ref: Ref) => (ops.push(() => void docs.delete(ref.path)), batch),
        commit: async () => {
          for (const op of ops) op();
        },
      };
      return batch;
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const ops: (() => void)[] = [];
      const tx = {
        get: async (target: Ref | Query) =>
          'where' in target || !('path' in target) ? (target as Query).get() : snapshot(target.path),
        getAll: async (...refs: Ref[]) => refs.map((ref) => snapshot(ref.path)),
        create: (ref: Ref, data: Data) => void ops.push(() => write.create(ref.path, data)),
        set: (ref: Ref, data: Data, options?: { merge?: boolean }) =>
          void ops.push(() => write.set(ref.path, data, options)),
        update: (ref: Ref, data: Data) => void ops.push(() => write.update(ref.path, data)),
        delete: (ref: Ref) => void ops.push(() => void docs.delete(ref.path)),
      };
      const result = await fn(tx);
      for (const op of ops) op();
      return result;
    },
  };

  for (const [path, data] of Object.entries(initial)) write.set(path, data);
  return { db: db as unknown as Firestore, docs };
}

export interface FakeUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  customClaims?: Record<string, unknown>;
  /** As Auth reports them (CORE-21's team table). */
  multiFactor?: { enrolledFactors: unknown[] };
  metadata?: { lastSignInTime?: string; lastRefreshTime?: string };
}

/** Admin Auth with a few users: lookups, custom claims and refresh-token revocation. */
export function memoryAuth(users: FakeUser[] = []) {
  const records = new Map(users.map((user) => [user.uid, { emailVerified: true, ...user }]));
  const revoked: string[] = [];
  const notFound = () => Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
  const auth = {
    getUser: async (uid: string) => {
      const user = records.get(uid);
      if (!user) throw notFound();
      return user as unknown as UserRecord;
    },
    getUserByEmail: async (email: string) => {
      const user = [...records.values()].find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (!user) throw notFound();
      return user as unknown as UserRecord;
    },
    setCustomUserClaims: async (uid: string, claims: Record<string, unknown> | null) => {
      const user = records.get(uid);
      if (!user) throw notFound();
      user.customClaims = claims ?? {};
    },
    revokeRefreshTokens: async (uid: string) => void revoked.push(uid),
    getUsers: async (ids: { uid: string }[]) => ({
      users: ids.flatMap(({ uid }) => {
        const user = records.get(uid);
        return user ? [{ metadata: {}, ...user } as unknown as UserRecord] : [];
      }),
      notFound: ids.filter(({ uid }) => !records.has(uid)),
    }),
  };
  return { auth: auth as unknown as Auth, records, revoked };
}
