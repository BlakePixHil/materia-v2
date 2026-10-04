import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localFiles, localJobStore, readLocalJob } from './local';
import { jobDoc } from '../testing';

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'local-job-'));
  await writeFile(join(dir, 'job.json'), JSON.stringify({ orgId: 'org-1', jobId: 'job-1', job: jobDoc() }));
  return dir;
}

describe('local mode', () => {
  it('claims, reports progress and finishes through job.json, reviving dates', async () => {
    const dir = await folder();
    const store = localJobStore(dir);
    const now = new Date('2026-10-04T10:00:00Z');
    expect(await store.claim(now)).toMatchObject({ kind: 'claimed' });
    await store.progress({ done: 1, total: 2, stage: 'merging' }, now);
    await store.fail({ code: 'PDF_INVALID', message: 'bad', retryable: false }, [], now);

    const { job } = await readLocalJob(dir);
    expect(job).toMatchObject({ status: 'failed', attempts: 1, progress: { done: 1 }, error: { code: 'PDF_INVALID' } });
    expect((job as { startedAt: unknown }).startedAt).toEqual(now);
    expect(await readFile(join(dir, 'progress.jsonl'), 'utf8')).toContain('"stage":"merging"');
    expect(await store.claim(now)).toEqual({ kind: 'skip', reason: 'failed' });
  });

  it('records success and writes documents under firestore/', async () => {
    const dir = await folder();
    const store = localJobStore(dir);
    const now = new Date();
    await store.succeed(
      { storagePath: 'orgs/org-1/exports/job-1.pdf', sizeBytes: 1, sha256: 'a'.repeat(64), pages: 1 },
      [],
      now,
    );
    await store.createDocument('orgs/org-1/matters/m/documents/d', { name: 'x' } as never);
    expect((await readLocalJob(dir)).job).toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(await readFile(join(dir, 'firestore/orgs/org-1/matters/m/documents/d.json'), 'utf8'))).toEqual({
      name: 'x',
    });
  });

  it('copies files in and out of storage/ and never outside it', async () => {
    const dir = await folder();
    const files = localFiles(dir);
    await mkdir(join(dir, 'storage/orgs/org-1'), { recursive: true });
    await writeFile(join(dir, 'storage/orgs/org-1/in.pdf'), 'in');
    await files.download('orgs/org-1/in.pdf', join(dir, 'copy.pdf'));
    await files.upload(join(dir, 'copy.pdf'), 'orgs/org-1/out/out.pdf', 'application/pdf');
    expect(await readFile(join(dir, 'storage/orgs/org-1/out/out.pdf'), 'utf8')).toBe('in');
    await expect(files.download('../job.json', join(dir, 'x'))).rejects.toThrow('escapes');
  });
});
