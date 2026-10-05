import * as D from '@materia/domain';

import { backfillSearchTokens, parseArgs, type BackfillStore } from './search-tokens.ts';
import { unwrap } from '../seed/interop.ts';

const domain = unwrap(D);

/** The search-tokens backfill (CORE-15) against an in-memory store. Everything is fictional. */

type Data = Record<string, unknown>;

/** Collection groups by their last collection id, paged by path as the Admin SDK store does. */
class FakeStore implements BackfillStore {
  readonly docs = new Map<string, Data>();
  writes = 0;
  pages = 0;

  set(path: string, data: Data): void {
    this.docs.set(path, data);
  }

  async page(group: string, after: string | null, limit: number) {
    this.pages++;
    return [...this.docs.keys()]
      .filter((path) => path.split('/').at(-2) === group)
      .sort()
      .filter((path) => after === null || path > after)
      .slice(0, limit)
      .map((path) => ({ path, data: structuredClone(this.docs.get(path) as Data) }));
  }

  async getAll(paths: readonly string[]) {
    return paths.map((path) => this.docs.get(path) ?? null);
  }

  async update(writes: readonly { path: string; patch: Data }[]) {
    for (const { path, patch } of writes) {
      this.writes++;
      this.docs.set(path, { ...(this.docs.get(path) as Data), ...patch });
    }
  }
}

function seed(): FakeStore {
  const store = new FakeStore();
  store.set('orgs/org-a/contacts/c-zoe', { kind: 'person', givenNames: 'Zoë', familyName: 'Ångström', search: ['zo'] });
  store.set('orgs/org-b/contacts/c-zoe', { kind: 'person', givenNames: 'Other', familyName: 'Person' });
  for (let i = 1; i <= 7; i++) {
    const number = `M-2026-${String(140 + i).padStart(4, '0')}`;
    store.set(`orgs/org-a/matters/m-${i}`, {
      number,
      title: `Estate of Example ${i}`,
      clientContactIds: ['c-zoe'],
      // CORE-03's tokens: no number parts, no client.
      search: ['es', 'est', 'estate'],
    });
  }
  store.set('orgs/org-a/matters/m-1/tasks/t-1', { title: 'Lodge the inventory' });
  store.set('orgs/org-a/members/u-1/tasks/p-1', { title: 'Call the registry', search: [] });
  store.set('orgs/org-a/matters/m-1/documents/d-1', { name: 'Grant of probate.pdf' });
  store.set('users/u-1/recent/org-a_m-1', { orgId: 'org-a', matterId: 'm-1' });
  store.set('users/u-1/recent/org-a_contact_c-zoe', { orgId: 'org-a', kind: 'contact', entityId: 'c-zoe' });
  return store;
}

describe('backfillSearchTokens', () => {
  it('brings every search array up to the tokeniser, with matters’ clients from their own org', async () => {
    const store = seed();
    const report = await backfillSearchTokens(store, { pageSize: 3 });
    expect(report).toEqual({
      matters: { read: 7, updated: 7 },
      contacts: { read: 2, updated: 2 },
      tasks: { read: 2, updated: 2 },
      documents: { read: 1, updated: 1 },
      recent: { read: 2, updated: 1 },
    });
    const m1 = store.docs.get('orgs/org-a/matters/m-1') as Data;
    expect(m1['search']).toEqual(
      domain.matterSearchTokens({ number: 'M-2026-0141', title: 'Estate of Example 1', clientNames: ['Zoë Ångström'] }),
    );
    expect(m1['search']).toEqual(expect.arrayContaining(['141', '20260141', 'angstrom']));
    expect(m1['search']).not.toContain('other');
    expect((store.docs.get('orgs/org-a/matters/m-1/tasks/t-1') as Data)['search']).toContain('inventory');
    expect((store.docs.get('orgs/org-a/matters/m-1/documents/d-1') as Data)['search']).toContain('probate');
    expect(store.docs.get('users/u-1/recent/org-a_m-1')).toMatchObject({ kind: 'matter', matterId: 'm-1' });
    expect(store.docs.get('users/u-1/recent/org-a_contact_c-zoe')).toMatchObject({ kind: 'contact' });
  });

  it('is idempotent: a second run reads everything and writes nothing', async () => {
    const store = seed();
    await backfillSearchTokens(store, { pageSize: 2 });
    const before = JSON.stringify([...store.docs]);
    const writes = store.writes;
    const report = await backfillSearchTokens(store, { pageSize: 2 });
    expect(store.writes).toBe(writes);
    expect(JSON.stringify([...store.docs])).toBe(before);
    expect(Object.values(report).every((counts) => counts.updated === 0)).toBe(true);
    expect(report.matters.read).toBe(7);
  });

  it('counts without writing on a dry run, and logs counts only', async () => {
    const store = seed();
    const lines: string[] = [];
    const report = await backfillSearchTokens(store, { dryRun: true, log: (line) => lines.push(line) });
    expect(store.writes).toBe(0);
    expect(report.matters.updated).toBe(7);
    expect(lines).toContain('matters: 7 read, 7 to update');
    expect(lines.join('\n')).not.toMatch(/zo[eë]|example/i);
  });

  it('parses its options', () => {
    expect(parseArgs(['--project', 'demo-materia', '--dry-run'])).toEqual({
      project: 'demo-materia',
      dryRun: true,
      pageSize: 300,
    });
    expect(() => parseArgs(['--project', 'demo-materia', '--page-size', '0'])).toThrow(/page-size/);
  });
});
