import type { Provider } from '@angular/core';

import { FIRESTORE_DRIVER } from '../firestore/firestore-driver';
import type { CollectionDriver, DriverFactory, PageRequest, QuerySpec, RawDoc, RawPage, WhereOp } from '../query';

type Data = Record<string, unknown>;

interface Cursor {
  id: string;
  data: Data;
}

interface Listener {
  path: string;
  run: () => void;
  fail: (error: unknown) => void;
}

function field(data: Data, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Data | undefined)?.[key], data);
}

/** A deep copy as Firestore returns it: Dates come back as Timestamp-like `{ toDate() }` values. */
function asStored(value: unknown): unknown {
  if (value instanceof Date) {
    const ms = value.getTime();
    return { toDate: () => new Date(ms), toMillis: () => ms };
  }
  if (Array.isArray(value)) return value.map(asStored);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, asStored(item)]));
  }
  return value;
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function compareValues(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  return (x as number) < (y as number) ? -1 : 1;
}

function matches(data: Data, [path, op, expected]: readonly [string, WhereOp, unknown]): boolean {
  const value = field(data, path);
  const list = expected as unknown[];
  switch (op) {
    case '==':
      return compareValues(value, expected) === 0;
    case '!=':
      return value !== undefined && compareValues(value, expected) !== 0;
    case '<':
      return value !== undefined && compareValues(value, expected) < 0;
    case '<=':
      return value !== undefined && compareValues(value, expected) <= 0;
    case '>':
      return value !== undefined && compareValues(value, expected) > 0;
    case '>=':
      return value !== undefined && compareValues(value, expected) >= 0;
    case 'in':
      return list.some((item) => compareValues(value, item) === 0);
    case 'not-in':
      return value !== undefined && !list.some((item) => compareValues(value, item) === 0);
    case 'array-contains':
      return Array.isArray(value) && value.some((item) => compareValues(item, expected) === 0);
    case 'array-contains-any':
      return Array.isArray(value) && value.some((item) => list.some((e) => compareValues(item, e) === 0));
  }
}

/**
 * An in-memory Firestore for unit tests of features (FND-19): it implements the repositories'
 * `CollectionDriver` with Firestore's query semantics (filters, ordering, `startAfter`/`endAt`
 * cursors, limits) and delivers changes to listeners synchronously.
 *
 * ```ts
 * const firestore = new InMemoryFirestore();
 * firestore.set('orgs/org-1/members/u1', { displayName: 'Alex Fictional', role: 'owner', status: 'active' });
 * TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(firestore)] });
 * ```
 */
export class InMemoryFirestore {
  private readonly collections = new Map<string, Map<string, Data>>();
  private readonly listeners = new Set<Listener>();
  private nextId = 1;
  private failure: unknown = null;
  /** Served from "cache": listeners report `fromCache` and writes still apply locally. */
  offline = false;
  /** Nothing ever arrives: listeners stay attached without a first snapshot (a loading state). */
  stalled = false;
  /** Every write, for assertions. */
  readonly writes: { op: 'create' | 'update' | 'softDelete'; path: string; data?: Data }[] = [];

  readonly driver: DriverFactory = (path) => this.collection(path);

  /** Attached listeners (each page of a query is one). */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Sets a document by its full path (`orgs/o/members/u1`). */
  set(docPath: string, data: Data): void {
    const { path, id } = this.split(docPath);
    this.docs(path).set(id, { ...data });
    this.notify(path);
  }

  delete(docPath: string): void {
    const { path, id } = this.split(docPath);
    this.docs(path).delete(id);
    this.notify(path);
  }

  get(docPath: string): Data | undefined {
    const { path, id } = this.split(docPath);
    return this.collections.get(path)?.get(id);
  }

  /** The next read or listen fails with this error (a Firestore-style `{ code }`). */
  failNext(error: unknown): void {
    this.failure = error;
  }

  /** Every listener on a collection fails, as Firestore does when the rules start refusing. */
  breakListeners(path: string, error: unknown): void {
    for (const listener of [...this.listeners]) if (listener.path === path) listener.fail(error);
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    for (const listener of [...this.listeners]) listener.run();
  }

  private split(docPath: string) {
    const parts = docPath.split('/');
    return { id: parts.pop() ?? '', path: parts.join('/') };
  }

  private docs(path: string): Map<string, Data> {
    let docs = this.collections.get(path);
    if (!docs) this.collections.set(path, (docs = new Map()));
    return docs;
  }

  private notify(path: string): void {
    for (const listener of [...this.listeners]) if (listener.path === path) listener.run();
  }

  private takeFailure(): unknown {
    const failure = this.failure;
    this.failure = null;
    return failure;
  }

