import type { Auth, UserRecord } from 'firebase-admin/auth';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';

/**
 * Test doubles for the orgs and contacts unit tests: an in-memory Firestore with just what that
 * code uses (doc and collection refs, `==`, `in` and `array-contains` filters on dotted paths,
 * field masks, collection groups, getAll, batches and serial transactions, `FieldValue.increment` and
 * `FieldValue.delete`),
 * and an Admin Auth with users and custom claims.
 */

type Data = Record<string, unknown>;

/** Dates are stored as Timestamps, as Firestore does; `FieldValue.increment` is applied. */
function stored(value: unknown, previous: unknown): unknown {
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (value && typeof value === 'object' && value.constructor?.name === 'NumericIncrementTransform') {
    return (typeof previous === 'number' ? previous : 0) + (value as { operand: number }).operand;
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

export function memoryFirestore(initial: Record<string, Data> = {}) {
  const docs = new Map<string, Data>();
  let autoId = 0;

  const snapshot = (path: string) => {
    const data = docs.get(path);
    const ref = docRef(path);
    return {
      id: ref.id,
      ref,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
      get: (field: string) => data?.[field],
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
    };
    return ref;
  }

  const write = {
    set(path: string, data: Data, options?: { merge?: boolean }) {
      docs.set(path, apply(options?.merge ? docs.get(path) : undefined, data));
    },
    update(path: string, data: Data) {
      if (!docs.has(path)) throw Object.assign(new Error(`No document to update: ${path}`), { code: 5 });
      docs.set(path, apply(docs.get(path), data));
    },
    create(path: string, data: Data) {
      if (docs.has(path)) throw Object.assign(new Error(`Already exists: ${path}`), { code: 6 });
      docs.set(path, apply(undefined, data));
    },
  };

  type Op = '==' | 'array-contains' | 'in';
  type Filter = [string, Op, unknown];
  /** A field by dotted path (`deceased.contactId`). */
  const valueAt = (data: Data | undefined, field: string): unknown =>
    field.split('.').reduce<unknown>((value, key) => (value as Data | undefined)?.[key], data);
  const matchesFilter = (data: Data | undefined, [field, op, value]: Filter) => {
    const actual = valueAt(data, field);
    if (op === 'array-contains') return Array.isArray(actual) && actual.includes(value);
    if (op === 'in') return (value as unknown[]).includes(actual);
    return actual === value;
  };
  function query(matches: (path: string) => boolean, filters: Filter[] = [], max = Infinity) {
    return {
      where: (field: string, op: Op, value: unknown) => query(matches, [...filters, [field, op, value]], max),
      limit: (n: number) => query(matches, filters, n),
      // Field masks don't change what the fakes return.
      select: () => query(matches, filters, max),
      get: async () => {
        const found = [...docs.keys()]
          .filter((path) => matches(path))
          .filter((path) => filters.every((filter) => matchesFilter(docs.get(path), filter)))
          .sort()
          .slice(0, max)
          .map(snapshot);
        return { docs: found, empty: found.length === 0, size: found.length };
      },
    };
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
  };
  return { auth: auth as unknown as Auth, records, revoked };
}
