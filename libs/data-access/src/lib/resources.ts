import { computed, signal, type Signal } from '@angular/core';

import type { DomainError } from '@materia/domain';

import { toDomainError } from './errors';
import { DEFAULT_PAGE_SIZE, type CollectionDriver, type QuerySpec, type RawDoc, type RawPage } from './query';

/** A document as repositories return it: the domain type plus its id. */
export type WithId<T> = T & { id: string };

/** `offline`: the data shown came from this device's cache and the browser is offline. */
export type ResourceStatus = 'loading' | 'ready' | 'error' | 'offline';

/** A signal view of a query: one-shot or live, paged with cursors (FND-19). */
export interface QueryResource<T> {
  value: Signal<WithId<T>[]>;
  status: Signal<ResourceStatus>;
  error: Signal<DomainError | null>;
  /** The rows came from the local cache (offline, or before the server answered). */
  fromCache: Signal<boolean>;
  hasMore: Signal<boolean>;
  loadingMore: Signal<boolean>;
  /**
   * Rows added above the first page since paging started. They are held back instead of shifting
   * the pages under the reader; show a "new items" pill and call `refresh()` to show them.
   */
  newItems: Signal<number>;
  /** Loads the next page; resolves when it has arrived (or failed). */
  loadMore(): Promise<void>;
  /** Starts again from the first page (after an error, or to show new items). */
  refresh(): void;
}

/** A signal view of one document. `value` is null while loading and when it doesn't exist. */
export interface DocResource<T> {
  value: Signal<WithId<T> | null>;
  status: Signal<ResourceStatus>;
  error: Signal<DomainError | null>;
  fromCache: Signal<boolean>;
  /** False once loaded and the document doesn't exist. */
  exists: Signal<boolean>;
}

/** What an engine needs from its surroundings; repositories fill it in from the injector. */
export interface EngineContext<T> {
  driver: CollectionDriver;
  convert: (doc: RawDoc) => WithId<T>;
  online: Signal<boolean>;
  /** Tracks a listener (the `ListenerRegistry`); returns its release. */
  track: (stop: () => void, label: string) => () => void;
  label: string;
  onAccessRevoked?: (error: DomainError) => void;
}

interface Row<T> {
  id: string;
  data: WithId<T>;
  cursor: unknown;
}

interface Page<T> {
  /** Start after this cursor (null: the first page). */
  after: unknown;
  /** Sealed pages end at this cursor; an unsealed page has a limit instead. */
  end: unknown;
  rows: Row<T>[];
  more: boolean;
  loaded: boolean;
  fromCache: boolean;
  /** The first page's ids when it was sealed: anything that sorts before them is new. */
  known: Set<string> | null;
  release?: (() => void) | undefined;
  closing?: boolean;
  waiters: (() => void)[];
}

const isDeleted = (data: unknown) => !!(data as { deletedAt?: unknown } | null)?.deletedAt;

function statusOf(loaded: boolean, error: unknown, fromCache: boolean, online: boolean): ResourceStatus {
  if (error) return 'error';
  if (!loaded) return online ? 'loading' : 'offline';
  return fromCache && !online ? 'offline' : 'ready';
}

/**
 * The paging engine behind `Repository.watchQuery` (FND-19). Each page is a window of the query
 * read with `limit(pageSize + 1)` (the extra row says whether there is more) after the previous
 * page's last row (`startAfter`).
 *
 * Live queries keep a listener per page. Before the next page loads, the current last page is
 * sealed: its listener is replaced by one bounded with `endAt(its last row)`, so later inserts
 * land in the page they sort into instead of pushing rows across page boundaries (no duplicates,
 * nothing skipped). When the first page is sealed it remembers its ids; rows that later sort
 * above all of them are counted in `newItems` and held back, rather than reordering what the
 * reader is looking at.
 */
export class PagedQuery<T> implements QueryResource<T> {
  private pages: Page<T>[] = [];
  private epoch = 0;
  private readonly pageSize: number;
  private readonly rows = signal<WithId<T>[]>([]);
  private readonly loaded = signal(false);
  private readonly failure = signal<DomainError | null>(null);
  private readonly cached = signal(false);
  private readonly more = signal(false);
  private readonly busy = signal(false);
  private readonly fresh = signal(0);

  readonly value = this.rows.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly fromCache = this.cached.asReadonly();
  readonly hasMore = this.more.asReadonly();
  readonly loadingMore = this.busy.asReadonly();
  readonly newItems = this.fresh.asReadonly();
  readonly status: Signal<ResourceStatus>;

  constructor(
    private readonly ctx: EngineContext<T>,
    private readonly spec: QuerySpec,
    private readonly live: boolean,
  ) {
    this.pageSize = Math.max(1, spec.pageSize ?? DEFAULT_PAGE_SIZE);
    this.status = computed(() => statusOf(this.loaded(), this.failure(), this.cached(), this.ctx.online()));
  }

  start(): void {
    this.epoch++;
    this.failure.set(null);
    this.fresh.set(0);
    const first = this.page(null);
    this.pages = [first];
    this.open(first);
  }

  /** Stops every listener. `clear` also empties the rows (an org switch must not leave them on screen). */
  stop(clear = true): void {
    this.epoch++;
    for (const page of this.pages) this.close(page);
    for (const page of this.pages) page.waiters.splice(0).forEach((resolve) => resolve());
    this.pages = [];
    this.busy.set(false);
    if (clear) {
      this.rows.set([]);
      this.loaded.set(false);
      this.cached.set(false);
      this.more.set(false);
    }
  }

  refresh(): void {
    this.stop(false);
    this.start();
  }

