import { EXPORT_TTL_DAYS } from '@materia/domain';

import { expireExports } from './sweep-exports';
import { createLog } from '../core/log';
import { MemoryFiles } from '../documents/testing';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock } from '../ports/fakes';

/** `jobs-sweepExports` (CORE-12b) against the in-memory bucket and Firestore. Everything is fictional. */

type Data = Record<string, unknown>;

const NOW = new Date('2026-10-20T00:00:00.000Z');
const OLD = new Date('2026-10-05T00:00:00.000Z');
const FRESH = new Date('2026-10-18T00:00:00.000Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };

const job = (storagePath: string, extra: Data = {}) => ({
  ...meta,
  type: storagePath.endsWith('.zip') ? 'documents.zip' : 'pdf.render',
  target: { kind: 'export', name: 'Documents M-2026-0001' },
  status: 'succeeded',
  output: { storagePath, sizeBytes: 10, sha256: 'a'.repeat(64), pages: 1 },
  ...extra,
});

function world(initial: Record<string, Data> = {}) {
  const store = memoryFirestore(initial);
  const files = new MemoryFiles();
  const logs: { message: string; entry: Data }[] = [];
  const log = createLog({ fn: 'test' }, (_s, message, entry) => void logs.push({ message, entry }));
  const sweep = () => expireExports({ db: store.db, files, clock: new FakeClock(NOW), log });
  return { store, files, logs, sweep };
}

describe('expireExports', () => {
  it('deletes export files older than 7 days, by generation, with the jobs that point at them', async () => {
    const w = world({
      'orgs/org-a/jobs/j-zip': job('orgs/org-a/exports/j-zip.zip'),
      'orgs/org-a/jobs/j-fresh': job('orgs/org-a/exports/j-fresh.pdf'),
      'orgs/org-a/jobs/j-other': job('orgs/org-a/exports/elsewhere.pdf'),
      'orgs/org-b/jobs/j-receipt': job('orgs/org-b/exports/j-receipt.pdf'),
    });
    const removed: [string, string | undefined][] = [];
    const remove = w.files.remove.bind(w.files);
    w.files.remove = async (path, generation) => {
      removed.push([path, generation]);
      return remove(path, generation);
    };
    const zip = w.files.put('orgs/org-a/exports/j-zip.zip', 'zip', { timeCreated: OLD });
    w.files.put('orgs/org-a/exports/j-fresh.pdf', 'pdf', { timeCreated: FRESH });
    w.files.put('orgs/org-a/exports/j-other.pdf', 'pdf', { timeCreated: OLD });
    w.files.put('orgs/org-a/exports/j-gone.pdf', 'pdf', { timeCreated: OLD });
    w.files.put('orgs/org-b/exports/j-receipt.pdf', 'pdf', { timeCreated: OLD });
    // Not exports: a matter document, a destruction certificate, something without a creation time.
    w.files.put('orgs/org-a/matters/m1/documents/d1/v1', 'will', { timeCreated: OLD });
    w.files.put('orgs/org-a/certificates/dc-m1.pdf', 'certificate', { timeCreated: OLD });
    w.files.put('orgs/org-a/exports/j-undated.pdf', 'pdf', { timeCreated: undefined });

    expect(await w.sweep()).toEqual({ files: 4, jobs: 2, failed: 0 });
    expect([...w.files.objects.keys()].sort()).toEqual([
      'orgs/org-a/certificates/dc-m1.pdf',
      'orgs/org-a/exports/j-fresh.pdf',
      'orgs/org-a/exports/j-undated.pdf',
      'orgs/org-a/matters/m1/documents/d1/v1',
    ]);
    expect(removed).toContainEqual(['orgs/org-a/exports/j-zip.zip', zip.generation]);
    expect(removed.every(([, generation]) => generation)).toBe(true);
    // Only the jobs whose output is the deleted file go; a job that names another file stays.
    expect([...w.store.docs.keys()].filter((path) => path.includes('/jobs/')).sort()).toEqual([
      'orgs/org-a/jobs/j-fresh',
      'orgs/org-a/jobs/j-other',
    ]);
    // Ids only in the logs.
    expect(w.logs.filter((l) => l.message === 'export expired').map((l) => l.entry['jobId'])).toHaveLength(4);
    expect(JSON.stringify(w.logs)).not.toContain('Documents M-2026-0001');

    // A second run finds nothing more to do.
    expect(await w.sweep()).toEqual({ files: 0, jobs: 0, failed: 0 });
  });

  it('keeps an export until it is EXPORT_TTL_DAYS old', async () => {
    const w = world();
    const edge = new Date(NOW.getTime() - EXPORT_TTL_DAYS * 86_400_000);
    w.files.put('orgs/org-a/exports/j-edge.pdf', 'pdf', { timeCreated: new Date(edge.getTime() + 1) });
    w.files.put('orgs/org-a/exports/j-due.pdf', 'pdf', { timeCreated: edge });
    expect(await w.sweep()).toMatchObject({ files: 1 });
    expect([...w.files.objects.keys()]).toEqual(['orgs/org-a/exports/j-edge.pdf']);
  });

  it('carries on past a file it can’t delete, and tries it again next time', async () => {
    const w = world();
    w.files.put('orgs/org-a/exports/j-stuck.pdf', 'pdf', { timeCreated: OLD });
    w.files.put('orgs/org-a/exports/j-ok.pdf', 'pdf', { timeCreated: OLD });
    const remove = w.files.remove.bind(w.files);
    w.files.remove = async (path, generation) => {
      if (path.includes('j-stuck')) throw new Error('Storage unavailable');
      return remove(path, generation);
    };
    expect(await w.sweep()).toEqual({ files: 1, jobs: 0, failed: 1 });
    expect(w.logs.find((l) => l.message === 'export not expired')?.entry).toMatchObject({
      orgId: 'org-a',
      jobId: 'j-stuck',
      errorType: 'Error',
    });
    w.files.remove = remove;
    expect(await w.sweep()).toEqual({ files: 1, jobs: 0, failed: 0 });
    expect(w.files.objects.size).toBe(0);
  });
  it('deletes every zip of a split full export with its first (SEC-05)', async () => {
    const parts = [1, 2, 3].map((n) => ({
      storagePath: n === 1 ? 'orgs/org-a/exports/j-full.zip' : `orgs/org-a/exports/j-full.part-${n}.zip`,
      sizeBytes: 3,
      sha256: 'b'.repeat(64),
    }));
    const w = world({
      'orgs/org-a/jobs/j-full': job('orgs/org-a/exports/j-full.zip', {
        type: 'org.export',
        output: { storagePath: parts[0]?.storagePath, sizeBytes: 9, sha256: 'b'.repeat(64), pages: 0, parts },
      }),
    });
    w.files.put('orgs/org-a/exports/j-full.zip', 'zip', { timeCreated: OLD });
    // Written later than the first, so not yet 7 days old on their own.
    w.files.put('orgs/org-a/exports/j-full.part-2.zip', 'zip', { timeCreated: FRESH });
    w.files.put('orgs/org-a/exports/j-full.part-3.zip', 'zip', { timeCreated: OLD });
    expect(await w.sweep()).toEqual({ files: 3, jobs: 1, failed: 0 });
    expect(w.files.objects.size).toBe(0);
    expect(w.store.docs.has('orgs/org-a/jobs/j-full')).toBe(false);
  });
});
