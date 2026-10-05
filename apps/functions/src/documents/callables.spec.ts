import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { DOWNLOAD_URL_TTL_SECONDS, type Role } from '@materia/domain';

import {
  bulkUpdateDefinition,
  getDownloadUrlDefinition,
  resolveDuplicateDefinition,
  restoreVersionDefinition,
} from './callables';
import { MemoryFiles } from './testing';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeSignedUrls, fakePorts } from '../ports/fakes';

/** Unit tests for the documents callables (CORE-12). Every org, person, matter and file is fictional. */

const ORG = 'org-a';
const MATTERS = `orgs/${ORG}/matters`;
const DOCS = `${MATTERS}/m1/documents`;
const BUCKET = 'demo-materia.appspot.com';
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const at = new Date('2026-09-01T00:00:00.000Z');

type Data = Record<string, unknown>;

const version = (n: number, extra: Data = {}) => ({
  version: n,
  storagePath: `${DOCS}/d1/v${n}`,
  fileName: n === 1 ? 'Fictional will.pdf' : `Fictional will v${n}.pdf`,
  mime: 'application/pdf',
  sizeBytes: 100 + n,
  sha256: String(n).repeat(64),
  uploadedAt: at,
  uploadedBy: 'user-lawyer',
  uploadId: `upload-000${n}`,
  pageCount: n,
  ...extra,
});

const document = (extra: Data = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  name: 'Will of a fictional person',
  category: 'will',
  privileged: false,
  tags: [],
  version: 2,
  versionSeq: 2,
  versions: [version(1), version(2, { renditions: { previewImage: `${DOCS}/d1/renditions/v2/preview.jpg` } })],
  storagePath: `${DOCS}/d1/v2`,
  mime: 'application/pdf',
  sizeBytes: 102,
  sha256: '2'.repeat(64),
  scan: { status: 'clean' },
  ingest: { status: 'pending' },
  source: 'upload',
  encrypted: false,
  accessRestricted: false,
  deletedAt: null,
  ...extra,
});

