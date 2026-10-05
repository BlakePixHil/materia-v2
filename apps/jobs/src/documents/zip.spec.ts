import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unzipSync } from 'fflate';

import type { JobProblem, JobRequest } from '@materia/domain';

import { zipHandler } from './zip';
import { JobError } from '../core/errors';
import type { HandlerContext, JobFiles, JobProgress } from '../core/types';

/** The `documents.zip` handler (CORE-12b). Every file is fictional. */

type ZipRequest = Extract<JobRequest, { type: 'documents.zip' }>;

const path = (doc: string) => `orgs/org-1/matters/m-1/documents/${doc}/v1`;
const STORED: Record<string, Uint8Array> = {
  [path('will')]: new TextEncoder().encode('%PDF-1.7 fictional will'),
  [path('letter')]: new TextEncoder().encode('Dear Ms Example, a fictional letter.'),
  // Bigger than a stream chunk (64 KiB), so it arrives in several pushes.
  [path('statement')]: Uint8Array.from({ length: 200_000 }, (_, i) => i % 251),
};

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'zip-test-'));
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

function context(inputs: { storagePath: string; fileName: string }[], signal = new AbortController().signal) {
  const progress: JobProgress[] = [];
  const warnings: JobProblem[] = [];
  const downloads: string[] = [];
  const files: JobFiles = {
    async download(storagePath, localPath) {
      downloads.push(storagePath);
      const data = STORED[storagePath];
      if (!data) throw new JobError('NOT_FOUND', 'Input not found');
      await writeFile(localPath, data);
    },
    upload: async () => undefined,
  };
  const ctx: HandlerContext<ZipRequest> = {
    orgId: 'org-1',
    jobId: 'job-1',
    request: { type: 'documents.zip', input: { inputs }, target: { kind: 'export', name: 'Documents' } },
    scratch,
    files,
    signal,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    progress: async (next) => void progress.push(next),
    warn: (problem) => warnings.push(problem),
  };
  return { ctx, progress, warnings, downloads };
}

describe('zipHandler', () => {
  it('writes every input into a valid zip under its name, with progress per file', async () => {
    const { ctx, progress } = context([
      { storagePath: path('will'), fileName: 'Will of a fictional person.pdf' },
      { storagePath: path('letter'), fileName: 'Lettre à Mme Exemple.txt' },
      { storagePath: path('statement'), fileName: 'Bank statement.xlsx' },
    ]);
    const result = await zipHandler(ctx);
    expect(result).toEqual({ path: join(scratch, 'output.zip'), pages: 0 });

    const entries = unzipSync(await readFile(result.path));
    expect(Object.keys(entries)).toEqual([
      'Will of a fictional person.pdf',
      'Lettre à Mme Exemple.txt',
      'Bank statement.xlsx',
    ]);
    for (const [name, storagePath] of [
      ['Will of a fictional person.pdf', path('will')],
      ['Lettre à Mme Exemple.txt', path('letter')],
      ['Bank statement.xlsx', path('statement')],
    ] as const) {
      expect(Buffer.from(entries[name] as Uint8Array).equals(Buffer.from(STORED[storagePath] as Uint8Array))).toBe(
        true,
      );
    }
    expect(progress).toEqual([
      { done: 0, total: 3, stage: 'zipping' },
      { done: 1, total: 3, stage: 'zipping' },
      { done: 2, total: 3, stage: 'zipping' },
      { done: 3, total: 3, stage: 'zipping' },
    ]);
    // Inputs are removed as they are added, so only the zip is left.
    expect(await readdir(scratch)).toEqual(['output.zip']);
  });

  it('stores entries without compressing them', async () => {
    const { ctx } = context([{ storagePath: path('statement'), fileName: 'Bank statement.xlsx' }]);
    const zip = await readFile((await zipHandler(ctx)).path);
    // Local file header: compression method (offset 8) 0 means stored.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(8)).toBe(0);
    expect(zip.length).toBeGreaterThan(200_000);
  });

  it('stops when the job is aborted', async () => {
    const controller = new AbortController();
    const timeout = new JobError('JOB_TIMEOUT', 'The job ran out of time', { retryable: true });
    controller.abort(timeout);
    const { ctx, downloads } = context([{ storagePath: path('will'), fileName: 'a.pdf' }], controller.signal);
    await expect(zipHandler(ctx)).rejects.toBe(timeout);
    expect(downloads).toEqual([]);
  });

  it('fails when an input can’t be downloaded', async () => {
    const { ctx } = context([
      { storagePath: path('will'), fileName: 'a.pdf' },
      { storagePath: path('missing'), fileName: 'b.pdf' },
    ]);
    await expect(zipHandler(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
