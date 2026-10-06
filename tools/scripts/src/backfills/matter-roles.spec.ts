import { backfillMatterRoles } from './matter-roles.ts';
import type { BackfillStore } from './search-tokens.ts';

/** The roles-in-matters backfill (CORE-01a) against an in-memory store. Everything is fictional. */

type Data = Record<string, unknown>;

class FakeStore implements BackfillStore {
  readonly docs = new Map<string, Data>();
  writes = 0;

  async page(group: string, after: string | null, limit: number) {
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
  const set = (path: string, data: Data) => store.docs.set(path, data);
  set('orgs/org-a/contacts/c-1', { kind: 'person', familyName: 'Fictional' });
  set('orgs/org-a/contacts/c-2', { kind: 'person', familyName: 'Example', matterRoles: ['client'] });
  set('orgs/org-a/contacts/c-gone', { kind: 'person', familyName: 'Merged', mergedInto: 'c-1' });
  // Same contact id in another org: its roles are its own.
  set('orgs/org-b/contacts/c-1', { kind: 'person', familyName: 'Other' });
  set('orgs/org-a/matters/m-1', { title: 'Estate of Example', deletedAt: null });
  set('orgs/org-a/matters/m-2', { title: 'Deleted matter', deletedAt: new Date() });
  set('orgs/org-a/matters/m-3', { title: 'Destroyed matter', destroyedAt: new Date() });
  set('orgs/org-a/matters/m-4', { title: 'Privileged matter', privileged: true });
  set('orgs/org-b/matters/m-1', { title: 'Other org', deletedAt: null });
  set('orgs/org-a/matters/m-1/parties/beneficiary-c-1', { contactId: 'c-1', role: 'beneficiary' });
  set('orgs/org-a/matters/m-1/parties/executor-c-1', { contactId: 'c-1', role: 'executor' });
  set('orgs/org-a/matters/m-1/parties/witness-c-1', { contactId: 'c-1', role: 'witness', deletedAt: new Date() });
  set('orgs/org-a/matters/m-2/parties/trustee-c-1', { contactId: 'c-1', role: 'trustee' });
  set('orgs/org-a/matters/m-3/parties/client-c-2', { contactId: 'c-2', role: 'client' });
  set('orgs/org-a/matters/m-4/parties/trustee-c-1', { contactId: 'c-1', role: 'trustee' });
  set('orgs/org-a/matters/m-1/parties/client-c-gone', { contactId: 'c-gone', role: 'client' });
  set('orgs/org-b/matters/m-1/parties/client-c-1', { contactId: 'c-1', role: 'client' });
  return store;
}

describe('backfillMatterRoles', () => {
  it('gives each live contact its roles on live, unprivileged matters in its own org, in Parties order', async () => {
    const store = seed();
    const lines: string[] = [];
    const report = await backfillMatterRoles(store, { pageSize: 2, log: (line) => lines.push(line) });
    expect(store.docs.get('orgs/org-a/contacts/c-1')?.['matterRoles']).toEqual(['executor', 'beneficiary']);
    expect(store.docs.get('orgs/org-a/contacts/c-2')?.['matterRoles']).toEqual([]);
    expect(store.docs.get('orgs/org-b/contacts/c-1')?.['matterRoles']).toEqual(['client']);
    expect(store.docs.get('orgs/org-a/contacts/c-gone')).not.toHaveProperty('matterRoles');
    expect(report).toEqual({ parties: 8, matters: 5, contacts: { read: 4, updated: 3 } });
    expect(lines.join('\n')).toContain('contacts: 4 read, 3 updated');
  });

  it('is idempotent, and a dry run writes nothing', async () => {
    const dry = seed();
    expect((await backfillMatterRoles(dry, { dryRun: true })).contacts.updated).toBe(3);
    expect(dry.writes).toBe(0);
    const store = seed();
    await backfillMatterRoles(store);
    const writes = store.writes;
    expect((await backfillMatterRoles(store)).contacts.updated).toBe(0);
    expect(store.writes).toBe(writes);
  });
});
