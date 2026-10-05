import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobProblem } from '@materia/domain';

import { decideClaim } from './claim';
import { JobError } from './errors';
import { executeJob, outputLocation, type RunnerDeps } from './runner';
import type { JobFiles, JobHandler, JobOutput, JobProgress, JobRecord, JobStore, MatterDocumentRecord } from './types';
import { jobDoc } from '../testing';

class MemoryStore implements JobStore {
  progressWrites: JobProgress[] = [];
  documents = new Map<string, MatterDocumentRecord>();
  result?: { status: 'succeeded' | 'failed'; output?: JobOutput; error?: JobProblem; warnings: JobProblem[] };
  constructor(public job: JobRecord) {}
  async claim(now: Date) {
    const result = decideClaim(this.job, now);
    if (result.kind === 'claimed') this.job = result.job;
    return result;
  }
  async progress(progress: JobProgress) {
    this.progressWrites.push(progress);
  }
  async succeed(output: JobOutput, warnings: JobProblem[]) {
    this.result = { status: 'succeeded', output, warnings };
  }
  async fail(error: JobProblem, warnings: JobProblem[]) {
    this.result = { status: 'failed', error, warnings };
  }
  async createDocument(path: string, data: MatterDocumentRecord) {
    this.documents.set(path, data);
  }
}

const uploads = new Map<string, Buffer>();
const contentTypes = new Map<string, string>();
const files: JobFiles = {
  download: async () => undefined,
  upload: async (localPath, storagePath, contentType) => {
    uploads.set(storagePath, await readFile(localPath));
    contentTypes.set(storagePath, contentType);
  },
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const pdfHandler: JobHandler = async ({ scratch, progress, warn }) => {
  await progress({ done: 1, total: 2, stage: 'merging' });
  warn({ code: 'PDF_INVALID', message: 'Input 0 was repaired', retryable: false, inputIndex: 0 });
  const path = join(scratch, 'out.pdf');
  await writeFile(path, '%PDF-1.7 fake');
  return { path, pages: 3 };
};

function deps(store: JobStore, handler: JobHandler = pdfHandler, extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    orgId: 'org-1',
    jobId: 'job-1',
    store,
    files,
    log,
    handlers: { 'pdf.merge': handler, 'pdf.render': handler, 'documents.zip': handler },
    timeoutMs: 5_000,
    clock: () => new Date('2026-10-04T10:00:00Z'),
    ...extra,
  };
}

beforeEach(() => {
  uploads.clear();
  contentTypes.clear();
});

/** A `documents.zip` job (CORE-12b) of the given document versions. */
const zipJob = (...storagePaths: string[]) =>
  jobDoc({
    type: 'documents.zip',
    input: { inputs: storagePaths.map((storagePath, i) => ({ storagePath, fileName: `${i}.pdf` })) },
    target: { kind: 'export', name: 'Documents' },
  });

