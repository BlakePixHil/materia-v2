import { readFileSync } from 'node:fs';
import path from 'node:path';

import { EXPORT_SKIPPED_COLLECTIONS, FIRESTORE_COLLECTION_IDS } from '@materia/domain';

/**
 * SEC-07h: the nightly export lists the collections it takes, so it must know every one. Checked
 * offline against firestore.rules, which has a `match` block for every collection (the rules suite
 * checks that side): add a collection to FIRESTORE_COLLECTION_IDS when you add a `match` block.
 */
const rules = readFileSync(path.resolve(import.meta.dirname, '../firestore.rules'), 'utf8');
const ruled = [...new Set([...rules.matchAll(/match \/([A-Za-z]+)\//g)].map((m) => m[1] as string))]
  .filter((name) => name !== 'databases')
  .sort();

describe('the nightly export’s collections (SEC-07h)', () => {
  it('knows every collection that has a match block, and no others', () => {
    expect([...FIRESTORE_COLLECTION_IDS].sort()).toEqual(ruled);
  });

  it('leaves out only collections it knows', () => {
    expect(EXPORT_SKIPPED_COLLECTIONS.filter((id) => !ruled.includes(id))).toEqual([]);
  });
});
