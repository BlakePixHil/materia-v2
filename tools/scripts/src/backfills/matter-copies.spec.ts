import { backfillMatterCopies, parseArgs } from './matter-copies.ts';
import type { BackfillStore } from './search-tokens.ts';

/** The matter-copy backfill (SEC-07c, SEC-07e) against an in-memory store. Everything is fictional. */

type Data = Record<string, unknown>;

/** Collection groups by their last collection id, paged by path as the Admin SDK store does. */
class FakeStore implements BackfillStore {
  readonly docs = new Map<string, Data>();
  writes = 0;

  set(path: string, data: Data): void {
    this.docs.set(path, data);
  }

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

const M = 'orgs/org-a/matters';
const QUILL = {
  number: 'HV-2026-0042',
  title: 'Estate of Fictional Quill',
  type: 'probate',
  jurisdiction: 'VIC',
  responsibleUid: 'u-priya',
  teamUids: ['u-priya', 'u-jordan'],
};
const QUILL_COPY = { ...QUILL };
const QUILL_NAME = { number: QUILL.number, title: QUILL.title, type: 'probate', privileged: false };

function seed(): FakeStore {
  const store = new FakeStore();
  store.set(`${M}/m-quill`, { ...QUILL, status: 'active', privileged: false, deletedAt: null });
  store.set(`${M}/m-lark`, { number: 'HV-2026-0043', title: 'Estate of Fictional Lark', responsibleUid: 'u-jordan' });
  store.set(`${M}/m-wren`, { number: 'HV-2026-0044', title: 'Estate of Fictional Wren', privileged: true });
  for (let i = 1; i <= 3; i++) {
    store.set(`${M}/m-quill/deadlines/d-${i}`, { title: `Deadline ${i}`, status: 'upcoming', deletedAt: null });
  }
  store.set(`${M}/m-lark/deadlines/d-1`, { title: 'Done already', status: 'done' });
  // Already right: left alone.
  store.set(`${M}/m-quill/deadlines/d-4`, { title: 'Deadline 4', status: 'upcoming', matter: QUILL_COPY });
  // Stale (the matter was renamed): rewritten.
  store.set(`${M}/m-quill/deadlines/d-5`, {
    title: 'Deadline 5',
    status: 'upcoming',
    matter: { ...QUILL_COPY, title: 'Estate of Fictional Quil' },
  });
  // Soft-deleted: left alone.
  store.set(`${M}/m-quill/deadlines/d-6`, { title: 'Removed', status: 'upcoming', deletedAt: new Date() });
  // Its matter is gone, or destroyed: left alone.
  store.set(`${M}/m-gone/deadlines/d-1`, { title: 'Orphan' });
  store.set(`${M}/m-destroyed`, { number: 'HV-2019-0001', title: 'Destroyed', destroyedAt: new Date() });
  store.set(`${M}/m-destroyed/deadlines/d-1`, { title: 'Tombstone' });
  // Not a matter's (another collection with the same id): untouched.
  store.set('orgs/org-a/settings/x/deadlines/d-1', { title: 'Other' });
  // Proposals: the pending one only.
  store.set(`${M}/m-quill/deadlineChanges/c-1`, { status: 'pending' });
  store.set(`${M}/m-quill/deadlineChanges/c-2`, { status: 'accepted' });
  // Tasks: live ones on a matter; a privileged matter's without its name; not personal ones.
  store.set(`${M}/m-quill/tasks/t-1`, { title: 'Call the executor', deletedAt: null });
  store.set(`${M}/m-quill/tasks/t-2`, { title: 'Deleted', deletedAt: new Date() });
  store.set(`${M}/m-wren/tasks/t-1`, { title: 'Privileged', deletedAt: null });
  store.set('orgs/org-a/members/u-priya/tasks/p-1', { title: 'Personal', matterId: null });
  // Recent entries: a matter's own (with or without `kind`), not a document's or a contact's.
  store.set('users/u-priya/recent/org-a_m-quill', { orgId: 'org-a', kind: 'matter', matterId: 'm-quill' });
  store.set('users/u-jordan/recent/org-a_m-wren', { orgId: 'org-a', matterId: 'm-wren' });
  store.set('users/u-jordan/recent/org-a_document_m-quill_doc-1', {
    orgId: 'org-a',
    kind: 'document',
    matterId: 'm-quill',
    entityId: 'doc-1',
  });
  store.set('users/u-jordan/recent/org-a_contact_c-1', { orgId: 'org-a', kind: 'contact', entityId: 'c-1' });
  return store;
}

const COUNTS = {
  deadlines: { read: 10, updated: 5 },
  deadlineChanges: { read: 2, updated: 1 },
  tasks: { read: 4, updated: 2 },
  recent: { read: 4, updated: 2 },
};

describe('backfillMatterCopies', () => {
  it('copies each matter to its records, then has nothing to do', async () => {
    const store = seed();
    const lines: string[] = [];
    // A page size of 2 crosses page boundaries.
    const report = await backfillMatterCopies(store, { pageSize: 2, log: (line) => lines.push(line) });
    expect(report).toEqual(COUNTS);
    for (const id of ['d-1', 'd-2', 'd-3', 'd-4', 'd-5']) {
      expect(store.docs.get(`${M}/m-quill/deadlines/${id}`)?.['matter']).toEqual(QUILL_COPY);
    }
    expect(store.docs.get(`${M}/m-lark/deadlines/d-1`)?.['matter']).toEqual({
      number: 'HV-2026-0043',
      title: 'Estate of Fictional Lark',
      responsibleUid: 'u-jordan',
      teamUids: [],
    });
    expect(store.docs.get(`${M}/m-quill/deadlines/d-6`)?.['matter']).toBeUndefined();
    expect(store.docs.get(`${M}/m-gone/deadlines/d-1`)?.['matter']).toBeUndefined();
    expect(store.docs.get(`${M}/m-destroyed/deadlines/d-1`)?.['matter']).toBeUndefined();
    expect(store.docs.get('orgs/org-a/settings/x/deadlines/d-1')?.['matter']).toBeUndefined();

    expect(store.docs.get(`${M}/m-quill/deadlineChanges/c-1`)?.['matter']).toEqual(QUILL_COPY);
    expect(store.docs.get(`${M}/m-quill/deadlineChanges/c-2`)?.['matter']).toBeUndefined();

    expect(store.docs.get(`${M}/m-quill/tasks/t-1`)?.['matter']).toEqual(QUILL_NAME);
    expect(store.docs.get(`${M}/m-quill/tasks/t-2`)?.['matter']).toBeUndefined();
    expect(store.docs.get(`${M}/m-wren/tasks/t-1`)?.['matter']).toEqual({ privileged: true });
    expect(store.docs.get('orgs/org-a/members/u-priya/tasks/p-1')?.['matter']).toBeUndefined();

    expect(store.docs.get('users/u-priya/recent/org-a_m-quill')?.['matter']).toEqual(QUILL_NAME);
    expect(store.docs.get('users/u-jordan/recent/org-a_m-wren')?.['matter']).toEqual({
      number: 'HV-2026-0044',
      title: 'Estate of Fictional Wren',
      privileged: true,
    });
    expect(store.docs.get('users/u-jordan/recent/org-a_document_m-quill_doc-1')?.['matter']).toBeUndefined();
    expect(store.docs.get('users/u-jordan/recent/org-a_contact_c-1')?.['matter']).toBeUndefined();
    expect(lines).toEqual([
      'deadlines: 10 read, 5 updated',
      'deadlineChanges: 2 read, 1 updated',
      'tasks: 4 read, 2 updated',
      'recent: 4 read, 2 updated',
    ]);

    const writes = store.writes;
    const none = { read: expect.any(Number), updated: 0 };
    expect(await backfillMatterCopies(store)).toEqual({
      deadlines: none,
      deadlineChanges: none,
      tasks: none,
      recent: none,
    });
    expect(store.writes).toBe(writes);
  });

  it('counts without writing on a dry run', async () => {
    const store = seed();
    const lines: string[] = [];
    expect(await backfillMatterCopies(store, { dryRun: true, log: (line) => lines.push(line) })).toEqual(COUNTS);
    expect(store.writes).toBe(0);
    expect(lines[0]).toBe('deadlines: 10 read, 5 to update');
  });

  it('reads its arguments', () => {
    expect(parseArgs(['--project', 'materia-v2-dev', '--dry-run'])).toEqual({
      project: 'materia-v2-dev',
      dryRun: true,
      pageSize: 300,
    });
    expect(() => parseArgs(['--project', 'p', '--page-size', '501'])).toThrow('--page-size is 1 to 500');
    const project = process.env['GCLOUD_PROJECT'];
    delete process.env['GCLOUD_PROJECT'];
    try {
      expect(() => parseArgs([])).toThrow('Usage');
    } finally {
      if (project !== undefined) process.env['GCLOUD_PROJECT'] = project;
    }
  });
});