function world() {
  const store = memoryFirestore({
    [`${MATTERS}/m1`]: { ...meta, number: 'BL-2026-0042', status: 'active', privileged: false, deletedAt: null },
    [`${MATTERS}/m2`]: { ...meta, number: 'BL-2026-0043', status: 'active', privileged: true, deletedAt: null },
    [`${DOCS}/d1`]: document(),
    [`${DOCS}/d2`]: document({ privileged: true, category: 'correspondence' }),
    [`${DOCS}/d3`]: document({ scan: { status: 'pending' }, version: 0, versions: [], upload: { uploadId: 'u' } }),
    [`${DOCS}/d4`]: document({ deletedAt: at, deletedBy: 'user-lawyer' }),
    [`${DOCS}/d5`]: document({ duplicateOf: 'd1' }),
  });
  const files = new MemoryFiles(BUCKET);
  files.put(`${DOCS}/d1/v1`, '%PDF-1.7 fictional v1');
  files.put(`${DOCS}/d1/v2`, '%PDF-1.7 fictional v2');
  const clock = new FakeClock(new Date('2026-10-05T00:00:00.000Z'));
  const signer = new FakeSignedUrls();
  const ports = fakePorts({ signedUrls: signer });
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = <T>(def: unknown, data: Data, role: Role = 'lawyer') =>
    runCallable(
      def as CallableDefinition<never, T>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(),
    );
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  return { ...store, files, clock, signer, call, doc };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

describe('documents-getDownloadUrl', () => {
  const def = getDownloadUrlDefinition(() => BUCKET);

  it('signs the current version for 5 minutes, as an attachment', async () => {
    const w = world();
    const result = await w.call<{ url: string; expiresAt: string; fileName: string; version: number }>(def, {
      matterId: 'm1',
      docId: 'd1',
    });
    expect(result).toMatchObject({ version: 2, fileName: 'Will of a fictional person.pdf' });
    expect(new Date(result.expiresAt).getTime() - w.clock.now().getTime()).toBe(DOWNLOAD_URL_TTL_SECONDS * 1000);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(300);
    expect(w.signer.signed).toEqual([
      {
        bucket: BUCKET,
        path: `${DOCS}/d1/v2`,
        expiresAt: new Date(result.expiresAt),
        disposition: expect.stringMatching(/^attachment; filename="Will of a fictional person.pdf"/),
        contentType: 'application/pdf',
      },
    ]);
    expect(result.url).toBe(await new FakeSignedUrls().sign(w.signer.signed[0] as never));
  });

  it('signs an earlier version or a rendition', async () => {
    const w = world();
    await w.call(def, { matterId: 'm1', docId: 'd1', version: 1 }, 'readonly');
    expect(w.signer.signed[0]?.path).toBe(`${DOCS}/d1/v1`);
    await w.call(def, { matterId: 'm1', docId: 'd1', rendition: 'previewImage' }, 'readonly');
    expect(w.signer.signed[1]).toMatchObject({
      path: `${DOCS}/d1/renditions/v2/preview.jpg`,
      contentType: 'image/jpeg',
    });
  });

  it.each([
    ['privileged documents for readonly', 'd2', 'readonly', 'not-found'],
    ['privileged documents for paralegals', 'd2', 'paralegal', 'not-found'],
    ['removed documents', 'd4', 'lawyer', 'not-found'],
    ['missing documents', 'nope', 'lawyer', 'not-found'],
    ['documents not scanned clean', 'd3', 'lawyer', 'failed-precondition'],
  ] as const)('refuses %s', async (_label, docId, role, code) => {
    const w = world();
    expect(await failure(w.call(def, { matterId: 'm1', docId }, role))).toMatchObject({ code });
    expect(w.signer.signed).toEqual([]);
  });

  it('a lawyer can download privileged documents', async () => {
    const w = world();
    await expect(w.call(def, { matterId: 'm1', docId: 'd2' })).resolves.toMatchObject({ version: 2 });
  });

  it('refuses missing versions and renditions', async () => {
    const w = world();
    expect(await failure(w.call(def, { matterId: 'm1', docId: 'd1', version: 9 }))).toMatchObject({
      code: 'not-found',
    });
    expect(await failure(w.call(def, { matterId: 'm1', docId: 'd1', rendition: 'previewPdf' }))).toMatchObject({
      code: 'not-found',
      details: { reason: 'rendition_unavailable' },
    });
  });

  it('documents of a privileged matter are hidden from readonly', async () => {
    const w = world();
    await w.db.doc(`${MATTERS}/m2/documents/d1`).set(document({ matterId: 'm2' }));
    expect(await failure(w.call(def, { matterId: 'm2', docId: 'd1' }, 'readonly'))).toMatchObject({
      code: 'not-found',
    });
  });
});

describe('documents-restoreVersion', () => {
  const def = (w: ReturnType<typeof world>) => restoreVersionDefinition(() => w.files);

  it('copies an earlier version to a new current version', async () => {
    const w = world();
    const result = await w.call(def(w), { matterId: 'm1', docId: 'd1', version: 1 }, 'paralegal');
    expect(result).toEqual({ version: 3, restoredFrom: 1 });
    const stored = w.doc(`${DOCS}/d1`) as Data;
    expect(stored).toMatchObject({
      version: 3,
      versionSeq: 3,
      storagePath: `${DOCS}/d1/v3`,
      sha256: '1'.repeat(64),
      pageCount: 1,
      updatedBy: 'user-paralegal',
    });
    // The restored version has no renditions of its own yet.
    expect(stored['renditions']).toBeUndefined();
    expect((stored['versions'] as Data[]).at(-1)).toMatchObject({
      version: 3,
      restoredFrom: 1,
      uploadedBy: 'user-paralegal',
      fileName: 'Fictional will.pdf',
    });
    expect((stored['versions'] as Data[]).map((v) => v['version'])).toEqual([1, 2, 3]);
    expect(w.files.objects.get(`${DOCS}/d1/v3`)?.data.toString()).toBe('%PDF-1.7 fictional v1');
  });

  it('is idempotent by request id', async () => {
    const w = world();
    const requestId = randomUUID();
    await w.call(def(w), { matterId: 'm1', docId: 'd1', version: 1, requestId });
    // The idempotency store is stubbed here, so the handler itself must not add a second version.
    await expect(w.call(def(w), { matterId: 'm1', docId: 'd1', version: 1, requestId })).resolves.toEqual({
      version: 3,
      restoredFrom: 1,
    });
    expect((w.doc(`${DOCS}/d1`)?.['versions'] as Data[]).length).toBe(3);
  });

  it.each([
    ['the current version', { version: 2 }, 'lawyer', 'failed-precondition'],
    ['a missing version', { version: 7 }, 'lawyer', 'not-found'],
    ['as readonly', { version: 1 }, 'readonly', 'permission-denied'],
    ['a privileged document as a paralegal', { version: 1, docId: 'd2' }, 'paralegal', 'not-found'],
    ['a document not scanned clean', { version: 1, docId: 'd3' }, 'lawyer', 'failed-precondition'],
  ] as const)('refuses %s', async (_label, input, role, code) => {
    const w = world();
    expect(await failure(w.call(def(w), { matterId: 'm1', docId: 'd1', ...input }, role))).toMatchObject({ code });
  });

  it('reports a stored version that cannot be read', async () => {
    const w = world();
    w.files.objects.delete(`${DOCS}/d1/v1`);
    expect(await failure(w.call(def(w), { matterId: 'm1', docId: 'd1', version: 1 }))).toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('documents-resolveDuplicate', () => {
  it('keep clears the mark; discard removes the copy', async () => {
    const w = world();
    await w.call(resolveDuplicateDefinition, { matterId: 'm1', docId: 'd5', action: 'keep' }, 'paralegal');
    expect(w.doc(`${DOCS}/d5`)?.['duplicateOf']).toBeUndefined();
    expect(w.doc(`${DOCS}/d5`)?.['deletedAt']).toBeNull();

    await w.db.doc(`${DOCS}/d5`).update({ duplicateOf: 'd1' });
    await w.call(resolveDuplicateDefinition, { matterId: 'm1', docId: 'd5', action: 'discard' }, 'paralegal');
    expect(w.doc(`${DOCS}/d5`)).toMatchObject({ deletedBy: 'user-paralegal' });
    expect(w.doc(`${DOCS}/d5`)?.['duplicateOf']).toBeUndefined();
  });

  it('refuses documents that are not marked', async () => {
    const w = world();
    expect(
      await failure(w.call(resolveDuplicateDefinition, { matterId: 'm1', docId: 'd1', action: 'discard' })),
    ).toMatchObject({ code: 'failed-precondition', details: { reason: 'not_duplicate' } });
  });
});

describe('documents-bulkUpdate', () => {
  it('moves documents to a category, skipping what it cannot or need not change', async () => {
    const w = world();
    const result = await w.call(
      bulkUpdateDefinition,
      {
        matterId: 'm1',
        docIds: ['d1', 'd2', 'd3', 'd4', 'nope'],
        change: { op: 'category', category: 'correspondence' },
      },
      'paralegal',
    );
    expect(result).toEqual({
      updated: 2,
      skipped: [
        { docId: 'd2', reason: 'not_found' },
        { docId: 'd4', reason: 'deleted' },
        { docId: 'nope', reason: 'not_found' },
      ],
    });
    expect(w.doc(`${DOCS}/d1`)).toMatchObject({ category: 'correspondence', updatedBy: 'user-paralegal' });
    expect(w.doc(`${DOCS}/d1`)?.['_requestId']).toEqual(expect.any(String));
    const again = await w.call<{ skipped: Data[] }>(bulkUpdateDefinition, {
      matterId: 'm1',
      docIds: ['d1'],
      change: { op: 'category', category: 'correspondence' },
    });
    expect(again.skipped).toEqual([{ docId: 'd1', reason: 'unchanged' }]);
  });

  it('soft deletes and restores; removed documents stay resolvable', async () => {
    const w = world();
    expect(
      await w.call(bulkUpdateDefinition, { matterId: 'm1', docIds: ['d1', 'd2', 'd4'], change: { op: 'delete' } }),
    ).toEqual({ updated: 2, skipped: [{ docId: 'd4', reason: 'deleted' }] });
    expect(w.doc(`${DOCS}/d1`)).toMatchObject({ deletedBy: 'user-lawyer', name: 'Will of a fictional person' });
    expect(w.docs.has(`${DOCS}/d1`)).toBe(true);
    expect(
      await w.call(bulkUpdateDefinition, { matterId: 'm1', docIds: ['d1', 'd5'], change: { op: 'restore' } }),
    ).toEqual({ updated: 1, skipped: [{ docId: 'd5', reason: 'not_deleted' }] });
    expect(w.doc(`${DOCS}/d1`)).toMatchObject({ deletedAt: null, deletedBy: null });
  });

  it('removing needs document.delete; readonly can do nothing', async () => {
    const w = world();
    expect(
      await failure(
        w.call(bulkUpdateDefinition, { matterId: 'm1', docIds: ['d1'], change: { op: 'delete' } }, 'paralegal'),
      ),
    ).toMatchObject({ code: 'permission-denied' });
    expect(
      await failure(
        w.call(
          bulkUpdateDefinition,
          { matterId: 'm1', docIds: ['d1'], change: { op: 'category', category: 'will' } },
          'readonly',
        ),
      ),
    ).toMatchObject({ code: 'permission-denied' });
    expect(w.doc(`${DOCS}/d1`)?.['deletedAt']).toBeNull();
  });

  it('refuses a privileged matter for paralegals and duplicate ids', async () => {
    const w = world();
    expect(
      await failure(
        w.call(
          bulkUpdateDefinition,
          { matterId: 'm2', docIds: ['d1'], change: { op: 'category', category: 'will' } },
          'paralegal',
        ),
      ),
    ).toMatchObject({ code: 'not-found' });
    expect(
      await failure(w.call(bulkUpdateDefinition, { matterId: 'm1', docIds: ['d1', 'd1'], change: { op: 'delete' } })),
    ).toMatchObject({ code: 'invalid-argument' });
  });
});
