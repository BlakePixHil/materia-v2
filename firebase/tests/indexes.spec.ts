import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as domain from '@materia/domain';

import { COLLECTIONS } from './support/collections';

/**
 * FND-14: firestore.indexes.json can only be validated by deploying it (an owner step), so this
 * checks what can be checked offline: every index targets a known collection and fields the
 * domain schema defines, and the chunks vector index matches the embedding size.
 */
interface IndexField {
  fieldPath: string;
  order?: string;
  arrayConfig?: string;
  vectorConfig?: { dimension: number; flat: object };
}
const file = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../firestore.indexes.json'), 'utf8')) as {
  indexes: { collectionGroup: string; queryScope: string; fields: IndexField[] }[];
  fieldOverrides: { collectionGroup: string; fieldPath: string }[];
};

const ENTITY_FOR: Record<string, { schema: { shape: Record<string, unknown> } }> = {
  matters: domain.Matter,
  tasks: domain.Task,
  deadlines: domain.Deadline,
  deadlineChanges: domain.DeadlineChange,
  timeEntries: domain.TimeEntry,
  chunks: domain.Chunk,
  audit: domain.AuditEntry,
  invites: domain.Invite,
  members: domain.Member,
  contacts: domain.Contact,
  parties: domain.Party,
  conflictChecks: domain.ConflictCheck,
  recent: domain.RecentMatter,
  documents: domain.MatterDocument,
  notes: domain.Note,
  revisions: domain.NoteRevision,
  // A union of kinds: every kind shares these fields (FND-20).
  notifications: { schema: { shape: { ...domain.NotificationPayloadSchema.options[0].shape, ...domain.MetaShape } } },
} as never;

