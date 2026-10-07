import { sumMetricShards, type Role } from '@materia/domain';

import type {
  ChunkHit,
  ChunkSearchInput,
  ChunkSearchPort,
  ContextSource,
  DocumentPage,
  DocumentTextPort,
  Row,
} from './ports';

type Data = Record<string, unknown>;

/** One org's data for `MemoryContextSource`: matters and their subcollections, by id. */
export interface MemoryMatter {
  data: Data;
  parties?: Record<string, Data>;
  events?: Record<string, Data>;
  deadlines?: Record<string, Data>;
  tasks?: Record<string, Data>;
  notes?: Record<string, Data>;
  documents?: Record<string, Data>;
  activity?: Record<string, Data>;
  suggestions?: Record<string, Data>;
}

export interface MemoryOrg {
  timezone?: string;
  members: Record<string, { status: string; role: Role; displayName?: string; title?: string }>;
  contacts?: Record<string, string>;
  matters: Record<string, MemoryMatter>;
  /** Metrics documents by id (`month-2026-05`): `{period, values}`. */
  metrics?: Record<string, Data>;
  /** Counter shards' `values` by period id (ADR-048). */
  metricShards?: Record<string, Data[]>;
  /** Trust balance snapshots by matter id, shown while `trust` is set (the flag and the org switch on). */
  trustSnapshots?: Record<string, Data>;
  trust?: { staleAfterDays: number };
}

const toRows = (records: Record<string, Data> | undefined): Row[] =>
  Object.entries(records ?? {}).map(([id, data]) => ({ id, data }));

/** Rows by a Date field, newest first, capped (as the Firestore source's `orderBy(…, 'desc')`). */
const newest = (rows: Row[], field: string, limit: number) =>
  rows
    .sort(
      (a, b) =>
        ((b.data[field] as Date | undefined)?.getTime() ?? 0) - ((a.data[field] as Date | undefined)?.getTime() ?? 0),
    )
    .slice(0, limit);

/**
 * An in-memory ContextSource for unit tests (the Firestore one is covered by integration tests).
 * It records every read, so tests can prove a matter's documents are never listed.
 */
export class MemoryContextSource implements ContextSource {
  readonly reads: string[] = [];

  constructor(readonly orgs: Record<string, MemoryOrg>) {}

  private matterOf(orgId: string, matterId: string): MemoryMatter | undefined {
    return this.orgs[orgId]?.matters[matterId];
  }

  async member(orgId: string, uid: string) {
    this.reads.push(`member:${uid}`);
    return this.orgs[orgId]?.members[uid] ?? null;
  }

  async orgTimeZone(orgId: string) {
    return this.orgs[orgId]?.timezone;
  }

  async matter(orgId: string, matterId: string) {
    this.reads.push(`matter:${matterId}`);
    const matter = this.matterOf(orgId, matterId);
    return matter ? { id: matterId, data: matter.data } : null;
  }

  async parties(orgId: string, matterId: string) {
    return toRows(this.matterOf(orgId, matterId)?.parties);
  }

  async contactNames(orgId: string, contactIds: readonly string[]) {
    const contacts = this.orgs[orgId]?.contacts ?? {};
    return new Map(contactIds.filter((id) => contacts[id]).map((id) => [id, contacts[id] as string]));
  }

  async events(orgId: string, matterId: string) {
    return toRows(this.matterOf(orgId, matterId)?.events);
  }

  async openDeadlines(orgId: string, matterId: string) {
    return toRows(this.matterOf(orgId, matterId)?.deadlines).filter((row) =>
      ['upcoming', 'blocked'].includes(row.data['status'] as string),
    );
  }

  async openTasks(orgId: string, matterId: string) {
    return toRows(this.matterOf(orgId, matterId)?.tasks).filter((row) =>
      ['todo', 'in_progress', 'blocked'].includes(row.data['status'] as string),
    );
  }

