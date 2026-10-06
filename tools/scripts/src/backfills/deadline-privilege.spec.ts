import { backfillDeadlinePrivilege, parseArgs } from './deadline-privilege.ts';
import type { BackfillStore } from './search-tokens.ts';

/** The deadline privilege backfill (CORE-10b) against an in-memory store. Everything is fictional. */

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

function seed(): FakeStore {
  const store = new FakeStore();
  store.set(`${M}/m-open`, { title: 'Estate of Example Open', privileged: false });
  store.set(`${M}/m-priv`, { title: 'Estate of Example Privileged', privileged: true });
  for (const matter of ['m-open', 'm-priv']) {
    for (let i = 1; i <= 3; i++) store.set(`${M}/${matter}/deadlines/d-${i}`, { title: `Deadline ${i}` });
    store.set(`${M}/${matter}/deadlineChanges/c-1`, { title: 'Deadline 1', status: 'pending' });
    store.set(`${M}/${matter}/events/e-1`, { kind: 'date_of_death', date: '2026-07-14' });
  }
  // Already right: left alone.
  store.set(`${M}/m-open/deadlines/d-4`, { title: 'Deadline 4', privileged: false });
  // Its matter is gone: hidden rather than shown.
  store.set(`${M}/m-gone/deadlines/d-1`, { title: 'Orphan' });
  // Not a matter's (another collection with the same id): untouched.
  store.set('orgs/org-a/settings/x/events/e-1', { kind: 'other' });
  return store;
}

describe('backfillDeadlinePrivilege', () => {
  it('copies each matter’s flag to its events, deadlines and proposals, then has nothing to do', async () => {
    const store = seed();
    const lines: string[] = [];
    const report = await backfillDeadlinePrivilege(store, { pageSize: 2, log: (line) => lines.push(line) });
    expect(report).toEqual({
      events: { read: 3, updated: 2 },
      deadlines: { read: 8, updated: 7 },
      deadlineChanges: { read: 2, updated: 2 },
    });
    expect(store.docs.get(`${M}/m-open/deadlines/d-1`)).toMatchObject({ privileged: false });
    expect(store.docs.get(`${M}/m-priv/deadlines/d-3`)).toMatchObject({ privileged: true });
    expect(store.docs.get(`${M}/m-priv/deadlineChanges/c-1`)).toMatchObject({ privileged: true });
    expect(store.docs.get(`${M}/m-priv/events/e-1`)).toMatchObject({ privileged: true });
    expect(store.docs.get(`${M}/m-open/events/e-1`)).toMatchObject({ privileged: false });
    expect(store.docs.get(`${M}/m-gone/deadlines/d-1`)).toMatchObject({ privileged: true });
    expect(store.docs.get('orgs/org-a/settings/x/events/e-1')).toEqual({ kind: 'other' });
    expect(lines).toEqual([
      'events: 3 read, 2 updated',
      'deadlines: 8 read, 7 updated',
      'deadlineChanges: 2 read, 2 updated',
    ]);

    const writes = store.writes;
    const again = await backfillDeadlinePrivilege(store, { pageSize: 2 });
    expect(Object.values(again).every((counts) => counts.updated === 0)).toBe(true);
    expect(store.writes).toBe(writes);
  });

  it('follows a matter whose flag changed since, and writes nothing on a dry run', async () => {
    const store = seed();
    await backfillDeadlinePrivilege(store);
    store.set(`${M}/m-open`, { title: 'Estate of Example Open', privileged: true });
    const writes = store.writes;
    const dry = await backfillDeadlinePrivilege(store, { dryRun: true });
    expect(dry.deadlines.updated).toBe(4);
    expect(store.writes).toBe(writes);
    await backfillDeadlinePrivilege(store);
    expect(store.docs.get(`${M}/m-open/deadlines/d-4`)).toMatchObject({ privileged: true });
  });

  it('parses its arguments', () => {
    expect(parseArgs(['--project', 'demo-materia', '--dry-run'])).toEqual({
      project: 'demo-materia',
      dryRun: true,
      pageSize: 300,
    });
    expect(() => parseArgs(['--project', 'p', '--page-size', '600'])).toThrow('--page-size is 1 to 500');
  });
});
