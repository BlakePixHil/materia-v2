import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import type { Role } from '@materia/domain';

import { startZipDefinition } from './zip';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeJobRunner, fakePorts } from '../ports/fakes';

/** Unit tests for `documents-startZip` (CORE-12b). Every org, matter and file is fictional. */

const ORG = 'org-a';
const MATTERS = `orgs/${ORG}/matters`;
const DOCS = `${MATTERS}/m1/documents`;
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const at = new Date('2026-09-01T00:00:00.000Z');

type Data = Record<string, unknown>;

const document = (id: string, name: string, extra: Data = {}, sizeBytes = 100) => ({
  ...meta,
  name,
  privileged: false,
  version: 2,
  versions: [1, 2].map((n) => ({
    version: n,
    storagePath: `${DOCS}/${id}/v${n}`,
    fileName: `upload-${n}.pdf`,
    mime: 'application/pdf',
    sizeBytes,
    sha256: String(n).repeat(64),
    uploadedAt: at,
    uploadedBy: 'user-lawyer',
  })),
  scan: { status: 'clean' },
  deletedAt: null,
  ...extra,
});

function world() {
  const store = memoryFirestore({
    [`${MATTERS}/m1`]: { ...meta, number: 'BL-2026-0042', title: 'Estate of a fictional person', deletedAt: null },
    [`${MATTERS}/m2`]: { ...meta, number: 'BL-2026-0043', privileged: true, deletedAt: null },
    [`${MATTERS}/m3`]: { ...meta, number: 'BL-2026-0044', deletedAt: at },
    [`${DOCS}/will`]: document('will', 'Will of a fictional person'),
    [`${DOCS}/will-copy`]: document('will-copy', 'Will of a fictional person.pdf'),
    [`${DOCS}/advice`]: document('advice', 'Advice on the claim', { privileged: true }),
    [`${DOCS}/pending`]: document('pending', 'Scan pending', { scan: { status: 'pending' } }),
    [`${DOCS}/removed`]: document('removed', 'Old draft', { deletedAt: at, deletedBy: 'user-lawyer' }),
    [`${DOCS}/empty`]: document('empty', 'Never stored', { version: 0, versions: [] }),
    [`${DOCS}/video-1`]: document('video-1', 'Recorded instructions 1', {}, 600 * 1024 * 1024),
    [`${DOCS}/video-2`]: document('video-2', 'Recorded instructions 2', {}, 600 * 1024 * 1024),
  });
  const jobs = new FakeJobRunner();
  const ports = fakePorts({ jobs });
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock: new FakeClock(new Date('2026-10-05T00:00:00.000Z')),
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = (data: Data, role: Role = 'lawyer') =>
    runCallable(
      startZipDefinition as unknown as CallableDefinition<never, Data>,
      {
        data: { requestId: randomUUID(), matterId: 'm1', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(),
    );
  const job = () => {
    const [entry] = [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/jobs/`));
    return entry?.[1];
  };
  return { ...store, jobs, call, job };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

describe('documents-startZip', () => {
  it('starts a zip export of the current versions, with unique names', async () => {
    const w = world();
    const result = await w.call({ docIds: ['will', 'will-copy', 'advice'] });
    expect(result).toMatchObject({ included: 3, skipped: 0, executionId: 'fake-execution-1' });
    expect(w.jobs.started).toEqual([{ job: 'pdf', orgId: ORG, jobId: result['jobId'] }]);
    expect(w.job()).toMatchObject({
      type: 'documents.zip',
      status: 'queued',
      createdBy: 'user-lawyer',
      target: { kind: 'export', name: 'Documents BL-2026-0042' },
      input: {
        inputs: [
          { storagePath: `${DOCS}/will/v2`, fileName: 'Will of a fictional person.pdf' },
          { storagePath: `${DOCS}/will-copy/v2`, fileName: 'Will of a fictional person (2).pdf' },
          { storagePath: `${DOCS}/advice/v2`, fileName: 'Advice on the claim.pdf' },
        ],
      },
    });
  });

  it('leaves privileged documents out for roles that can’t see them', async () => {
    for (const role of ['paralegal', 'readonly'] as const) {
      const w = world();
      expect(await w.call({ docIds: ['will', 'advice'] }, role)).toMatchObject({ included: 1, skipped: 1 });
      const inputs = (w.job()?.['input'] as { inputs: { storagePath: string }[] }).inputs;
      expect(inputs.map((input) => input.storagePath)).toEqual([`${DOCS}/will/v2`]);
    }
  });

  it('includes privileged documents for a lawyer without export.includePrivileged', async () => {
    const w = world();
    expect(await w.call({ docIds: ['advice'] }, 'lawyer')).toMatchObject({ included: 1, skipped: 0 });
  });

  it('skips removed, unscanned, unstored and missing documents', async () => {
    const w = world();
    const result = await w.call({ docIds: ['removed', 'pending', 'empty', 'missing', 'will'] });
    expect(result).toMatchObject({ included: 1, skipped: 4 });
  });

  it('refuses when nothing is left to zip, without starting a job', async () => {
    const w = world();
    expect(await failure(w.call({ docIds: ['advice', 'removed'] }, 'readonly'))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'nothing_to_zip' },
    });
    expect(w.jobs.started).toEqual([]);
    expect(w.job()).toBeUndefined();
  });

  it('refuses more than 1 GiB in one zip', async () => {
    const w = world();
    expect(await failure(w.call({ docIds: ['video-1', 'video-2'] }))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'too_large' },
    });
    expect(await w.call({ docIds: ['video-1', 'will'] })).toMatchObject({ included: 2 });
  });

  it('hides privileged and removed matters', async () => {
    const w = world();
    expect(await failure(w.call({ matterId: 'm2', docIds: ['x'] }, 'paralegal'))).toMatchObject({ code: 'not-found' });
    expect(await failure(w.call({ matterId: 'm3', docIds: ['x'] }))).toMatchObject({ code: 'not-found' });
  });

  it('takes at most 200 documents', async () => {
    const w = world();
    const docIds = Array.from({ length: 201 }, (_, i) => `d${i}`);
    expect(await failure(w.call({ docIds }))).toMatchObject({ code: 'invalid-argument' });
  });
});
