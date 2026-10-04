import { computed, effect, inject, Injector, isDevMode, signal, untracked, type Signal } from '@angular/core';
import type { z } from 'zod';

import { firestoreConverter, toFirestoreValue, type ConverterOptions } from '@materia/domain/firestore';

import { Connectivity } from './connectivity';
import { toDomainError } from './errors';
import { FIRESTORE_DRIVER } from './firestore/firestore-driver';
import { ListenerRegistry } from './listener-registry';
import { OrgContext } from './org-context';
import type { CollectionDriver, QuerySpec, RawDoc } from './query';
import {
  DocWatch,
  PagedQuery,
  type DocResource,
  type EngineContext,
  type QueryResource,
  type ResourceStatus,
  type WithId,
} from './resources';
import { ACCESS_REVOKED_HANDLER, DATA_CLOCK } from './tokens';

/** How long a `count()` result is reused (badges don't need to be exact to the second). */
export const COUNT_CACHE_MS = 60_000;

/** An entity from `libs/domain` (`withMeta(...)`), or any schema with a version. */
export interface EntityDef<T> {
  schema: z.ZodType<T>;
  version: number;
  /** Validates `create` input (the entity's create schema). */
  create?: z.ZodType;
  /** Validates `update` patches (the entity's update schema, a whitelist of fields). */
  update?: z.ZodType;
}

export interface RepositoryOptions {
  /** Invalid documents throw in dev and tests (`strict`), and are flagged in production (`lenient`). */
  mode?: ConverterOptions['mode'];
  upgrades?: ConverterOptions['upgrades'];
}

export interface WatchOptions {
  /** Where the listener lives; defaults to the calling injection context (a component's). */
  injector?: Injector;
}

export interface WatchQueryOptions extends WatchOptions {
  /** Keep listening (default) or read once. */
  live?: boolean;
}

export interface UpdateOptions {
  /** Fields to delete from the document. */
  remove?: readonly string[];
}

/**
 * Read-only access to a collection group across the active org (`parties` on every matter). Every
 * query is scoped with `orgId == <active org>`, so group documents must carry `orgId`.
 */
export type GroupRepository<T> = Pick<Repository<T>, 'query' | 'watchQuery' | 'count'>;

/** A query, or a function of signals returning one (`null` waits). */
export type QueryInput<T> = QuerySpec<T> | (() => QuerySpec<T> | null);

/**
 * Typed access to one org-scoped collection (FND-19). Reads return domain types (Timestamps are
 * Dates, validated by the `libs/domain` schema); feature code never sees Firestore types.
 */
export interface Repository<T> {
  get(id: string): Promise<WithId<T> | null>;
  /** A live document. Call in an injection context (or pass `injector`); it stops with it. */
  watch(id: string | (() => string | null), options?: WatchOptions): DocResource<T>;
  /** The first page of a query, once. */
  query(spec?: QuerySpec<T>): Promise<WithId<T>[]>;
  /** A paged query resource, live by default. Call in an injection context (or pass `injector`). */
  watchQuery(spec: QueryInput<T>, options?: WatchQueryOptions): QueryResource<T>;
  /** `getCountFromServer`, cached for a minute per query (for badges). */
  count(spec?: QuerySpec<T>): Promise<number>;
  /** A client-direct create, only where the rules allow one (most creates go through callables). */
  create(data: Partial<T> | Record<string, unknown>): Promise<string>;
  /**
   * A client-direct update of whitelisted fields; `updatedAt`/`updatedBy` are stamped. `remove`
   * deletes optional fields (clearing a date, say); they must be in the update whitelist too.
   */
  update(id: string, patch: Partial<T> | Record<string, unknown>, options?: UpdateOptions): Promise<void>;
  softDelete(id: string): Promise<void>;
}

function currentInjector(fallback: Injector): Injector {
  try {
    return inject(Injector);
  } catch {
    return fallback;
  }
}

function resolveSpec<T>(input: QueryInput<T>): QuerySpec<T> | null {
  return typeof input === 'function' ? input() : input;
}

/**
 * Builds a repository for an org-scoped collection. Call it in an injection context:
 *
 * ```ts
 * const matters = repo((orgId) => `orgs/${orgId}/matters`, Matter);
 * ```
 *
 * The path is built from `OrgContext`, so a query follows the active org, and every listener is
 * tracked by the `ListenerRegistry`.
 */
export function repo<T>(
  path: (orgId: string) => string,
  entity: EntityDef<T>,
  options: RepositoryOptions = {},
): Repository<T> {
  return createRepository(path, entity, options, false);
}

/**
 * A collection-group repository (`parties` across every matter of the active org). Call it in an
 * injection context:
 *
 * ```ts
 * const parties = groupRepo('parties', Party);
 * parties.watchQuery({ where: [['contactId', '==', id]] }); // + orgId == active org
 * ```
 *
 * The group's documents must carry `orgId` (server-owned), and the query needs a collection-group
 * index (or field override) in `firebase/firestore.indexes.json`.
 */
export function groupRepo<T>(
  collectionId: string,
  entity: EntityDef<T>,
  options: RepositoryOptions = {},
): GroupRepository<T> {
  const { query, watchQuery, count } = createRepository(() => collectionId, entity, options, true);
  return { query, watchQuery, count };
}

