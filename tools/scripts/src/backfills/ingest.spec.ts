import { backfillIngest, ingestState, parseArgs, type IngestStore } from './ingest.ts';

/** The ingest backfill (AI-04) against an in-memory store. Everything is fictional. */

type Data = Record<string, unknown>;

class FakeStore implements IngestStore {
  readonly docs = new Map<string, Data>();
  /** Every `ingest` written, in order, by path. */
  readonly writes: { path: string; ingest: Data }[] = [];
  readonly withEmbeddings = new Set<string>();

  set(path: string, data: Data): void {
    this.docs.set(path, data);
  }

  async page(after: string | null, limit: number) {
    return [...this.docs.keys()]
      .filter((path) => path.split('/').at(-2) === 'documents')
      .sort()
      .filter((path) => after === null || path > after)
      .slice(0, limit)
      .map((path) => ({ path, data: structuredClone(this.docs.get(path) as Data) }));
  }

  async setIngest(path: string, ingest: Data) {
    this.writes.push({ path, ingest });
    this.docs.set(path, { ...(this.docs.get(path) as Data), ingest });
  }

  async embedded(path: string) {
    return this.withEmbeddings.has(path);
  }
}

const clean = { scan: { status: 'clean' }, version: 2 };
const doc = (id: string) => `orgs/org-a/matters/m-1/documents/${id}`;

function seed(): FakeStore {
  const store = new FakeStore();
  store.set(doc('d-legacy'), { ...clean }); // uploaded before AI-04: no ingest field
  store.set(doc('d-old-version'), { ...clean, ingest: { status: 'done', version: 1, chunks: 4 } });
  store.set(doc('d-failed'), { ...clean, ingest: { status: 'failed', version: 2, error: 'Timeout' } });
  store.set(doc('d-done'), { ...clean, ingest: { status: 'done', version: 2, chunks: 6, ocrPages: 1 } });
  store.set(doc('d-done-empty'), { ...clean, ingest: { status: 'done', version: 2, chunks: 0 } });
  store.set(doc('d-skipped'), { ...clean, ingest: { status: 'skipped', version: 2, reason: 'encrypted' } });
  store.set(doc('d-running'), { ...clean, ingest: { status: 'running', version: 2 } });
  store.set(doc('d-queued'), { ...clean, ingest: { status: 'queued', version: 2 } });
  store.set(doc('d-deleted'), { ...clean, deletedAt: '2026-10-01T00:00:00Z' });
  store.set(doc('d-unscanned'), { scan: { status: 'pending' }, version: 1 });
  store.set(doc('d-infected'), { scan: { status: 'infected' }, version: 1 });
  // Not a matter document: org-level documents aren't ingested.
  store.set('orgs/org-a/documents/d-org', { ...clean });
  store.withEmbeddings.add(doc('d-done'));
  return store;
}

describe('backfill-ingest', () => {
  it('classifies each document the way the ingest trigger does', () => {
    expect(ingestState({ ...clean })).toBe('due');
    expect(ingestState({ ...clean, ingest: { status: 'pending' } })).toBe('due');
    expect(ingestState({ ...clean, ingest: { status: 'done', version: 1 } })).toBe('due');
    expect(ingestState({ ...clean, ingest: { status: 'failed', version: 2 } })).toBe('due');
    expect(ingestState({ ...clean, ingest: { status: 'done', version: 2 } })).toBe('done');
    expect(ingestState({ ...clean, ingest: { status: 'skipped', version: 2 } })).toBe('skipped');
    expect(ingestState({ ...clean, ingest: { status: 'queued', version: 2 } })).toBe('inProgress');
    expect(ingestState({ ...clean, deletedAt: '2026-10-01T00:00:00Z' })).toBe('notReady');
    expect(ingestState({ scan: { status: 'clean' }, version: 0 })).toBe('notReady');
    expect(ingestState({ scan: { status: 'pending' }, version: 1 })).toBe('notReady');
  });

  it('reports without writing on a dry run', async () => {
    const store = seed();
    const lines: string[] = [];
    const report = await backfillIngest(store, { dryRun: true, log: (line) => lines.push(line) });
    expect(report).toEqual({
      read: 11,
      notReady: 3,
      done: 2,
      chunks: 6,
      embedded: 1,
      skipped: 1,
      inProgress: 2,
      due: 3,
      ocrPages: 1,
    });
    expect(store.writes).toEqual([]);
    expect(lines.join('\n')).toContain('3 to queue');
    expect(lines.join('\n')).not.toContain('d-legacy');
  });

  it('moves each due document through queued to pending for its current version, so the trigger queues it', async () => {
    const store = seed();
    await backfillIngest(store, { pageSize: 2 });
    const due = [doc('d-failed'), doc('d-legacy'), doc('d-old-version')];
    expect(store.writes).toEqual(
      due.flatMap((path) => [
        { path, ingest: { status: 'queued', version: 2 } },
        { path, ingest: { status: 'pending', version: 2 } },
      ]),
    );
  });

  it('is idempotent once the queued documents are picked up', async () => {
    const store = seed();
    await backfillIngest(store);
    // The trigger queued them; the pipeline marks them running.
    for (const [path, data] of store.docs) {
      const ingest = data['ingest'] as { status?: string } | undefined;
      if (ingest?.status === 'pending') store.set(path, { ...data, ingest: { status: 'running', version: 2 } });
    }
    store.writes.length = 0;
    const report = await backfillIngest(store);
    expect(report.due).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('parses its arguments', () => {
    expect(parseArgs(['--project', 'materia-v2-dev', '--dry-run'])).toEqual({
      project: 'materia-v2-dev',
      dryRun: true,
      pageSize: 300,
    });
    expect(() => parseArgs(['--project', 'p', '--page-size', '0'])).toThrow('--page-size is 1 to 500');
  });
});
