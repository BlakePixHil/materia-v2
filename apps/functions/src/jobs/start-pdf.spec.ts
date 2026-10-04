import type { Firestore } from 'firebase-admin/firestore';

import type { JobRequest, Role } from '@materia/domain';

import { createJob, type CreateJobContext } from './start-pdf';
import { createLog } from '../core/log';
import { FakeClock, FakeJobRunner, fakePorts } from '../ports/fakes';

/** Just enough Firestore for createJob: documents by path, auto ids, create/update/getAll. */
class MemoryDb {
  docs = new Map<string, Record<string, unknown>>();
  private nextId = 0;
  doc(path: string) {
    const docs = this.docs;
    return {
      path,
      id: path.split('/').pop() as string,
      async get() {
        const data = docs.get(path);
        return { exists: data !== undefined, data: () => data, get: (field: string) => data?.[field] };
      },
      async create(data: Record<string, unknown>) {
        docs.set(path, data);
      },
      async update(patch: Record<string, unknown>) {
        docs.set(path, { ...docs.get(path), ...patch });
      },
    };
  }
  collection(path: string) {
    return { doc: () => this.doc(`${path}/job-${++this.nextId}`) };
  }
  async getAll(...refs: { get: () => Promise<unknown> }[]) {
    return Promise.all(refs.map((ref) => ref.get()));
  }
}

const ORG = 'org-1';
const docPath = (id: string, version = 1) => `orgs/${ORG}/matters/m-1/documents/${id}/v${version}`;
const document = (over: Record<string, unknown> = {}) => ({
  version: 1,
  privileged: false,
  scan: { status: 'clean' },
  ...over,
});

function setup(role: Role = 'lawyer') {
  const db = new MemoryDb();
  db.docs.set(`orgs/${ORG}/matters/m-1`, { title: 'Estate of a fictional person' });
  db.docs.set(`orgs/${ORG}/matters/m-1/documents/will`, document());
  db.docs.set(`orgs/${ORG}/matters/m-1/documents/advice`, document({ privileged: true }));
  db.docs.set(`orgs/${ORG}/matters/m-1/documents/pending`, document({ scan: { status: 'pending' } }));
  const jobs = new FakeJobRunner();
  const ctx: CreateJobContext = {
    db: db as unknown as Firestore,
    ports: fakePorts({ jobs }),
    clock: new FakeClock(),
    log: createLog({ fn: 'test' }, () => undefined),
    orgId: ORG,
    uid: 'uid-1',
    role,
    requestId: '6f1c1c2e-8a43-4b8e-9d0e-0a3f5b1d2c4e',
  };
  return { db, jobs, ctx };
}

const merge = (
  paths: string[],
  target: JobRequest['target'] = {
    kind: 'matter',
    matterId: 'm-1',
    name: 'Bundle',
    category: 'court_document',
    privileged: false,
  },
): JobRequest => ({
  type: 'pdf.merge',
  input: { inputs: paths.map((storagePath) => ({ storagePath })), onInputError: 'abort' },
  target,
});

describe('createJob', () => {
  it('writes a queued job and starts the pdf Cloud Run job with its ids', async () => {
    const { db, jobs, ctx } = setup();
    const result = await createJob(ctx, merge([docPath('will')]));
    expect(result).toEqual({ jobId: 'job-1', executionId: 'fake-execution-1' });
    expect(jobs.started).toEqual([{ job: 'pdf', orgId: ORG, jobId: 'job-1' }]);
    expect(db.docs.get(`orgs/${ORG}/jobs/job-1`)).toMatchObject({
      type: 'pdf.merge',
      status: 'queued',
      attempts: 0,
      createdBy: 'uid-1',
      executionId: 'fake-execution-1',
      target: { privileged: false },
    });
  });

  it('starts render jobs without reading any input', async () => {
    const { ctx } = setup('paralegal');
    const request: JobRequest = {
      type: 'pdf.render',
      input: { templateId: 'sample-letter', data: { title: 'x' } },
      target: { kind: 'export', name: 'Letter' },
    };
    await expect(createJob(ctx, request)).resolves.toMatchObject({ jobId: 'job-1' });
  });

  it('refuses inputs from another org, missing or newer versions, and unscanned files', async () => {
    const { ctx } = setup();
    await expect(createJob(ctx, merge(['orgs/org-2/matters/m/documents/d/v1']))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { inputIndex: 0 },
    });
    await expect(createJob(ctx, merge([docPath('will'), docPath('missing')]))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { inputIndex: 1 },
    });
    await expect(createJob(ctx, merge([docPath('will', 2)]))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createJob(ctx, merge([docPath('pending')]))).rejects.toMatchObject({ code: 'FAILED_PRECONDITION' });
  });

  it('hides privileged inputs from roles that cannot see them', async () => {
    const { ctx } = setup('paralegal');
    await expect(createJob(ctx, merge([docPath('advice')]))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { inputIndex: 0 },
    });
  });

  it('makes a document built from privileged inputs privileged', async () => {
    const { db, ctx } = setup('lawyer');
    await createJob(ctx, merge([docPath('will'), docPath('advice')]));
    expect(db.docs.get(`orgs/${ORG}/jobs/job-1`)).toMatchObject({ target: { privileged: true } });
  });

  it('exports privileged inputs only for owners and admins', async () => {
    const exportTarget = { kind: 'export', name: 'Export' } as const;
    await expect(createJob(setup('lawyer').ctx, merge([docPath('advice')], exportTarget))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(createJob(setup('admin').ctx, merge([docPath('advice')], exportTarget))).resolves.toMatchObject({
      jobId: 'job-1',
    });
  });

  it('refuses a missing matter', async () => {
    const { ctx } = setup();
    const request = merge([docPath('will')], {
      kind: 'matter',
      matterId: 'nope',
      name: 'x',
      category: 'other',
      privileged: false,
    });
    await expect(createJob(ctx, request)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('marks the job failed and retryable when Cloud Run does not start it', async () => {
    const { db, ctx } = setup();
    ctx.ports = fakePorts({ jobs: { start: async () => Promise.reject(new Error('network')) } });
    await expect(createJob(ctx, merge([docPath('will')]))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(db.docs.get(`orgs/${ORG}/jobs/job-1`)).toMatchObject({
      status: 'failed',
      error: { code: 'UNAVAILABLE', retryable: true },
    });
  });
});