function createRepository<T>(
  path: (orgId: string) => string,
  entity: EntityDef<T>,
  options: RepositoryOptions,
  group: boolean,
): Repository<T> {
  const context = inject(OrgContext);
  const registry = inject(ListenerRegistry);
  const drivers = inject(FIRESTORE_DRIVER);
  const online = inject(Connectivity).online;
  const accessRevoked = inject(ACCESS_REVOKED_HANDLER);
  const now = inject(DATA_CLOCK);
  const home = inject(Injector);

  const converter = firestoreConverter(entity, {
    mode: options.mode ?? (isDevMode() ? 'strict' : 'lenient'),
    ...(options.upgrades ? { upgrades: options.upgrades } : {}),
  });
  const convert = (doc: RawDoc): WithId<T> => ({
    ...converter.fromFirestore(doc.snapshot, { serverTimestamps: 'estimate' }),
    id: doc.id,
  });
  const driverFor = (orgId: string): CollectionDriver =>
    group ? drivers(path(orgId), { group: true }) : drivers(path(orgId));
  const driver = () => driverFor(context.requireOrgId());
  /** Group queries span every org's collections: keep them to the active org's documents. */
  const scope = (spec: QuerySpec, orgId: string): QuerySpec =>
    group ? { ...spec, where: [['orgId', '==', orgId], ...(spec.where ?? [])] } : spec;
  const engine = (orgId: string): EngineContext<T> => ({
    driver: driverFor(orgId),
    convert,
    online,
    track: (stop, label) => registry.add(stop, { label }),
    label: group ? `group:${path(orgId)}` : path(orgId),
    onAccessRevoked: accessRevoked,
  });
  const meta = () => ({ uid: context.requireUid(), schemaVersion: entity.version });
  const counts = new Map<string, { at: number; value: Promise<number> }>();

  const guard = async <R>(work: () => Promise<R>, source: 'read' | 'write'): Promise<R> => {
    try {
      return await work();
    } catch (error) {
      throw toDomainError(error, source);
    }
  };

  return {
    get: (id) =>
      guard(async () => {
        const doc = await driver().getDoc(id);
        return doc ? convert(doc) : null;
      }, 'read'),

    watch(id, watchOptions = {}) {
      const injector = watchOptions.injector ?? currentInjector(home);
      const current = signal<DocWatch<T> | null>(null);
      effect(
        (onCleanup) => {
          const orgId = context.orgId();
          const docId = typeof id === 'function' ? id() : id;
          if (!orgId || !docId) {
            current.set(null);
            return;
          }
          const watcher = new DocWatch(engine(orgId), docId);
          untracked(() => watcher.start());
          current.set(watcher);
          onCleanup(() => watcher.stop());
        },
        { injector },
      );
      return {
        value: computed(() => current()?.value() ?? null),
        status: computed<ResourceStatus>(() => current()?.status() ?? (online() ? 'loading' : 'offline')),
        error: computed(() => current()?.error() ?? null),
        fromCache: computed(() => current()?.fromCache() ?? false),
        exists: computed(() => current()?.exists() ?? true),
      };
    },

    query: (spec = {}) =>
      guard(async () => {
        const orgId = context.requireOrgId();
        const page = await driverFor(orgId).fetch({
          spec: scope(spec as QuerySpec, orgId),
          after: null,
          end: null,
          limit: spec.pageSize ?? null,
        });
        const rows = page.docs.map(convert);
        return spec.includeDeleted ? rows : rows.filter((row) => !(row as { deletedAt?: unknown }).deletedAt);
      }, 'read'),

    watchQuery(input, watchOptions = {}) {
      const injector = watchOptions.injector ?? currentInjector(home);
      const live = watchOptions.live ?? true;
      const current = signal<PagedQuery<T> | null>(null);
      effect(
        (onCleanup) => {
          const orgId = context.orgId();
          const spec = resolveSpec(input);
          if (!orgId || !spec) {
            current.set(null);
            return;
          }
          const query = new PagedQuery(engine(orgId), scope(spec as QuerySpec, orgId), live);
          untracked(() => query.start());
          current.set(query);
          onCleanup(() => query.stop());
        },
        { injector },
      );
      const read = <V>(pick: (q: PagedQuery<T>) => Signal<V>, fallback: V) =>
        computed(() => {
          const query = current();
          return query ? pick(query)() : fallback;
        });
      return {
        value: read((q) => q.value, [] as WithId<T>[]),
        status: computed<ResourceStatus>(() => current()?.status() ?? (online() ? 'loading' : 'offline')),
        error: read((q) => q.error, null),
        fromCache: read((q) => q.fromCache, false),
        hasMore: read((q) => q.hasMore, false),
        loadingMore: read((q) => q.loadingMore, false),
        newItems: read((q) => q.newItems, 0),
        loadMore: () => current()?.loadMore() ?? Promise.resolve(),
        refresh: () => current()?.refresh(),
      };
    },

    count(spec = {}) {
      const orgId = context.requireOrgId();
      const key = `${orgId}|${path(orgId)}|${JSON.stringify(spec)}`;
      const cached = counts.get(key);
      if (cached && now() - cached.at < COUNT_CACHE_MS) return cached.value;
      const value = guard(() => driverFor(orgId).count(scope(spec as QuerySpec, orgId)), 'read');
      counts.set(key, { at: now(), value });
      value.catch(() => counts.delete(key));
      return value;
    },

    create: (data) =>
      guard(async () => {
        const input = entity.create ? entity.create.parse(data) : data;
        return driver().create(toFirestoreValue(input) as Record<string, unknown>, meta());
      }, 'write'),

    update: (id, patch, updateOptions = {}) =>
      guard(async () => {
        const remove = updateOptions.remove ?? [];
        const input = entity.update ? entity.update.parse(patch) : patch;
        // Removed fields must be updatable too: the strict update schema rejects any other key.
        if (entity.update && remove.length) entity.update.parse(Object.fromEntries(remove.map((f) => [f, undefined])));
        await driver().update(id, toFirestoreValue(input) as Record<string, unknown>, meta(), remove);
      }, 'write'),

    softDelete: (id) => guard(() => driver().softDelete(id, meta()), 'write'),
  };
}
