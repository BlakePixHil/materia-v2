import { createHash } from 'node:crypto';

/**
 * The pure half of the audit log (FND-18): what kind of write happened, which fields changed, who
 * did it, and the redacted before/after that goes into `orgs/{orgId}/audit/{eventId}`.
 */

export type AuditWriteAction = 'create' | 'update' | 'delete' | 'soft_delete' | 'restore';
export type AuditSource = 'client' | 'callable' | 'trigger' | 'job' | 'migration';
export type AuditActor = { uid: string } | 'system' | 'clerk';
export type DocData = Record<string, unknown>;

/** Collections the trigger never audits: its own output, derived data and operational records. */
export const EXCLUDED_COLLECTIONS = new Set([
  'audit',
  'metrics',
  'activity',
  'chunks',
  'requests',
  'counters',
  // Matter number reservations (CORE-03): written with the matter, which is audited.
  'matterNumbers',
  // The documents hash index (CORE-12): written with the document version, which is audited.
  'documentHashes',
]);

/**
 * Denormalised or ordering fields: an update that changes only these (plus meta) is noise, such as
 * a recomputed `nextDeadline` or 500 tasks reordered.
 */
export const NOISE_FIELDS = new Set([
  'nextDeadline',
  'openTaskCount',
  // Tasks (CORE-08): written by tasks-onWrite after a status change, which is audited itself.
  'countedOpen',
  'completedAt',
  // Deadlines (CORE-10): the recompute's serial number, and the missed check's question.
  'recomputeVersion',
  'missedCheck',
  'wipCents',
  'disbursementWipCents',
  // Time entries (BILL-01): what time-onWrite has counted into the matter's wipCents.
  'wipCountedCents',
  'lastActivityAt',
  'search',
  'order',
  // The Matters board's card order (CORE-04).
  'boardOrder',
  // Contacts (CORE-01): recomputed by contacts-onWrite; roles in matters by contacts-onPartyWrite (CORE-01a).
  'dedupeKey',
  'sortName',
  'matterRoles',
  // Documents (AI-04): Clerk ingestion progress, written by documents-ingest.
  'ingest',
]);

/** Bookkeeping fields: never listed as changes. */
export const META_FIELDS = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'schemaVersion', '_requestId']);

/** Free-text fields stored as `{ len, sha256 }`: the audit proves what changed without copying it. */
export const HASHED_FIELDS = new Set([
  'bodyMd',
  'narrative',
  'descriptionMd',
  'body',
  'content',
  'text',
  'notes',
  'quote',
  'prompt',
  'transcript',
]);

/** Secrets: dropped from the audit entirely. */
export const DROPPED_FIELDS = new Set([
  'encryptedRefreshToken',
  // Clerk BYOK (AI-02a).
  'encryptedApiKey',
  'apiKey',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'password',
  'secret',
]);

/** Any other string longer than this is hashed too. */
export const LONG_TEXT_CHARS = 280;

const MAX_DEPTH = 8;

/** Equality for Firestore values: Timestamps, GeoPoints and references by `isEqual`, the rest structurally. */
export function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (depth > MAX_DEPTH) return false;
  const isEqual = (a as { isEqual?: (other: unknown) => boolean }).isEqual;
  if (typeof isEqual === 'function') return isEqual.call(a, b);
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i], depth + 1))
    );
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.hasOwn(b, k) && sameValue((a as DocData)[k], (b as DocData)[k], depth + 1))
  );
}

const isNullish = (value: unknown) => value === undefined || value === null;

/**
 * Top-level fields that differ between two versions of a document (meta fields excluded), sorted.
 * A missing field and `null` are the same (a live matter gains `deletedAt: null`, CORE-03).
 */
export function changedFields(before: DocData | undefined, after: DocData | undefined): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((key) => !META_FIELDS.has(key))
    .filter((key) => !(isNullish(before?.[key]) && isNullish(after?.[key])) && !sameValue(before?.[key], after?.[key]))
    .sort();
}

const isDeleted = (data: DocData | undefined) => data?.['deletedAt'] !== undefined && data?.['deletedAt'] !== null;

export function classifyWrite(before: DocData | undefined, after: DocData | undefined): AuditWriteAction | null {
  if (!before && !after) return null;
  if (!before) return 'create';
  if (!after) return 'delete';
  if (!isDeleted(before) && isDeleted(after)) return 'soft_delete';
  if (isDeleted(before) && !isDeleted(after)) return 'restore';
  return 'update';
}