  private raw(id: string, data: Data): RawDoc {
    const cursor: Cursor = { id, data: { ...data } };
    return { id, cursor, snapshot: { id, data: () => asStored(data) as Data } };
  }

  private sortKey(spec: QuerySpec) {
    const order = spec.orderBy ?? [];
    return (a: Cursor, b: Cursor) => {
      for (const [path, direction] of order) {
        const result = compareValues(field(a.data, path), field(b.data, path));
        if (result) return direction === 'desc' ? -result : result;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
  }

  private run(path: string, request: Pick<PageRequest, 'spec' | 'after' | 'end' | 'limit'>): RawDoc[] {
    const compare = this.sortKey(request.spec);
    const rows = [...this.docs(path).entries()]
      .map(([id, data]) => ({ id, data }))
      .filter((row) => (request.spec.where ?? []).every((clause) => matches(row.data, clause)))
      .filter((row) => (request.spec.orderBy ?? []).every(([path]) => field(row.data, path) !== undefined))
      .sort(compare)
      .filter((row) => !request.after || compare(row, request.after as Cursor) > 0)
      .filter((row) => !request.end || compare(row, request.end as Cursor) <= 0);
    const limited = request.limit ? rows.slice(0, request.limit) : rows;
    return limited.map((row) => this.raw(row.id, row.data));
  }

  private page(path: string, request: PageRequest): RawPage {
    return { docs: this.run(path, request), fromCache: this.offline };
  }

  private collection(path: string): CollectionDriver {
    const docs = () => this.docs(path);
    const stamp = (meta: { uid: string }) => ({ updatedAt: new Date(), updatedBy: meta.uid });
    return {
      listen: (request, next, error) => {
        const failure = this.takeFailure();
        if (failure) {
          queueMicrotask(() => error(failure));
          return () => undefined;
        }
        const listener: Listener = {
          path,
          run: () => {
            if (!this.stalled) next(this.page(path, request));
          },
          fail: (e) => {
            this.listeners.delete(listener);
            error(e);
          },
        };
        this.listeners.add(listener);
        listener.run();
        return () => this.listeners.delete(listener);
      },
      fetch: async (request) => {
        const failure = this.takeFailure();
        if (failure) throw failure;
        return this.page(path, request);
      },
      watchDoc: (id, next, error) => {
        const failure = this.takeFailure();
        if (failure) {
          queueMicrotask(() => error(failure));
          return () => undefined;
        }
        const listener: Listener = {
          path,
          run: () => {
            const data = docs().get(id);
            next(data ? this.raw(id, data) : null, this.offline);
          },
          fail: (e) => {
            this.listeners.delete(listener);
            error(e);
          },
        };
        this.listeners.add(listener);
        listener.run();
        return () => this.listeners.delete(listener);
      },
      getDoc: async (id) => {
        const failure = this.takeFailure();
        if (failure) throw failure;
        const data = docs().get(id);
        return data ? this.raw(id, data) : null;
      },
      count: async (spec) => this.run(path, { spec, after: null, end: null, limit: null }).length,
      create: async (data, meta) => {
        const id = `doc-${this.nextId++}`;
        const now = new Date();
        const doc = {
          ...data,
          createdAt: now,
          createdBy: meta.uid,
          ...stamp(meta),
          schemaVersion: meta.schemaVersion,
        };
        this.writes.push({ op: 'create', path: `${path}/${id}`, data: doc });
        docs().set(id, doc);
        this.notify(path);
        return id;
      },
      update: async (id, patch, meta) => {
        const current = docs().get(id);
        if (!current) throw { code: 'not-found', message: `No document ${path}/${id}` };
        const change = { ...patch, ...stamp(meta) };
        this.writes.push({ op: 'update', path: `${path}/${id}`, data: change });
        docs().set(id, { ...current, ...change });
        this.notify(path);
      },
      softDelete: async (id, meta) => {
        const current = docs().get(id);
        if (!current) throw { code: 'not-found', message: `No document ${path}/${id}` };
        const change = { deletedAt: new Date(), deletedBy: meta.uid, ...stamp(meta) };
        this.writes.push({ op: 'softDelete', path: `${path}/${id}`, data: change });
        docs().set(id, { ...current, ...change });
        this.notify(path);
      },
    };
  }
}

/** Provides an `InMemoryFirestore` as the repositories' driver (returned so tests can seed it). */
export function provideInMemoryFirestore(firestore = new InMemoryFirestore()): Provider[] {
  return [
    { provide: FIRESTORE_DRIVER, useValue: firestore.driver },
    { provide: InMemoryFirestore, useValue: firestore },
  ];
}