describe('firestore.indexes.json', () => {
  const known = new Set(COLLECTIONS.map((spec) => spec.collection.split(' ')[0]));

  it.each(
    file.indexes.map(
      (index) => [`${index.collectionGroup}(${index.fields.map((f) => f.fieldPath).join(', ')})`, index] as const,
    ),
  )('%s targets a known collection and schema fields', (_label, index) => {
    expect(known.has(index.collectionGroup)).toBe(true);
    expect(['COLLECTION', 'COLLECTION_GROUP']).toContain(index.queryScope);
    const shape = ENTITY_FOR[index.collectionGroup]?.schema.shape;
    expect(shape, `schema for ${index.collectionGroup}`).toBeDefined();
    // Nested fields (`entity.matterId`) are checked by their top-level field.
    for (const field of index.fields) expect(Object.keys(shape ?? {})).toContain(field.fieldPath.split('.')[0]);
  });

  it('collection-group indexes exist for tasks, deadlines and timeEntries (Domain doc)', () => {
    const groups = file.indexes.filter((i) => i.queryScope === 'COLLECTION_GROUP').map((i) => i.collectionGroup);
    for (const group of ['tasks', 'deadlines', 'timeEntries', 'chunks']) expect(groups).toContain(group);
    // The sign-up gate finds a pending invite for an email across orgs (FND-16).
    expect(groups).toContain('invites');
  });

  it('reminders-dispatch finds due reminders, and Today finds escalations, through group indexes (CORE-11)', () => {
    const deadlines = file.indexes
      .filter((i) => i.collectionGroup === 'deadlines' && i.queryScope === 'COLLECTION_GROUP')
      .map((i) => i.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(','));
    expect(deadlines).toContain('orgId:ASCENDING,nextReminderAt:ASCENDING');
    expect(deadlines).toContain('orgId:ASCENDING,escalatedTo:CONTAINS,status:ASCENDING,dueDate:ASCENDING');
    // Escalation candidates: orgId, status, critical and a dueDate range.
    expect(deadlines).toContain('orgId:ASCENDING,status:ASCENDING,critical:ASCENDING,dueDate:ASCENDING');
  });

  it('contacts sort by sortName under each list filter, and parties are found by contact (CORE-01)', () => {
    const contacts = file.indexes
      .filter((i) => i.collectionGroup === 'contacts')
      .map((i) => i.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(','));
    expect(contacts).toEqual([
      'kind:ASCENDING,sortName:ASCENDING',
      'isReferrer:ASCENDING,sortName:ASCENDING',
      'tags:CONTAINS,sortName:ASCENDING',
      'search:CONTAINS,sortName:ASCENDING',
      // ⌘K's contacts, most recently updated first (CORE-15).
      'search:CONTAINS,updatedAt:DESCENDING',
    ]);
    const parties = file.indexes.find((i) => i.collectionGroup === 'parties');
    expect(parties?.queryScope).toBe('COLLECTION_GROUP');
    expect(parties?.fields.map((f) => f.fieldPath)).toEqual(['orgId', 'contactId']);
  });

  it('a matter’s conflict checks are listed newest first (CORE-02)', () => {
    const checks = file.indexes.filter((i) => i.collectionGroup === 'conflictChecks');
    expect(checks.map((i) => i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(','))).toEqual([
      'excludeMatterId:ASCENDING,ranAt:DESCENDING',
    ]);
  });

  it('indexes every Matters list query in MATTER_INDEXED_QUERIES, with and without privileged (CORE-03)', () => {
    const key = (fields: IndexField[]) => fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(',');
    const matters = file.indexes.filter((i) => i.collectionGroup === 'matters');
    for (const index of matters) expect(index.queryScope).toBe('COLLECTION');
    const expected = domain.MATTER_INDEXED_QUERIES.flatMap((query) =>
      [false, true].map((withPrivileged) => key(domain.matterIndexFields(query, withPrivileged))),
    );
    // Exactly the list's queries: nothing missing, nothing stale.
    expect(matters.map((index) => key(index.fields)).sort()).toEqual([...expected].sort());
    // Every one starts with the live-matter filter.
    for (const index of matters) expect(index.fields[0]?.fieldPath).toBe('deletedAt');
  });

  it('a matter’s documents list newest first, and readonly’s non-privileged list is indexed (CORE-12)', () => {
    const documents = file.indexes
      .filter((i) => i.collectionGroup === 'documents')
      .map((i) => `${i.queryScope}:${i.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(',')}`);
    expect(documents).toEqual([
      'COLLECTION:privileged:ASCENDING,createdAt:DESCENDING',
      // ⌘K (CORE-15): the open matter's non-privileged documents, and every document in the org.
      'COLLECTION:privileged:ASCENDING,search:CONTAINS,updatedAt:DESCENDING',
      'COLLECTION_GROUP:orgId:ASCENDING,search:CONTAINS,updatedAt:DESCENDING',
    ]);
  });

  it('indexes the ⌘K providers’ queries: my tasks and every matter task by token (CORE-15)', () => {
    const tasks = file.indexes
      .filter((i) => i.collectionGroup === 'tasks')
      .map((i) => `${i.queryScope}:${i.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(',')}`);
    expect(tasks).toEqual(
      expect.arrayContaining([
        'COLLECTION_GROUP:orgId:ASCENDING,assigneeUid:ASCENDING,search:CONTAINS,updatedAt:DESCENDING',
        // `matterId != null` proves to the rules that no personal task is read (ADR-026).
        'COLLECTION_GROUP:orgId:ASCENDING,search:CONTAINS,matterId:ASCENDING',
      ]),
    );
    // Matters by token use the Matters list's `search` indexes (CORE-03), with and without privileged.
    expect(domain.isIndexedMatterQuery(['search'], 'lastActivityAt', 'desc')).toBe(true);
  });

  it('a matter’s notes and a note’s history, filtered to non-privileged for roles without privileged.view (CORE-13)', () => {
    const key = (group: string) =>
      file.indexes
        .filter((i) => i.collectionGroup === group)
        .map((i) => `${i.queryScope}:${i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(',')}`);
    expect(key('notes')).toEqual(['COLLECTION:privileged:ASCENDING,createdAt:DESCENDING']);
    expect(key('revisions')).toEqual(['COLLECTION:privileged:ASCENDING,editedAt:DESCENDING']);
  });

  it('a matter’s notes and a note’s history, filtered to non-privileged for roles without privileged.view (CORE-13)', () => {
    const key = (group: string) =>
      file.indexes
        .filter((i) => i.collectionGroup === group)
        .map((i) => `${i.queryScope}:${i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(',')}`);
    expect(key('notes')).toEqual(['COLLECTION:privileged:ASCENDING,createdAt:DESCENDING']);
    expect(key('revisions')).toEqual(['COLLECTION:privileged:ASCENDING,editedAt:DESCENDING']);
  });

  it('the chunks vector index is flat, 768 dimensions, with orgId and matterId pre-filters', () => {
    const vector = file.indexes.find((i) => i.collectionGroup === 'chunks');
    expect(vector?.fields.map((f) => f.fieldPath)).toEqual(['orgId', 'matterId', 'embedding']);
    expect(vector?.fields.at(-1)?.vectorConfig).toEqual({ dimension: 768, flat: {} });
  });

  // Server-only operational collections (no client rules, default deny) with TTL policies (FND-15).
  const OPERATIONAL = new Set(['requests', 'eventGuards']);

  it('field overrides target known collections', () => {
    for (const override of file.fieldOverrides) {
      expect(
        known.has(override.collectionGroup) || OPERATIONAL.has(override.collectionGroup),
        override.collectionGroup,
      ).toBe(true);
    }
  });

  it('idempotency records and event guards expire through TTL on expiresAt', () => {
    for (const group of OPERATIONAL) {
      const ttl = (file.fieldOverrides as { collectionGroup: string; fieldPath: string; ttl?: boolean }[]).find(
        (o) => o.collectionGroup === group && o.ttl,
      );
      expect(ttl?.fieldPath, group).toBe('expiresAt');
    }
  });

  it('intake drafts expire through TTL on expireAt (CORE-05)', () => {
    const ttl = (file.fieldOverrides as { collectionGroup: string; fieldPath: string; ttl?: boolean }[]).find(
      (o) => o.collectionGroup === 'drafts' && o.ttl,
    );
    expect(ttl?.fieldPath).toBe('expireAt');
  });

  it('recent entries are listed newest first per org (and per kind for Today) and expire through TTL on expireAt (CORE-14, CORE-15)', () => {
    const ttl = (file.fieldOverrides as { collectionGroup: string; fieldPath: string; ttl?: boolean }[]).find(
      (o) => o.collectionGroup === 'recent' && o.ttl,
    );
    expect(ttl?.fieldPath).toBe('expireAt');
    const recent = file.indexes.filter((i) => i.collectionGroup === 'recent');
    expect(recent.map((i) => `${i.queryScope}:${i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(',')}`)).toEqual([
      'COLLECTION:orgId:ASCENDING,updatedAt:DESCENDING',
      'COLLECTION:orgId:ASCENDING,kind:ASCENDING,updatedAt:DESCENDING',
    ]);
  });

  it('audit entries expire through TTL on expireAt, and the audit-query filters are indexed (FND-18)', () => {
    const ttl = (file.fieldOverrides as { collectionGroup: string; fieldPath: string; ttl?: boolean }[]).find(
      (o) => o.collectionGroup === 'audit' && o.ttl,
    );
    expect(ttl?.fieldPath).toBe('expireAt');
    const audit = file.indexes
      .filter((i) => i.collectionGroup === 'audit')
      .map((i) => i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(','));
    expect(audit).toEqual([
      'entity.matterId:ASCENDING,at:DESCENDING',
      'entity.path:ASCENDING,at:DESCENDING',
      'actor.uid:ASCENDING,at:DESCENDING',
      'entity.matterId:ASCENDING,actor.uid:ASCENDING,at:DESCENDING',
      'entity.path:ASCENDING,actor.uid:ASCENDING,at:DESCENDING',
    ]);
  });

  it('indexes the unread badge and the burst count, and digest records expire (FND-20)', () => {
    const notifications = file.indexes
      .filter((i) => i.collectionGroup === 'notifications')
      .map((i) => `${i.queryScope}:${i.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(',')}`);
    expect(notifications).toEqual([
      'COLLECTION:recipientUid:ASCENDING,createdAt:ASCENDING',
      'COLLECTION:recipientUid:ASCENDING,channels:CONTAINS,readAt:ASCENDING,summaryId:ASCENDING,createdAt:DESCENDING',
    ]);
    const ttl = (file.fieldOverrides as { collectionGroup: string; fieldPath: string; ttl?: boolean }[]).find(
      (o) => o.collectionGroup === 'digests' && o.ttl,
    );
    expect(ttl?.fieldPath).toBe('expireAt');
  });
});
