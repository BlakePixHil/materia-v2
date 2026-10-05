import { TestBed } from '@angular/core/testing';

import { DOCUMENT_CALLABLES, UPLOAD_METADATA_KEYS } from '@materia/domain';

import { CallableClient } from './callable-client';
import {
  documentCallables,
  documentUpload,
  fileSha256,
  injectDocumentUpload,
  matterDocumentRepository,
  matterDocumentsQuery,
} from './documents';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Documents reads, metadata edits, the upload contract and the callables (CORE-12). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const D = 'orgs/org-a/matters/m-1/documents';
const SHA = 'ab'.repeat(32);

function document(name: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: 'org-a',
    matterId: 'm-1',
    name,
    category: 'will',
    privileged: false,
    tags: [],
    version: 1,
    versionSeq: 1,
    versions: [
      {
        version: 1,
        storagePath: `${D}/d-1/v1`,
        fileName: name,
        mime: 'application/pdf',
        sizeBytes: 10,
        sha256: SHA,
        uploadedAt: new Date('2026-10-01T00:00:00Z'),
        uploadedBy: 'u-jordan',
      },
    ],
    storagePath: `${D}/d-1/v1`,
    mime: 'application/pdf',
    sizeBytes: 10,
    sha256: SHA,
    scan: { status: 'clean' },
    ingest: { status: 'pending' },
    source: 'upload',
    encrypted: false,
    accessRestricted: false,
    deletedAt: null,
    ...meta,
    ...extra,
  };
}

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('matterDocumentRepository', () => {
  it('lists documents newest first, hiding removed ones, and tolerates server-only fields', async () => {
    const { fs, run } = setup();
    fs.set(`${D}/d-1`, document('Older.pdf', { _requestId: 'req-1' }));
    fs.set(`${D}/d-2`, document('Newer.pdf', { createdAt: new Date('2026-10-03T00:00:00Z') }));
    fs.set(`${D}/d-3`, document('Gone.pdf', { deletedAt: new Date('2026-10-02T00:00:00Z') }));
    const docs = run(() => matterDocumentRepository(() => 'm-1'));
    const rows = await docs.query(matterDocumentsQuery({ privilegedVisible: true }));
    expect(rows.map((r) => r.name)).toEqual(['Newer.pdf', 'Older.pdf']);
    // A removed document still resolves by id.
    expect(await docs.get('d-3')).toMatchObject({ name: 'Gone.pdf' });
  });

  it('edits whitelisted metadata and soft deletes', async () => {
    const { fs, run } = setup();
    fs.set(`${D}/d-1`, document('Brief.pdf'));
    const docs = run(() => matterDocumentRepository(() => 'm-1'));
    await docs.update('d-1', {
      name: 'Signed brief.pdf',
      category: 'correspondence',
      tags: ['signed'],
      notes: 'Fictional',
    });
    expect(fs.get(`${D}/d-1`)).toMatchObject({
      name: 'Signed brief.pdf',
      category: 'correspondence',
      tags: ['signed'],
      notes: 'Fictional',
      updatedBy: 'u-jordan',
    });
    await expect(docs.update('d-1', { scan: { status: 'clean' } } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await docs.softDelete('d-1');
    expect(fs.get(`${D}/d-1`)?.['deletedBy']).toBe('u-jordan');
  });

  it('has no client creates', async () => {
    const { run } = setup();
    await expect(run(() => matterDocumentRepository(() => 'm-1')).create({ name: 'x' })).rejects.toMatchObject({
      code: 'FAILED_PRECONDITION',
    });
  });
});

describe('matterDocumentsQuery', () => {
  it('proves privileged == false for roles that cannot see privileged documents', () => {
    expect(matterDocumentsQuery({ privilegedVisible: false })).toEqual({
      where: [['privileged', '==', false]],
      orderBy: [['createdAt', 'desc']],
      pageSize: 100,
    });
    expect(matterDocumentsQuery({ privilegedVisible: true, includeDeleted: true, pageSize: 20 })).toEqual({
      orderBy: [['createdAt', 'desc']],
      pageSize: 20,
      includeDeleted: true,
    });
  });
});

describe('documentUpload', () => {
  it('plans the pending path and the metadata the Storage rules expect', () => {
    const { run } = setup();
    const plan = run(() => injectDocumentUpload())(
      'm-1',
      { fileName: 'Will.PDF', sha256: SHA.toUpperCase() },
      'upload-0001',
    );
    expect(plan).toEqual({
      uploadId: 'upload-0001',
      path: 'orgs/org-a/matters/m-1/pending/upload-0001',
      settings: {
        contentType: 'application/pdf',
        customMetadata: { uploaderUid: 'u-jordan', fileName: 'Will.PDF', sha256: SHA },
      },
    });
  });

  it('targets a document for a new version and sets new-document metadata', () => {
    const context = { requireOrgId: () => 'org-a', requireUid: () => 'u-jordan' };
    const plan = documentUpload(context, 'm-1', {
      fileName: 'notes.txt',
      sha256: SHA,
      documentId: 'd-1',
      category: 'correspondence',
      privileged: true,
    });
    expect(plan.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.settings.contentType).toBe('text/plain');
    expect(plan.settings.customMetadata).toMatchObject({
      documentId: 'd-1',
      category: 'correspondence',
      privileged: 'true',
    });
    for (const key of Object.keys(plan.settings.customMetadata)) expect(UPLOAD_METADATA_KEYS).toContain(key);
  });

  it('refuses types off the allow-list', () => {
    const context = { requireOrgId: () => 'org-a', requireUid: () => 'u-jordan' };
    expect(() => documentUpload(context, 'm-1', { fileName: 'page.html', sha256: SHA })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('hashes bytes as lower-case hex', async () => {
    // The test DOM has no Web Crypto digest; browsers and Node do.
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', (await import('node:crypto')).webcrypto);
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await fileSha256(new TextEncoder().encode('abc'))).toBe(expected);
    expect(await fileSha256(new Blob(['abc']))).toBe(expected);
    expect(await fileSha256(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe(expected);
  });
});

describe('documentCallables', () => {
  it('calls each callable, with request ids for the idempotent ones', async () => {
    const calls: { name: string; data: Record<string, unknown> }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data: data as Record<string, unknown> });
          return {} as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => '00000000-0000-4000-8000-000000000001' },
    );
    const api = documentCallables(client);
    await api.getDownloadUrl({ matterId: 'm-1', docId: 'd-1', version: 2 });
    await api.restoreVersion({ matterId: 'm-1', docId: 'd-1', version: 1 });
    await api.resolveDuplicate({ matterId: 'm-1', docId: 'd-2', action: 'discard' });
    await api.bulkUpdate({ matterId: 'm-1', docIds: ['d-1'], change: { op: 'delete' } });
    expect(calls.map((c) => c.name)).toEqual([
      DOCUMENT_CALLABLES.getDownloadUrl,
      DOCUMENT_CALLABLES.restoreVersion,
      DOCUMENT_CALLABLES.resolveDuplicate,
      DOCUMENT_CALLABLES.bulkUpdate,
    ]);
    expect(calls[0]?.data).not.toHaveProperty('requestId');
    for (const call of calls.slice(1)) expect(call.data['requestId']).toBe('00000000-0000-4000-8000-000000000001');
  });
});