  loadMore(): Promise<void> {
    const last = this.pages.at(-1);
    const lastRow = last?.rows.at(-1);
    if (!last || !lastRow || !last.more || this.busy() || this.failure()) return Promise.resolve();
    this.busy.set(true);
    if (this.live) {
      last.end = lastRow.cursor;
      last.more = false;
      if (this.pages.length === 1) last.known = new Set(last.rows.map((row) => row.id));
      this.close(last);
      this.open(last);
    }
    const next = this.page(lastRow.cursor);
    this.pages.push(next);
    const arrived = new Promise<void>((resolve) => next.waiters.push(resolve));
    this.open(next);
    return arrived;
  }

  private page(after: unknown): Page<T> {
    return { after, end: null, rows: [], more: false, loaded: false, fromCache: false, known: null, waiters: [] };
  }

  private open(page: Page<T>): void {
    const epoch = this.epoch;
    const request = { spec: this.spec, after: page.after, end: page.end, limit: page.end ? null : this.pageSize + 1 };
    const receive = (raw: RawPage) => {
      if (epoch === this.epoch) this.receive(page, raw);
    };
    const fail = (error: unknown) => {
      if (epoch === this.epoch) this.fail(error);
    };
    if (!this.live) {
      this.ctx.driver.fetch(request).then(receive, fail);
      return;
    }
    page.closing = false;
    const unsubscribe = this.ctx.driver.listen(request, receive, fail);
    page.release = this.ctx.track(() => {
      unsubscribe();
      // Stopped from outside (an org switch, sign-out): drop everything from the old session.
      if (!page.closing) this.stop(true);
    }, this.ctx.label);
  }

  private close(page: Page<T>): void {
    page.closing = true;
    page.release?.();
    page.release = undefined;
  }

  private receive(page: Page<T>, raw: RawPage): void {
    let rows: Row<T>[];
    try {
      rows = raw.docs.map((doc) => ({ id: doc.id, cursor: doc.cursor, data: this.ctx.convert(doc) }));
    } catch (error) {
      this.fail(error);
      return;
    }
    if (page.end) {
      if (page.known) {
        const firstKnown = rows.findIndex((row) => page.known?.has(row.id));
        const held = firstKnown < 0 ? 0 : firstKnown;
        this.fresh.set(held);
        rows = rows.slice(held);
      }
      page.rows = rows;
    } else {
      page.more = rows.length > this.pageSize;
      page.rows = rows.slice(0, this.pageSize);
    }
    page.loaded = true;
    page.fromCache = raw.fromCache;
    // A page served from the cache first may be partial: wait for the server, unless offline.
    if (!raw.fromCache || !this.ctx.online()) page.waiters.splice(0).forEach((resolve) => resolve());
    this.publish();
  }

  private publish(): void {
    const pages = this.pages;
    const all = pages.flatMap((page) => page.rows.map((row) => row.data));
    this.rows.set(this.spec.includeDeleted ? all : all.filter((data) => !isDeleted(data)));
    this.loaded.set(pages[0]?.loaded ?? false);
    this.cached.set(pages.some((page) => page.loaded && page.fromCache));
    const last = pages.at(-1);
    this.more.set(!!last?.loaded && last.more);
    if (this.busy() && last?.loaded && !last.waiters.length) this.busy.set(false);
  }

  private fail(raw: unknown): void {
    const error = toDomainError(raw, 'read');
    this.stop(error.code === 'ACCESS_REVOKED');
    this.loaded.set(true);
    this.failure.set(error);
    // A refused read after a role change: no retry loop, the app routes to "no access".
    if (error.code === 'ACCESS_REVOKED') this.ctx.onAccessRevoked?.(error);
  }
}

/** The engine behind `Repository.watch(id)`: one live document. */
export class DocWatch<T> implements DocResource<T> {
  private epoch = 0;
  private release?: (() => void) | undefined;
  private closing = false;
  private readonly doc = signal<WithId<T> | null>(null);
  private readonly loaded = signal(false);
  private readonly failure = signal<DomainError | null>(null);
  private readonly cached = signal(false);

  readonly value = this.doc.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly fromCache = this.cached.asReadonly();
  readonly status: Signal<ResourceStatus>;
  readonly exists = computed(() => !this.loaded() || this.doc() !== null);

  constructor(
    private readonly ctx: EngineContext<T>,
    private readonly id: string,
  ) {
    this.status = computed(() => statusOf(this.loaded(), this.failure(), this.cached(), this.ctx.online()));
  }

  start(): void {
    const epoch = ++this.epoch;
    this.failure.set(null);
    this.closing = false;
    const unsubscribe = this.ctx.driver.watchDoc(
      this.id,
      (raw, fromCache) => {
        if (epoch !== this.epoch) return;
        try {
          this.doc.set(raw ? this.ctx.convert(raw) : null);
        } catch (error) {
          this.fail(error);
          return;
        }
        this.cached.set(fromCache);
        this.loaded.set(true);
      },
      (error) => {
        if (epoch === this.epoch) this.fail(error);
      },
    );
    this.release = this.ctx.track(() => {
      unsubscribe();
      if (!this.closing) this.stop();
    }, this.ctx.label);
  }

  stop(): void {
    this.epoch++;
    this.closing = true;
    this.release?.();
    this.release = undefined;
    this.doc.set(null);
    this.loaded.set(false);
    this.cached.set(false);
  }

  private fail(raw: unknown): void {
    const error = toDomainError(raw, 'read');
    this.stop();
    this.loaded.set(true);
    this.failure.set(error);
    if (error.code === 'ACCESS_REVOKED') this.ctx.onAccessRevoked?.(error);
  }
}
