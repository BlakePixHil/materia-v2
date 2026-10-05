import { FieldPath, Timestamp, type Query } from 'firebase-admin/firestore';
import { z } from 'zod';

import { can, DocIdSchema, DomainError, PERMISSIONS } from '@materia/domain';

import { audit } from './audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireRecentLogin } from '../core/user-callable';

const AuditFilters = {
  /** Entries for one document (`orgs/{orgId}/matters/{id}/tasks/{taskId}`). */
  entityPath: z.string().min(1).max(1500).optional(),
  /** Entries for a matter and everything under it. Required for members without `audit.view`. */
  matterId: DocIdSchema.optional(),
  actorUid: DocIdSchema.optional(),
  /** One kind of entity, by its collection (`matters`, `members`, …; CORE-21). */
  collection: z
    .string()
    .regex(/^[A-Za-z]{1,40}$/)
    .optional(),
  /** One action (`update`, `member.role_changed`, …; CORE-21). */
  action: z
    .string()
    .regex(/^[a-z][a-z_.]{0,79}$/)
    .optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
};

export const AuditQueryInput = z
  .object({
    ...AuditFilters,
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .refine((input) => !(input.entityPath && input.matterId), {
    message: 'Use entityPath or matterId, not both',
    path: ['matterId'],
  });

export interface AuditQueryEntry {
  id: string;
  at: string;
  actor: { uid: string } | 'system' | 'clerk';
  action: string;
  entity: { path: string; collection?: string; id?: string; matterId?: string };
  changedFields?: string[];
  summary?: string;
  source: string;
  requestId?: string;
  /** Only for roles with `audit.view`: field values can include privileged material. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface AuditQueryResult {
  entries: AuditQueryEntry[];
  nextCursor: string | null;
}

interface Cursor {
  at: number;
  id: string;
}

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.at === 'number' && typeof parsed.id === 'string') return { at: parsed.at, id: parsed.id };
  } catch {
    // Falls through to the error below.
  }
  throw new DomainError('INVALID_ARGUMENT', 'Invalid cursor', { fields: { cursor: ['Invalid cursor'] } });
}

const toIso = (value: unknown) => (value instanceof Timestamp ? value.toDate().toISOString() : String(value));

/**
 * `audit-query` (FND-18): reads the audit log, newest first, 50 at a time. Owners and admins can
 * query the whole org and see redacted before/after values. Everyone else can read one visible
 * matter's entries (what changed and who changed it, without values), for the activity feed.
 */
export const auditQueryDefinition = {
  name: 'audit-query',
  input: AuditQueryInput,
  roles: PERMISSIONS['matter.view'],
  handler: async ({ input, orgId, role, db }): Promise<AuditQueryResult> => {
    const orgWide = can(role, 'audit.view');
    if (input.entityPath && !input.entityPath.startsWith(`orgs/${orgId}/`)) {
      throw new DomainError('INVALID_ARGUMENT', 'entityPath is not in your organisation', {
        fields: { entityPath: ['Not in your organisation'] },
      });
    }
    if (!orgWide) {
      const matterPath = input.matterId ? `orgs/${orgId}/matters/${input.matterId}` : undefined;
      const scoped = matterPath ?? input.entityPath?.match(/^orgs\/[^/]+\/matters\/[^/]+/)?.[0];
      if (!scoped) throw new DomainError('PERMISSION_DENIED', 'Choose a matter to see its history');
      const matter = await db.doc(scoped).get();
      if (!matter.exists) throw new DomainError('NOT_FOUND', 'Matter not found');
      if (matter.get('privileged') === true && !can(role, 'privileged.view')) {
        throw new DomainError('PERMISSION_DENIED', 'This matter is privileged');
      }
    }

    let query = filtered(db.collection(`orgs/${orgId}/audit`), input);
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      query = query.startAfter(Timestamp.fromMillis(cursor.at), cursor.id);
    }
    const snapshot = await query.limit(input.limit + 1).get();
    const docs = snapshot.docs.slice(0, input.limit);
    const entries = docs.map((doc): AuditQueryEntry => {
      const data = doc.data();
      const entry: AuditQueryEntry = {
        id: doc.id,
        at: toIso(data['at']),
        actor: data['actor'] as AuditQueryEntry['actor'],
        action: data['action'] as string,
        entity: data['entity'] as AuditQueryEntry['entity'],
        source: data['source'] as string,
      };
      if (data['changedFields']) entry.changedFields = data['changedFields'] as string[];
      if (data['summary']) entry.summary = data['summary'] as string;
      if (data['requestId']) entry.requestId = data['requestId'] as string;
      if (orgWide) {
        for (const key of ['before', 'after', 'data'] as const) {
          if (data[key]) entry[key] = jsonSafe(data[key]) as Record<string, unknown>;
        }
      }
      return entry;
    });
    const last = docs.at(-1);
    const nextCursor =
      snapshot.docs.length > input.limit && last
        ? encodeCursor({ at: (last.get('at') as Timestamp).toMillis(), id: last.id })
        : null;
    return { entries, nextCursor };
  },
} satisfies CallableDefinition<typeof AuditQueryInput, AuditQueryResult>;

/** The audit collection with the filters applied, newest first. */
function filtered(base: Query, input: z.infer<z.ZodObject<typeof AuditFilters>>): Query {
  let query = base;
  if (input.entityPath) query = query.where('entity.path', '==', input.entityPath);
  if (input.matterId) query = query.where('entity.matterId', '==', input.matterId);
  if (input.collection) query = query.where('entity.collection', '==', input.collection);
  if (input.action) query = query.where('action', '==', input.action);
  if (input.actorUid) query = query.where('actor.uid', '==', input.actorUid);
  if (input.from) query = query.where('at', '>=', Timestamp.fromDate(new Date(input.from)));
  if (input.to) query = query.where('at', '<=', Timestamp.fromDate(new Date(input.to)));
  return query.orderBy('at', 'desc').orderBy(FieldPath.documentId(), 'desc');
}

/** Rows an export holds at most; narrow the filters for more. */
export const AUDIT_EXPORT_MAX_ROWS = 5000;
export const AuditExportInput = z.object(AuditFilters);

const CSV_COLUMNS = ['at', 'actor', 'action', 'collection', 'entity', 'changedFields', 'summary', 'source'] as const;

/** One CSV cell: quoted when needed, and never starting a formula (`=`, `+`, `-`, `@`). */
export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * `audit-exportCsv` (CORE-21): the filtered audit log as CSV, newest first, up to
 * AUDIT_EXPORT_MAX_ROWS rows, for owners who signed in within the last five minutes. The export
 * lists what changed and who changed it, without field values. Audited itself.
 */
export const auditExportDefinition = {
  name: 'audit-exportCsv',
  input: AuditExportInput,
  roles: ['owner'],
  handler: async (ctx): Promise<{ csv: string; rows: number; truncated: boolean }> => {
    const { input, orgId, db, token, clock } = ctx;
    requireRecentLogin(token, clock.now().getTime(), 5);
    if (input.entityPath && !input.entityPath.startsWith(`orgs/${orgId}/`)) {
      throw new DomainError('INVALID_ARGUMENT', 'entityPath is not in your organisation');
    }
    const snap = await filtered(db.collection(`orgs/${orgId}/audit`), input)
      .limit(AUDIT_EXPORT_MAX_ROWS + 1)
      .get();
    const docs = snap.docs.slice(0, AUDIT_EXPORT_MAX_ROWS);
    const lines = docs.map((doc) => {
      const data = doc.data();
      const actor = data['actor'] as AuditQueryEntry['actor'];
      const entity = (data['entity'] ?? {}) as AuditQueryEntry['entity'];
      const row = {
        at: toIso(data['at']),
        actor: typeof actor === 'string' ? actor : actor?.uid,
        action: data['action'],
        collection: entity.collection,
        entity: entity.path,
        changedFields: ((data['changedFields'] as string[] | undefined) ?? []).join(' '),
        summary: data['summary'],
        source: data['source'],
      };
      return CSV_COLUMNS.map((column) => csvCell(row[column])).join(',');
    });
    await audit(ctx, {
      action: 'audit.exported',
      entity: { path: `orgs/${orgId}/members/${ctx.uid}` },
      summary: `Audit log exported (${docs.length} rows)`,
      data: { rows: docs.length },
    });
    return {
      csv: [CSV_COLUMNS.join(','), ...lines].join('\r\n'),
      rows: docs.length,
      truncated: snap.docs.length > AUDIT_EXPORT_MAX_ROWS,
    };
  },
} satisfies CallableDefinition<typeof AuditExportInput, { csv: string; rows: number; truncated: boolean }>;

/** Timestamps become ISO strings so the callable's JSON response stays readable. */
function jsonSafe(value: unknown, depth = 0): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, jsonSafe(v, depth + 1)]));
}

export const query = defineCallable(auditQueryDefinition);
export const exportCsv = defineCallable(auditExportDefinition);
