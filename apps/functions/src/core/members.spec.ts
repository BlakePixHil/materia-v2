import type { Firestore } from 'firebase-admin/firestore';

import { cachedMemberLookup } from './members';
import { FakeClock } from '../ports/fakes';

function fakeDb(statuses: Record<string, string | undefined>) {
  const reads: string[] = [];
  const db = {
    doc: (path: string) => ({
      get: async () => {
        reads.push(path);
        const status = statuses[path];
        return { exists: status !== undefined, get: (field: string) => (field === 'status' ? status : undefined) };
      },
    }),
  } as unknown as Firestore;
  return { db, reads, statuses };
}

describe('cachedMemberLookup', () => {
  it('answers from members/{uid} and caches for 60 seconds', async () => {
    const clock = new FakeClock();
    const { db, reads, statuses } = fakeDb({ 'orgs/o/members/a': 'active', 'orgs/o/members/s': 'suspended' });
    const lookup = cachedMemberLookup(() => db, clock);

    expect(await lookup('o', 'a')).toBe(true);
    expect(await lookup('o', 's')).toBe(false);
    expect(await lookup('o', 'missing')).toBe(false);
    expect(await lookup('o', 'a')).toBe(true);
    expect(reads).toHaveLength(3);

    statuses['orgs/o/members/a'] = 'suspended';
    clock.advance(59_000);
    expect(await lookup('o', 'a')).toBe(true);
    clock.advance(2_000);
    expect(await lookup('o', 'a')).toBe(false);

    lookup.clear();
    await lookup('o', 's');
    expect(reads).toHaveLength(5);
  });
});
