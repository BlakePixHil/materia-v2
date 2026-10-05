import { Timestamp } from 'firebase-admin/firestore';

import { FakeDb } from './fake.ts';
import { canonical, countByCollection, diffSubtrees, readSubtree, sameData } from './subtree.ts';

const M = 'orgs/o1/matters/m1';

describe('readSubtree', () => {
  it('reads the root and every document under it, walking through missing parents', async () => {
    const db = new FakeDb({
      [M]: { number: 'W-2026-0001' },
      [`${M}/tasks/t1`]: { title: 'Fictional task' },
      // documents/d1 itself is missing; its chunk is still found.
      [`${M}/documents/d1/chunks/0`]: { text: 'chunk' },
      'orgs/o1/matters/m2': { number: 'W-2026-0002' },
    });
    const docs = await readSubtree(db, M);
    expect([...docs.keys()].sort()).toEqual([M, `${M}/documents/d1/chunks/0`, `${M}/tasks/t1`]);
  });

  it('returns nothing for a matter that isn’t there', async () => {
    expect((await readSubtree(new FakeDb(), M)).size).toBe(0);
  });
});

describe('canonical', () => {
  it('compares timestamps by value and ignores key order', () => {
    const a = { at: Timestamp.fromMillis(1_000), b: 1, a: [1, { y: 2, x: 1 }] };
    const b = { a: [1, { x: 1, y: 2 }], b: 1, at: new Timestamp(1, 0) };
    expect(sameData(a, b)).toBe(true);
    expect(sameData(a, { ...b, at: Timestamp.fromMillis(2_000) })).toBe(false);
  });

  it('turns references, bytes, vectors and geopoints into plain values', () => {
    const ref = { path: 'orgs/o1', id: 'o1', firestore: {} };
    const vector = { toArray: () => [0.1, 0.2] };
    const geo = { latitude: -38.15, longitude: 144.36, isEqual: () => true };
    expect(canonical({ ref, bytes: new Uint8Array([1, 2]), vector, geo })).toEqual({
      bytes: { $bytes: 'AQI=' },
      geo: { $geo: [-38.15, 144.36] },
      ref: { $ref: 'orgs/o1' },
      vector: { $vector: [0.1, 0.2] },
    });
  });
});

describe('diffSubtrees', () => {
  it('splits documents into create, overwrite, unchanged and added since', () => {
    const source = new Map([
      ['a/1', { v: 1 }],
      ['a/2', { v: 2 }],
      ['a/3', { v: 3 }],
    ]);
    const target = new Map([
      ['a/2', { v: 2 }],
      ['a/3', { v: 30 }],
      ['a/4', { v: 4 }],
    ]);
    expect(diffSubtrees(source, target)).toEqual({
      create: ['a/1'],
      overwrite: ['a/3'],
      unchanged: ['a/2'],
      extra: ['a/4'],
    });
  });

  it('counts by collection id', () => {
    expect(countByCollection([M, `${M}/tasks/t1`, `${M}/tasks/t2`])).toEqual({ matters: 1, tasks: 2 });
  });
});
