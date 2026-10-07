import { backfillDeadlineMatters, parseArgs } from './deadline-matters.ts';
import type { BackfillStore } from './search-tokens.ts';

/** The deadline matter-copy backfill (SEC-07c) against an in-memory store. Everything is fictional. */

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
  jurisdiction: 'VIC',
  responsibleUid: 'u-priya',
  teamUids: ['u-priya', 'u-jordan'],
};
const QUILL_COPY = { ...QUILL };

function seed(): FakeStore {
  const store = new FakeStore();
  store.set(`${M}/m-quill`, { ...QUILL, status: 'active', privileged: false });
  store.set(`${M}/m-lark`, { number: 'HV-2026-0043', title: 'Estate of Fictional Lark', responsibleUid: 'u-jordan' });
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
  return store;
}

describe('backfillDeadlineMatters', () => {
  it('copies each matter to its live deadlines, then has nothing to do', async () => {
    const store = seed();
    const lines: string[] = [];
    // A page size of 2 crosses page boundaries.
    const report = await backfillDeadlineMatters(store, { pageSize: 2, log: (line) => lines.push(line) });
    expect(report).toEqual({ read: 10, updated: 5 });
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
    expect(lines).toEqual(['deadlines: 10 read, 5 updated']);

    const writes = store.writes;
    expect(await backfillDeadlineMatters(store)).toEqual({ read: 10, updated: 0 });
    expect(store.writes).toBe(writes);
  });

  it('counts without writing on a dry run', async () => {
    const store = seed();
    const lines: string[] = [];
    expect(await backfillDeadlineMatters(store, { dryRun: true, log: (line) => lines.push(line) })).toEqual({
      read: 10,
      updated: 5,
    });
    expect(store.writes).toBe(0);
    expect(lines).toEqual(['deadlines: 10 read, 5 to update']);
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
