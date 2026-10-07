import type { Role } from '@materia/domain';

/**
 * The ports behind `buildContext` (AI-03): chunk search (AI-04), document text, token counting and
 * the Firestore reads. Each has a fake in `./testing.ts`; production wiring is in `./service.ts`.
 */

// ---------- chunk search (AI-04) ----------

/**
 * Vector search over one matter's chunks. AI-04 owns the implementation
 * (`documents/ingest/search.ts`, `chunkSearch({ db, embedding })`); this interface is structurally
 * identical to it, so swapping the stub for the real factory needs no other change.
 */
export interface ChunkSearchInput {
  orgId: string;
  matterId: string;
  /** Embedded server-side. */
  query: string;
  /** Defaults to 8, clamped to 1..50. */
  k?: number;
  /** False pre-filters `privileged == false` in the query itself. */
  allowPrivileged: boolean;
}

export interface ChunkHit {
  documentId: string;
  version: number;
  /** 1-based. */
  page: number;
  /** The chunk's index in its document. */
  ordinal: number;
  text: string;
  privileged: boolean;
  /** Cosine distance: lower is closer. */
  distance: number;
}

/**
 * Only live, clean, ingested documents have chunks, and hits carry no document names. The port
 * trusts `orgId`: callers check membership and matter access first.
 */
export interface ChunkSearchPort {
  searchChunks(input: ChunkSearchInput): Promise<ChunkHit[]>;
}

// ---------- document text ----------

export interface DocumentPage {
  /** 1-based. */
  page: number;
  text: string;
}

/**
 * The extracted text of one document version, page by page (AI-04 writes it at ingest). An empty
 * list means there is no text yet: the attachment is treated as still processing.
 */
export interface DocumentTextPort {
  pages(input: { orgId: string; matterId: string; documentId: string; version: number }): Promise<DocumentPage[]>;
}

// ---------- token counting ----------

/**
 * Counts the tokens a piece of context will cost. `exact` counters call the provider's
 * token-counting endpoint; the estimate is a character count, which is enough to keep a context
 * under budget with headroom.
 */
export interface TokenCounter {
  readonly exact: boolean;
  count(texts: readonly string[]): Promise<number[]>;
}

/** About 3.5 characters a token for English legal prose (conservative: real text runs nearer 4). */
export const CHARS_PER_TOKEN = 3.5;

export const charEstimateCounter: TokenCounter = {
  exact: false,
  count: async (texts) => texts.map((text) => Math.ceil(text.length / CHARS_PER_TOKEN)),
};

// ---------- reads ----------

type Data = Record<string, unknown>;

/** A Firestore document's id and data. */
export interface Row {
  id: string;
  data: Data;
}

/**
 * The reads `buildContext` makes, all inside one org (Firestore in production, in memory in unit
 * tests). It never lists a matter's documents for their text: documents are read by id only
 * (attachments and retrieval hits), so a matter with thousands of documents costs no more than one
 * with three. The matter brief (AI-06c) reads only the newest few documents' names and categories.
 */
export interface ContextSource {
  /**
   * `orgs/{orgId}/members/{uid}`, uncached: a suspension or role change takes effect at once. Also
   * read for the matter's responsible lawyer, whose name and title go in the matter facts.
   */
  member(
    orgId: string,
    uid: string,
  ): Promise<{ status: string; role: Role; displayName?: string; title?: string } | null>;
  /** The org's time zone (`orgs/{orgId}.timezone`). */
  orgTimeZone(orgId: string): Promise<string | undefined>;
  matter(orgId: string, matterId: string): Promise<Row | null>;
  parties(orgId: string, matterId: string): Promise<Row[]>;
  /** Display names by contact id (missing contacts are left out). */
  contactNames(orgId: string, contactIds: readonly string[]): Promise<Map<string, string>>;
  events(orgId: string, matterId: string): Promise<Row[]>;
  /** Upcoming and blocked deadlines. */
  openDeadlines(orgId: string, matterId: string): Promise<Row[]>;
  /** Tasks that are `todo`, `in_progress` or `blocked`. */
  openTasks(orgId: string, matterId: string): Promise<Row[]>;
  /**
   * The newest notes, newest first. Without `allowPrivileged` the query itself proves
   * `privileged == false`, so privileged notes are never read.
   */
  recentNotes(orgId: string, matterId: string, options: { allowPrivileged: boolean; limit: number }): Promise<Row[]>;
  /** Documents of this matter by id; ids that don't exist under the matter are left out. */
  documents(orgId: string, matterId: string, ids: readonly string[]): Promise<Row[]>;
  /**
   * The matter brief's reads (AI-06c), newest first and capped: the activity feed's lines, the
   * documents added (metadata only, privileged ones included: the brief's facts leave them out
   * unless the matter is privileged), and the open suggestions.
   */
  recentActivity(orgId: string, matterId: string, options: { limit: number }): Promise<Row[]>;
  recentDocuments(orgId: string, matterId: string, options: { limit: number }): Promise<Row[]>;
  openSuggestions(orgId: string, matterId: string, options: { limit: number }): Promise<Row[]>;
  /**
   * The month rollups (`metrics/month-YYYY-MM`) for these months (`2026-05`), each with its counter
   * shards added into `values` (ADR-048). Months with neither a document nor shards are left out.
   */
  metricMonths(orgId: string, months: readonly string[]): Promise<Row[]>;
  /**
   * The matter's trust balance snapshot (BILL-11, ADR-035) and the org's out-of-date threshold, or
   * null while `billing.trustDisplay` or the org's "Show trust balances on matters" is off. Callers
   * check `billing.view` first.
   */
  trustSnapshot(orgId: string, matterId: string): Promise<{ snapshot: Row; staleAfterDays: number } | null>;
}