export function hashText(text: string): { len: number; sha256: string } {
  return { len: text.length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** Redacts one value: secrets dropped (undefined), free text and long strings hashed, recursively. */
export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (DROPPED_FIELDS.has(key)) return undefined;
  if (typeof value === 'string')
    return HASHED_FIELDS.has(key) || value.length > LONG_TEXT_CHARS ? hashText(value) : value;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (typeof (value as { isEqual?: unknown }).isEqual === 'function' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item, depth + 1));
  return redactFields(value as DocData, Object.keys(value), depth + 1);
}

/** The listed fields of a document, redacted. */
export function redactFields(data: DocData, fields: readonly string[], depth = 0): DocData {
  const out: DocData = {};
  for (const field of fields) {
    if (!Object.hasOwn(data, field)) continue;
    const value = redactValue(field, data[field], depth);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** `'system'` and `'clerk'` write as themselves; anything else is a member uid. */
export function toActor(value: unknown): AuditActor {
  if (value === 'system' || value === 'clerk') return value;
  return typeof value === 'string' && value ? { uid: value } : 'system';
}

/** Where an entity sits: its collection and id, and its matter when it is one or belongs to one. */
export interface AuditEntity {
  path: string;
  collection?: string;
  id?: string;
  matterId?: string;
}

/** Parses `orgs/{orgId}/{collection}/{id}` or `orgs/{orgId}/matters/{matterId}/{sub}/{id}`. */
export function entityFromPath(path: string): AuditEntity {
  const parts = path.split('/');
  const entity: AuditEntity = { path };
  if (parts.length >= 4) {
    entity.collection = parts[parts.length - 2] as string;
    entity.id = parts[parts.length - 1] as string;
  }
  if (parts[2] === 'matters' && parts[3]) entity.matterId = parts[3];
  return entity;
}

export interface WriteInput {
  path: string;
  before: DocData | undefined;
  after: DocData | undefined;
  at: Date;
  expireAt: Date;
}

/** The audit document for a write, or null when the write is not audited (and why). */
export function buildWriteEntry(input: WriteInput): { entry: DocData } | { skip: string } {
  const entity = entityFromPath(input.path);
  if (entity.collection && EXCLUDED_COLLECTIONS.has(entity.collection)) return { skip: 'excluded collection' };
  const action = classifyWrite(input.before, input.after);
  if (!action) return { skip: 'no data' };
  const changed = changedFields(input.before, input.after);
  if (action === 'update') {
    if (!changed.length) return { skip: 'meta only' };
    if (changed.every((field) => NOISE_FIELDS.has(field))) return { skip: 'denormalised fields only' };
  }
  const { before, after } = input;
  const actorField =
    action === 'delete'
      ? (before?.['deletedBy'] ?? before?.['updatedBy'])
      : action === 'soft_delete'
        ? (after?.['deletedBy'] ?? after?.['updatedBy'])
        : after?.['updatedBy'];
  const actor = toActor(actorField);
  const latest = after ?? before ?? {};
  const requestId = typeof latest['_requestId'] === 'string' ? latest['_requestId'] : undefined;
  const runId = (after?.['migration'] as { runId?: unknown } | undefined)?.runId;
  const migrated = typeof runId === 'string' && (action === 'create' || changed.includes('migration'));
  const source: AuditSource = migrated
    ? 'migration'
    : requestId
      ? 'callable'
      : actor === 'system' || actor === 'clerk'
        ? 'trigger'
        : 'client';
  const actorString = typeof actor === 'string' ? actor : actor.uid;

  const entry: DocData = {
    at: input.at,
    actor,
    action,
    entity,
    changedFields: changed,
    source,
    expireAt: input.expireAt,
    createdAt: input.at,
    createdBy: actorString,
    updatedAt: input.at,
    updatedBy: actorString,
    schemaVersion: 1,
  };
  if (before) entry['before'] = redactFields(before, changed);
  if (after) entry['after'] = redactFields(after, changed);
  if (requestId) entry['requestId'] = requestId;
  if (migrated) entry['runId'] = runId;
  return { entry };
}

/** `at` plus the org's retention, in calendar years. */
export function expiryFor(at: Date, retentionYears: number): Date {
  const expiry = new Date(at.getTime());
  expiry.setUTCFullYear(expiry.getUTCFullYear() + retentionYears);
  return expiry;
}
