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
  timeEntries: domain.TimeEntry,
  chunks: domain.Chunk,
  audit: domain.AuditEntry,
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
});