describe('executeJob', () => {
  it('runs the handler, uploads the PDF and records a generated matter document', async () => {
    const store = new MemoryStore(jobDoc());
    expect(await executeJob(deps(store))).toBe('succeeded');

    const path = 'orgs/org-1/matters/m-1/documents/job-job-1/v1';
    expect(uploads.get(path)?.toString()).toBe('%PDF-1.7 fake');
    expect(store.result).toMatchObject({
      status: 'succeeded',
      output: { storagePath: path, pages: 3, sizeBytes: 13, documentId: 'job-job-1' },
      warnings: [{ code: 'PDF_INVALID', inputIndex: 0 }],
    });
    expect(store.result?.output?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.documents.get('orgs/org-1/matters/m-1/documents/job-job-1')).toMatchObject({
      source: 'generated',
      mime: 'application/pdf',
      pageCount: 3,
      createdBy: 'uid-lawyer',
      scan: { status: 'clean' },
      ingest: { status: 'pending' },
      version: 1,
      versions: [{ version: 1, storagePath: path, mime: 'application/pdf', pageCount: 3, uploadedBy: 'uid-lawyer' }],
    });
    expect(store.progressWrites.at(-1)).toMatchObject({ stage: 'saving' });
  });

  it('writes exports to the exports folder without a document record', async () => {
    const store = new MemoryStore(jobDoc({ target: { kind: 'export', name: 'Export' } }));
    expect(await executeJob(deps(store))).toBe('succeeded');
    expect(uploads.has('orgs/org-1/exports/job-1.pdf')).toBe(true);
    expect(contentTypes.get('orgs/org-1/exports/job-1.pdf')).toBe('application/pdf');
    expect(store.documents.size).toBe(0);
  });

  it('writes a zip download as a zip export', async () => {
    const store = new MemoryStore(zipJob('orgs/org-1/matters/m-1/documents/d-1/v2'));
    expect(await executeJob(deps(store))).toBe('succeeded');
    expect(uploads.has('orgs/org-1/exports/job-1.zip')).toBe(true);
    expect(contentTypes.get('orgs/org-1/exports/job-1.zip')).toBe('application/zip');
    expect(store.result?.output?.storagePath).toBe('orgs/org-1/exports/job-1.zip');
    expect(store.documents.size).toBe(0);
  });

  it('exits without work when the job already succeeded (duplicate dispatch)', async () => {
    const handler = vi.fn(pdfHandler);
    const store = new MemoryStore(jobDoc({ status: 'succeeded' }));
    expect(await executeJob(deps(store, handler))).toBe('skipped');
    expect(handler).not.toHaveBeenCalled();
  });

  it('records a coded failure from the handler', async () => {
    const store = new MemoryStore(jobDoc());
    const handler: JobHandler = async () => {
      throw new JobError('PDF_ENCRYPTED', 'Input 2 needs a password', { inputIndex: 2 });
    };
    expect(await executeJob(deps(store, handler))).toBe('failed');
    expect(store.result?.error).toEqual({
      code: 'PDF_ENCRYPTED',
      message: 'Input 2 needs a password',
      retryable: false,
      inputIndex: 2,
    });
  });

  it('marks unexpected errors INTERNAL and retryable, without their message', async () => {
    const store = new MemoryStore(jobDoc());
    const handler: JobHandler = async () => {
      throw new Error('ENOENT /tmp/secret-name.pdf');
    };
    expect(await executeJob(deps(store, handler))).toBe('failed');
    expect(store.result?.error).toEqual({ code: 'INTERNAL', message: 'Unexpected error', retryable: true });
    expect(log.error).toHaveBeenCalledWith('job crashed', { jobId: 'job-1', error: 'Error' });
  });

  it('stops at the deadline and records a retryable timeout', async () => {
    const store = new MemoryStore(jobDoc());
    let aborted = false;
    const handler: JobHandler = ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => ((aborted = true), resolve({ path: '', pages: 0 }))),
      );
    expect(await executeJob(deps(store, handler, { timeoutMs: 20 }))).toBe('failed');
    expect(aborted).toBe(true);
    expect(store.result?.error).toMatchObject({ code: 'JOB_TIMEOUT', retryable: true });
  });

  it('refuses inputs from another organisation', async () => {
    const store = new MemoryStore(
      jobDoc({ input: { inputs: [{ storagePath: 'orgs/org-2/matters/m/documents/d/v1' }] } }),
    );
    expect(await executeJob(deps(store))).toBe('failed');
    expect(store.result?.error).toMatchObject({ code: 'PERMISSION_DENIED', inputIndex: 0 });
  });

  it('refuses zip inputs from another organisation', async () => {
    const store = new MemoryStore(zipJob('orgs/org-1/matters/m/documents/d/v1', 'orgs/org-2/matters/m/documents/d/v1'));
    expect(await executeJob(deps(store))).toBe('failed');
    expect(store.result?.error).toMatchObject({ code: 'PERMISSION_DENIED', inputIndex: 1 });
  });

  it('refuses an input that does not match the job type', async () => {
    const store = new MemoryStore(jobDoc({ input: { templateId: 'sample-letter', data: {} } }));
    expect(await executeJob(deps(store))).toBe('failed');
    expect(store.result?.error).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false });
  });

  it('throttles progress writes but always writes stage changes', async () => {
    const store = new MemoryStore(jobDoc());
    const handler: JobHandler = async (ctx) => {
      for (let done = 0; done < 50; done++) await ctx.progress({ done, total: 100, stage: 'checking inputs' });
      await ctx.progress({ done: 50, total: 100, stage: 'merging' });
      return pdfHandler(ctx);
    };
    await executeJob(deps(store, handler, { progressIntervalMs: 60_000 }));
    const stages = store.progressWrites.map((p) => p.stage);
    expect(stages.filter((s) => s === 'checking inputs')).toHaveLength(1);
    expect(stages).toContain('merging');
  });
});

describe('outputLocation', () => {
  it('names generated documents after the job, so a retry overwrites rather than duplicates', () => {
    const request = {
      type: 'pdf.render',
      input: { templateId: 't', data: {} },
      target: { kind: 'matter', matterId: 'm-9', name: 'x', category: 'other', privileged: false },
    } as const;
    expect(outputLocation('o', 'j', request as never)).toEqual({
      storagePath: 'orgs/o/matters/m-9/documents/job-j/v1',
      documentId: 'job-j',
      documentPath: 'orgs/o/matters/m-9/documents/job-j',
    });
  });

  it('names exports after the job, as a PDF or a zip', () => {
    const target = { kind: 'export', name: 'x' } as const;
    const render = { type: 'pdf.render', input: { templateId: 't', data: {} }, target } as const;
    const zip = { type: 'documents.zip', input: { inputs: [] }, target } as const;
    expect(outputLocation('o', 'j', render as never)).toEqual({ storagePath: 'orgs/o/exports/j.pdf' });
    expect(outputLocation('o', 'j', zip as never)).toEqual({ storagePath: 'orgs/o/exports/j.zip' });
  });
});

describe('scratch folders', () => {
  it('are removed after the job', async () => {
    let scratch = '';
    const store = new MemoryStore(jobDoc());
    await executeJob(deps(store, async (ctx) => ((scratch = ctx.scratch), pdfHandler(ctx))));
    expect(scratch.startsWith(join(tmpdir(), 'job-'))).toBe(true);
    await expect(readFile(join(scratch, 'out.pdf'))).rejects.toThrow();
  });
});
