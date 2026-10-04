import { FieldPath, Timestamp, type Query } from 'firebase-admin/firestore';
import { z } from 'zod';

import { can, DocIdSchema, DomainError, PERMISSIONS } from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';

export const AuditQueryInput = z
  .object({
    /** Entries for one document (`orgs/{orgId}/matters/{id}/tasks/{taskId}`). */
    entityPath: z.string().min(1).max(1500).optional(),
    /** Entries for a matter and everything under it. Required for members without `audit.view`. */
    matterId: DocIdSchema.optional(),
    actorUid: DocIdSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
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

    let query: Query = db.collection(`orgs/${orgId}/audit`);
    if (input.entityPath) query = query.where('entity.path', '==', input.entityPath);
    if (input.matterId) query = query.where('entity.matterId', '==', input.matterId);
    if (input.actorUid) query = query.where('actor.uid', '==', input.actorUid);
    if (input.from) query = query.where('at', '>=', Timestamp.fromDate(new Date(input.from)));
    if (input.to) query = query.where('at', '<=', Timestamp.fromDate(new Date(input.to)));
    query = query.orderBy('at', 'desc').orderBy(FieldPath.documentId(), 'desc');
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

/** Timestamps become ISO strings so the callable's JSON response stays readable. */
function jsonSafe(value: unknown, depth = 0): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, jsonSafe(v, depth + 1)]));
}

export const query = defineCallable(auditQueryDefinition);
