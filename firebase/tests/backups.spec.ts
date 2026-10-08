import { readFileSync } from 'node:fs';
import path from 'node:path';

import { EXPORT_SKIPPED_COLLECTIONS, FIRESTORE_COLLECTION_IDS, SERVER_ONLY_COLLECTION_IDS } from '@materia/domain';

/**
 * SEC-07h: the nightly export lists the collections it takes, so it must know every one. Checked
 * offline against firestore.rules, which has a `match` block for every collection people read (the
 * rules suite checks that side): add a collection to FIRESTORE_COLLECTION_IDS when you add a `match`
 * block, or to SERVER_ONLY_COLLECTION_IDS when only functions use it.
 */
const rules = readFileSync(path.resolve(import.meta.dirname, '../firestore.rules'), 'utf8');
const ruled = [...new Set([...rules.matchAll(/match \/([A-Za-z]+)\//g)].map((m) => m[1] as string))]
  .filter((name) => name !== 'databases')
  .sort();

describe('the nightly export’s collections (SEC-07h)', () => {
  it('knows every collection that has a match block, and otherwise only server-only ones', () => {
    const listed = FIRESTORE_COLLECTION_IDS.filter((id) => !SERVER_ONLY_COLLECTION_IDS.includes(id)).sort();
    expect(listed).toEqual(ruled);
    expect(SERVER_ONLY_COLLECTION_IDS.filter((id) => ruled.includes(id))).toEqual([]);
  });

  it('leaves out only collections it knows', () => {
    expect(EXPORT_SKIPPED_COLLECTIONS.filter((id) => !ruled.includes(id))).toEqual([]);
  });
});