  async recentNotes(orgId: string, matterId: string, options: { allowPrivileged: boolean; limit: number }) {
    this.reads.push(`notes:${matterId}:${options.allowPrivileged ? 'all' : 'unprivileged'}`);
    const at = (row: Row) => (row.data['createdAt'] as Date | undefined)?.getTime() ?? 0;
    return toRows(this.matterOf(orgId, matterId)?.notes)
      .filter((row) => options.allowPrivileged || row.data['privileged'] === false)
      .sort((a, b) => at(b) - at(a))
      .slice(0, options.limit);
  }

  async documents(orgId: string, matterId: string, ids: readonly string[]) {
    this.reads.push(`documents:${matterId}:${ids.length}`);
    const docs = this.matterOf(orgId, matterId)?.documents ?? {};
    return ids.filter((id) => docs[id]).map((id) => ({ id, data: docs[id] as Data }));
  }

  async recentActivity(orgId: string, matterId: string, options: { limit: number }) {
    this.reads.push(`activity:${matterId}`);
    return newest(toRows(this.matterOf(orgId, matterId)?.activity), 'at', options.limit);
  }

  async recentDocuments(orgId: string, matterId: string, options: { limit: number }) {
    this.reads.push(`recentDocuments:${matterId}`);
    return newest(toRows(this.matterOf(orgId, matterId)?.documents), 'createdAt', options.limit);
  }

  async openSuggestions(orgId: string, matterId: string, options: { limit: number }) {
    this.reads.push(`suggestions:${matterId}`);
    return toRows(this.matterOf(orgId, matterId)?.suggestions)
      .filter((row) => ['proposed', 'stale'].includes(row.data['status'] as string))
      .slice(0, options.limit);
  }

  async metricMonths(orgId: string, months: readonly string[]) {
    this.reads.push(`metrics:${months.length}`);
    const org = this.orgs[orgId];
    return months.flatMap((month) => {
      const id = `month-${month}`;
      const data = org?.metrics?.[id];
      const shards = org?.metricShards?.[id] ?? [];
      if (!data && !shards.length) return [];
      return [{ id, data: { ...data, values: sumMetricShards(data?.['values'] as Data | undefined, shards) } }];
    });
  }

  async trustSnapshot(orgId: string, matterId: string) {
    this.reads.push(`trust:${matterId}`);
    const org = this.orgs[orgId];
    const data = org?.trustSnapshots?.[matterId];
    return org?.trust && data ? { snapshot: { id: matterId, data }, staleAfterDays: org.trust.staleAfterDays } : null;
  }
}

/** Scripted chunk search: returns `hits`, filtered like AI-04's (privileged pre-filter, `k`). */
export class FakeChunkSearch implements ChunkSearchPort {
  readonly calls: ChunkSearchInput[] = [];

  constructor(public hits: ChunkHit[] = []) {}

  async searchChunks(input: ChunkSearchInput): Promise<ChunkHit[]> {
    this.calls.push(input);
    const k = Math.min(50, Math.max(1, input.k ?? 8));
    return this.hits.filter((hit) => input.allowPrivileged || !hit.privileged).slice(0, k);
  }
}

/** A chunk search that ignores `allowPrivileged`: proves `buildContext` filters again. */
export class LeakyChunkSearch extends FakeChunkSearch {
  override async searchChunks(input: ChunkSearchInput): Promise<ChunkHit[]> {
    this.calls.push(input);
    return this.hits;
  }
}

/** Document text by `documentId@version`. */
export class FakeDocumentText implements DocumentTextPort {
  constructor(readonly texts: Record<string, DocumentPage[]> = {}) {}

  async pages(input: { documentId: string; version: number }): Promise<DocumentPage[]> {
    return this.texts[`${input.documentId}@${input.version}`] ?? [];
  }
}

/** A chunk hit with defaults. */
export function hit(over: Partial<ChunkHit> & Pick<ChunkHit, 'documentId' | 'text'>): ChunkHit {
  return { version: 1, page: 1, ordinal: 0, privileged: false, distance: 0.2, ...over };
}
