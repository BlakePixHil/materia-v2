import * as z from 'zod';

import {
  adminConverter,
  firestoreConverter,
  fromFirestoreValue,
  InvalidDocumentError,
  SchemaVersionError,
  toFirestoreValue,
  type SnapshotLike,
} from './converter';

const Thing = {
  schema: z.object({ name: z.string(), at: z.date(), tags: z.array(z.string()), schemaVersion: z.number() }).strict(),
  version: 2,
};

/** Mimics a Firestore Timestamp and a VectorValue. */
const timestamp = (date: Date) => ({ toDate: () => date });
const vector = (values: number[]) => ({ toArray: () => values });
const snapshot = (data: Record<string, unknown>, id = 'doc-1'): SnapshotLike => ({ id, data: () => data });

describe('firestore converters', () => {
  const at = new Date('2026-10-03T00:00:00Z');

  it('maps Timestamps and vectors to Dates and arrays, recursively', () => {
    expect(fromFirestoreValue({ a: timestamp(at), b: [timestamp(at)], v: vector([1, 2]), d: at, n: null })).toEqual({
      a: at,
      b: [at],
      v: [1, 2],
      d: at,
      n: null,
    });
  });

  it('drops undefined on write and keeps Dates', () => {
    expect(toFirestoreValue({ a: undefined, b: at, c: [{ d: undefined, e: 1 }], f: null })).toEqual({
      b: at,
      c: [{ e: 1 }],
      f: null,
    });
  });

  it('upgrades old documents lazily and validates them', () => {
    const converter = firestoreConverter(Thing, {
      upgrades: {
        1: ({ labels, ...rest }) => ({ ...rest, tags: labels ?? [] }),
      },
    });
    const result = converter.fromFirestore(snapshot({ name: 'x', at: timestamp(at), labels: ['a'], schemaVersion: 1 }));
    expect(result).toEqual({ name: 'x', at, tags: ['a'], schemaVersion: 2 });
  });

  it('throws for documents newer than the app', () => {
    const converter = firestoreConverter(Thing);
    expect(() => converter.fromFirestore(snapshot({ schemaVersion: 3 }))).toThrow(SchemaVersionError);
    expect(() => converter.fromFirestore(snapshot({ schemaVersion: 1 }))).toThrow(/No upgrade registered/);
  });

  it('is strict by default and lenient on request', () => {
    const bad = snapshot({ name: 5, at: timestamp(at), tags: [], schemaVersion: 2 });
    expect(() => firestoreConverter(Thing).fromFirestore(bad)).toThrow(InvalidDocumentError);

    const onInvalid = vi.fn();
    const lenient = adminConverter(Thing, { mode: 'lenient', onInvalid });
    const result = lenient.fromFirestore(bad) as unknown as { _invalid: string[] };
    expect(result._invalid).toEqual(['name: invalid_type']);
    expect(onInvalid).toHaveBeenCalledWith({ id: 'doc-1', issues: ['name: invalid_type'] });
  });

  it('validates writes', () => {
    const converter = firestoreConverter(Thing);
    expect(converter.toFirestore({ name: 'x', at, tags: [], schemaVersion: 2 })).toEqual({
      name: 'x',
      at,
      tags: [],
      schemaVersion: 2,
    });
    expect(() => converter.toFirestore({ name: 'x' } as never)).toThrow();
  });
});
