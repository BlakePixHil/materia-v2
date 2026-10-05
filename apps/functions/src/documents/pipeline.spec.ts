import { Timestamp } from 'firebase-admin/firestore';

import { DOCUMENT_MAX_BYTES, DOCUMENT_VERSIONS_MAX, SCAN_MAX_ATTEMPTS, type Role } from '@materia/domain';

import { RescanTaskSchema, retryScan } from './on-upload';
import {
  analysePdf,
  expirePendingUploads,
  processUpload,
  reserveVersion,
  scanWithTimeout,
  type AfterVersion,
  type PipelineDeps,
  type RescanTask,
} from './pipeline';
import { MemoryFiles, samplePdf, sha256Of } from './testing';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { ScannerUnavailableError, type MalwareScanPort } from '../ports';
import {
  EICAR_TEST_STRING,
  FAKE_SCANNER_TIMEOUT_MARKER,
  FakeClock,
  FakeTaskQueue,
  fakeMalwareScan,
} from '../ports/fakes';

/** Unit tests for the documents pipeline (CORE-12). Every org, person, matter and file is fictional. */

const ORG = 'org-a';
const MATTERS = `orgs/${ORG}/matters`;
const DOCS = `${MATTERS}/m1/documents`;
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const member = (role: Role, status = 'active') => ({ ...meta, role, status });
const matter = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  number: 'BL-2026-0042',
  title: 'Estate of Fictional Person',
  status: 'active',
  privileged: false,
  deletedAt: null,
  ...extra,
});

type Data = Record<string, unknown>;

function world() {
  const store = memoryFirestore({
    [`orgs/${ORG}/members/user-owner`]: member('owner'),
    [`orgs/${ORG}/members/user-admin`]: member('admin'),
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal'),
    [`orgs/${ORG}/members/user-readonly`]: member('readonly'),
    [`orgs/${ORG}/members/user-former`]: member('lawyer', 'suspended'),
    [`orgs/${ORG}/members/user-old-admin`]: member('admin', 'suspended'),
    [`${MATTERS}/m1`]: matter(),
    [`${MATTERS}/m2`]: matter({ number: 'BL-2026-0043', privileged: true }),
    [`${MATTERS}/m3`]: matter({ number: 'BL-2026-0044', deletedAt: new Date('2026-09-01T00:00:00Z') }),
  });
  const files = new MemoryFiles();
  const clock = new FakeClock(new Date('2026-10-05T00:00:00.000Z'));
  const rescans: { task: RescanTask; delaySeconds: number }[] = [];
  const after: Parameters<AfterVersion>[0][] = [];
  const logged: { message: string; entry: Data }[] = [];
  const tasks = new FakeTaskQueue();
  const log = createLog({ fn: 'test' }, (_severity, message, entry) => void logged.push({ message, entry }));
  const deps = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
    db: store.db,
    files,
    scanner: fakeMalwareScan,
    clock,
    log,
    ports: { tasks },
    scheduleRescan: async (task, delaySeconds) => void rescans.push({ task, delaySeconds }),
    afterVersion: async (stored) => void after.push(stored),
    ...overrides,
  });
  let uploads = 0;
  /** Puts an upload in the pending area (as the client would) and returns its event. */
  const upload = (
    data: Uint8Array | string,
    {
      fileName = 'Fictional brief.pdf',
      uid = 'user-lawyer',
      matterId = 'm1',
      uploadId = `upload-${String(++uploads).padStart(4, '0')}`,
      sha256 = sha256Of(data),
      extra = {} as Record<string, string>,
    } = {},
  ) => {
    const path = `${MATTERS}/${matterId}/pending/${uploadId}`;
    const metadata = { uploaderUid: uid, fileName, sha256, ...extra };
    const object = files.put(path, data, { metadata });
    return { path, generation: object.generation, size: object.size, metadata, uploadId };
  };
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  return { ...store, files, clock, rescans, after, logged, tasks, deps, upload, doc };
}

const fakePdf = (label: string) => `%PDF-1.7\n% fictional ${label}\n%%EOF\n`;

describe('processUpload', () => {
  it('stores a clean PDF as version 1 with its page count, hash and pending state cleared', async () => {
    const w = world();
    const pdf = await samplePdf({ pages: 3 });
    const event = w.upload(pdf, { extra: { category: 'correspondence' } });
    const result = await processUpload(event, w.deps());
    expect(result).toEqual({ outcome: 'stored', docId: event.uploadId, version: 1 });

    const stored = w.doc(`${DOCS}/${event.uploadId}`) as Data;
    expect(stored).toMatchObject({
      orgId: ORG,
      matterId: 'm1',
      name: 'Fictional brief.pdf',
      category: 'correspondence',
      privileged: false,
      version: 1,
      versionSeq: 1,
      storagePath: `${DOCS}/${event.uploadId}/v1`,
      mime: 'application/pdf',
      sizeBytes: pdf.length,
      sha256: sha256Of(pdf),
      pageCount: 3,
      encrypted: false,
      scan: { status: 'clean' },
      ingest: { status: 'pending' },
      source: 'upload',
      createdBy: 'user-lawyer',
      deletedAt: null,
    });
    expect(stored['upload']).toBeUndefined();
    expect(stored['duplicateOf']).toBeUndefined();
    expect(stored['versions']).toEqual([
      expect.objectContaining({ version: 1, uploadId: event.uploadId, uploadedBy: 'user-lawyer', pageCount: 3 }),
    ]);
    // Moved: the version exists (as an attachment), the quarantined copy is gone.
    expect(w.files.objects.has(event.path)).toBe(false);
    const version = w.files.objects.get(`${DOCS}/${event.uploadId}/v1`);
    expect(version?.object).toMatchObject({ contentType: 'application/pdf' });
    expect(version?.object.metadata['contentDisposition']).toMatch(/^attachment; filename="Fictional brief.pdf"/);
    expect(w.doc(`${MATTERS}/m1/documentHashes/${sha256Of(pdf)}`)).toMatchObject({ documentId: event.uploadId });
    expect(w.after).toEqual([
      expect.objectContaining({ docId: event.uploadId, kind: 'pdf', uploaderUid: 'user-lawyer' }),
    ]);
  });

  it('marks password-protected PDFs encrypted (no page count)', async () => {
    const w = world();
    const event = w.upload(await samplePdf({ pages: 2, encrypted: true }));
    await processUpload(event, w.deps());
    const stored = w.doc(`${DOCS}/${event.uploadId}`) as Data;
    expect(stored).toMatchObject({ encrypted: true, scan: { status: 'clean' } });
    expect(stored['pageCount']).toBeUndefined();
  });

  it('stores corrupt files as uploaded', async () => {
    const w = world();
    const pdf = w.upload(fakePdf('damaged'));
    expect(await processUpload(pdf, w.deps())).toMatchObject({ outcome: 'stored' });
    expect(w.doc(`${DOCS}/${pdf.uploadId}`)?.['pageCount']).toBeUndefined();
    const docx = w.upload(Buffer.from('PK\u0003\u0004 truncated Office file'), { fileName: 'Draft will.docx' });
    expect(await processUpload(docx, w.deps())).toMatchObject({ outcome: 'stored' });
    expect(w.doc(`${DOCS}/${docx.uploadId}`)).toMatchObject({
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('documents uploaded to a privileged matter are privileged', async () => {
    const w = world();
    const event = w.upload(fakePdf('advice'), { matterId: 'm2' });
    await processUpload(event, w.deps());
    expect(w.doc(`${MATTERS}/m2/documents/${event.uploadId}`)).toMatchObject({ privileged: true });
  });

  it('deletes infected files, records them and notifies the uploader and active admins (EICAR)', async () => {
    const w = world();
    const event = w.upload(`${EICAR_TEST_STRING}\n`, { fileName: 'Fictional notes.txt', uid: 'user-paralegal' });
    const result = await processUpload(event, w.deps());
    expect(result).toEqual({ outcome: 'infected', docId: event.uploadId });
    expect(w.files.objects.size).toBe(0);
    const stored = w.doc(`${DOCS}/${event.uploadId}`) as Data;
    expect(stored).toMatchObject({
      scan: { status: 'infected' },
      upload: { status: 'infected', uploadId: event.uploadId },
      version: 0,
      versions: [],
    });
    const notifications = [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/notifications/`));
    expect(notifications.map(([, n]) => n['recipientUid']).sort()).toEqual([
      'user-admin',
      'user-owner',
      'user-paralegal',
    ]);
    for (const [path, notification] of notifications) {
      expect(path).toContain(`infected-${event.uploadId}-`);
      expect(notification).toMatchObject({
        kind: 'document_infected',
        matterId: 'm1',
        documentId: event.uploadId,
        priority: 'high',
        // Through notify() (FND-20): the kind's channels after each person's preferences.
        channels: ['inapp', 'email'],
        readAt: null,
        summaryId: null,
      });
      // No file names (they can carry personal data).
      expect(JSON.stringify(notification)).not.toContain('Fictional notes');
    }
    // One email delivery queued per recipient.
    expect(w.tasks.queued.map((q) => q.payload['channel'])).toEqual(['email', 'email', 'email']);
    expect(w.after).toEqual([]);
    expect(JSON.stringify(w.logged)).not.toContain('Fictional notes');
  });

  it('keeps the file quarantined and retries with backoff when the scanner times out', async () => {
    const w = world();
    const event = w.upload(`${FAKE_SCANNER_TIMEOUT_MARKER} fictional text`, { fileName: 'Slow file.txt' });
    expect(await processUpload(event, w.deps())).toEqual({ outcome: 'delayed', docId: event.uploadId });
    expect(w.files.objects.has(event.path)).toBe(true);
    expect(w.doc(`${DOCS}/${event.uploadId}`)).toMatchObject({
      scan: { status: 'pending' },
      upload: { status: 'delayed', attempts: 1 },
    });
    expect(w.rescans).toEqual([
      { task: { path: event.path, generation: event.generation, attempt: 1 }, delaySeconds: 60 },
    ]);

    // The second attempt waits longer; the last one schedules nothing more.
    await processUpload({ ...event, attempt: 1 }, w.deps());
    expect(w.rescans[1]).toMatchObject({ task: { attempt: 2 }, delaySeconds: 120 });
    await processUpload({ ...event, attempt: SCAN_MAX_ATTEMPTS - 1 }, w.deps());
    expect(w.rescans).toHaveLength(2);
    expect(w.doc(`${DOCS}/${event.uploadId}`)).toMatchObject({
      upload: { status: 'delayed', attempts: SCAN_MAX_ATTEMPTS },
    });
  });

  it('treats a scanner that is down or too slow as delayed', async () => {
    const w = world();
    const down: MalwareScanPort = { scan: async () => Promise.reject(new Error('connection refused')) };
    const slow: MalwareScanPort = { scan: () => new Promise(() => undefined) };
    expect(await processUpload(w.upload(fakePdf('a')), w.deps({ scanner: down }))).toMatchObject({
      outcome: 'delayed',
    });
    expect(await processUpload(w.upload(fakePdf('b')), w.deps({ scanner: slow, scanTimeoutMs: 5 }))).toMatchObject({
      outcome: 'delayed',
    });
    expect(w.rescans).toHaveLength(2);
  });

  it('a delayed upload that later scans clean is stored by the retry', async () => {
    const w = world();
    const event = w.upload(fakePdf('later'));
    const down: MalwareScanPort = { scan: async () => Promise.reject(new ScannerUnavailableError('unavailable')) };
    await processUpload(event, w.deps({ scanner: down }));
    const [first] = w.rescans;
    expect(RescanTaskSchema.parse(first?.task)).toEqual(first?.task);
    expect(await retryScan(first?.task as RescanTask, w.deps())).toMatchObject({ outcome: 'stored', version: 1 });
    expect(w.doc(`${DOCS}/${event.uploadId}`)).toMatchObject({ scan: { status: 'clean' }, version: 1 });
    // A retry for an object that is gone (or replaced) ends the chain.
    expect(await retryScan(first?.task as RescanTask, w.deps())).toEqual({ outcome: 'gone' });
  });

  it.each([
    [
      'type_mismatch',
      'a PNG named .pdf',
      () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
      {},
    ],
    [
      'type_mismatch',
      'an executable named .txt',
      () => Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]),
      { fileName: 'notes.txt' },
    ],
    [
      'type_mismatch',
      'a zip named .docx',
      () => Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]),
      { fileName: 'a.docx' },
    ],
    ['hash_mismatch', 'the wrong hash', () => fakePdf('x'), { sha256: 'a'.repeat(64) }],
    ['type_not_allowed', 'an extension off the list', () => fakePdf('y'), { fileName: 'page.html' }],
  ])('rejects %s (%s), deleting the file', async (reason, _label, bytes, options) => {
    const w = world();
    const event = w.upload(bytes(), options as never);
    expect(await processUpload(event, w.deps())).toEqual({ outcome: 'rejected', docId: event.uploadId, reason });
    expect(w.files.objects.size).toBe(0);
    expect(w.doc(`${DOCS}/${event.uploadId}`)).toMatchObject({
      scan: { status: 'error' },
      upload: { status: 'rejected', reason },
    });
  });

  it('rejects files over 50 MB', async () => {
    const w = world();
    const event = w.upload(Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 0x20));
    expect(await processUpload(event, w.deps())).toMatchObject({ outcome: 'rejected', reason: 'too_large' });
  });

  it('ignores metadata outside the contract (Firebase Storage adds a download token)', async () => {
    const w = world();
    const event = w.upload(fakePdf('token'));
    const withToken = { ...event, metadata: { ...event.metadata, firebaseStorageDownloadTokens: 'fictional-token' } };
    expect(await processUpload(withToken, w.deps())).toMatchObject({ outcome: 'stored' });
  });

  it.each([
    ['missing metadata', { metadata: {} }],
    ['a bad hash', { metadata: { uploaderUid: 'user-lawyer', fileName: 'a.pdf', sha256: 'not-a-hash' } }],
    [
      'a bad category',
      { metadata: { uploaderUid: 'user-lawyer', fileName: 'a.pdf', sha256: 'a'.repeat(64), category: 'x' } },
    ],
  ])('drops uploads with %s', async (_label, patch) => {
    const w = world();
    const event = { ...w.upload(fakePdf('z')), ...patch };
    expect(await processUpload(event, w.deps())).toEqual({ outcome: 'not_allowed' });
    expect(w.files.objects.size).toBe(0);
    expect(w.docs.has(`${DOCS}/${event.uploadId}`)).toBe(false);
  });

  it.each([
    ['a readonly member', { uid: 'user-readonly' }],
    ['a suspended member', { uid: 'user-former' }],
    ['someone outside the org', { uid: 'user-stranger' }],
    ['a paralegal on a privileged matter', { uid: 'user-paralegal', matterId: 'm2' }],
    ['a paralegal marking a file privileged', { uid: 'user-paralegal', extra: { privileged: 'true' } }],
    ['a deleted matter', { matterId: 'm3' }],
    ['a missing matter', { matterId: 'm9' }],
  ])('refuses uploads from %s', async (_label, options) => {
    const w = world();
    const event = w.upload(fakePdf('r'), options as never);
    expect(await processUpload(event, w.deps())).toMatchObject({ outcome: 'not_allowed', reason: 'not_allowed' });
    expect(w.files.objects.size).toBe(0);
  });

  it('refuses a new-document upload whose id names an existing document', async () => {
    const w = world();
    // A document that didn't come from an upload with this id (generated, migrated or seeded).
    const target = `${DOCS}/generated-0001`;
    await w.db.doc(target).set({
      orgId: ORG,
      matterId: 'm1',
      name: 'Fictional court book.pdf',
      privileged: true,
      version: 1,
      versions: [{ version: 1, uploadId: 'job-0001' }],
      scan: { status: 'clean' },
      deletedAt: null,
    });
    const before = w.doc(target);
    // An upload that reuses that id to slip a version in without `documentId` (and its checks).
    const hijack = w.upload(fakePdf('theirs'), { uid: 'user-paralegal', uploadId: 'generated-0001' });
    expect(await processUpload(hijack, w.deps())).toMatchObject({ outcome: 'not_allowed' });
    expect(w.doc(target)).toEqual(before);
    expect(w.files.objects.has(hijack.path)).toBe(false);
  });

  it('ignores objects outside the pending area', async () => {
    const w = world();
    expect(await processUpload({ path: `${DOCS}/d1/v1`, generation: '1', size: 1, metadata: {} }, w.deps())).toEqual({
      outcome: 'ignored',
    });
  });

  describe('duplicates', () => {
    it('marks a second copy of the same file in the matter duplicateOf the first', async () => {
      const w = world();
      const bytes = fakePdf('same');
      const first = w.upload(bytes);
      await processUpload(first, w.deps());
      const second = w.upload(bytes, { fileName: 'Copy of brief.pdf', uid: 'user-paralegal' });
      expect(await processUpload(second, w.deps())).toEqual({
        outcome: 'duplicate',
        docId: second.uploadId,
        version: 1,
      });
      expect(w.doc(`${DOCS}/${second.uploadId}`)).toMatchObject({
        duplicateOf: first.uploadId,
        scan: { status: 'clean' },
      });
      // The index still points at the original.
      expect(w.doc(`${MATTERS}/m1/documentHashes/${sha256Of(bytes)}`)).toMatchObject({ documentId: first.uploadId });
      // The same file in another matter is not a duplicate.
      const elsewhere = w.upload(bytes, { matterId: 'm2' });
      expect(await processUpload(elsewhere, w.deps())).toMatchObject({ outcome: 'stored' });
    });

    it('is not a duplicate of a removed document (the index moves to the new copy)', async () => {
      const w = world();
      const bytes = fakePdf('again');
      const first = w.upload(bytes);
      await processUpload(first, w.deps());
      await w.db.doc(`${DOCS}/${first.uploadId}`).update({ deletedAt: new Date(), deletedBy: 'user-lawyer' });
      const second = w.upload(bytes);
      expect(await processUpload(second, w.deps())).toMatchObject({ outcome: 'stored' });
      expect(w.doc(`${MATTERS}/m1/documentHashes/${sha256Of(bytes)}`)).toMatchObject({ documentId: second.uploadId });
    });
  });

  describe('versions', () => {
    async function withDocument() {
      const w = world();
      const first = w.upload(await samplePdf({ pages: 1 }));
      await processUpload(first, w.deps());
      return { w, docId: first.uploadId };
    }

    it('adds a new version to the target document and makes it current', async () => {
      const { w, docId } = await withDocument();
      const next = w.upload(await samplePdf({ pages: 5 }), {
        fileName: 'Fictional brief v2.pdf',
        uid: 'user-paralegal',
        extra: { documentId: docId },
      });
      expect(await processUpload(next, w.deps())).toEqual({ outcome: 'stored', docId, version: 2 });
      const stored = w.doc(`${DOCS}/${docId}`) as Data;
      expect(stored).toMatchObject({
        version: 2,
        pageCount: 5,
        storagePath: `${DOCS}/${docId}/v2`,
        name: 'Fictional brief.pdf',
      });
      expect((stored['versions'] as Data[]).map((v) => [v['version'], v['fileName'], v['uploadedBy']])).toEqual([
        [1, 'Fictional brief.pdf', 'user-lawyer'],
        [2, 'Fictional brief v2.pdf', 'user-paralegal'],
      ]);
      expect(w.files.objects.has(`${DOCS}/${docId}/v1`)).toBe(true);
      expect(w.files.objects.has(`${DOCS}/${docId}/v2`)).toBe(true);
      expect(w.docs.has(`${DOCS}/${next.uploadId}`)).toBe(false);
    });

    it('an infected new version leaves the document clean on its current version', async () => {
      const { w, docId } = await withDocument();
      const bad = w.upload(EICAR_TEST_STRING, { fileName: 'notes.txt', extra: { documentId: docId } });
      expect(await processUpload(bad, w.deps())).toMatchObject({ outcome: 'infected', docId });
      expect(w.doc(`${DOCS}/${docId}`)).toMatchObject({
        version: 1,
        scan: { status: 'clean' },
        upload: { status: 'infected', uploadId: bad.uploadId },
      });
    });

    it.each([
      ['missing', 'doc-missing0', {}],
      ['removed', null, { deletedAt: new Date('2026-10-01T00:00:00Z') }],
      ['not scanned clean', null, { scan: { status: 'infected' } }],
    ])('refuses a new version of a %s document', async (_label, id, patch) => {
      const { w, docId } = await withDocument();
      const target = id ?? docId;
      if (!id) await w.db.doc(`${DOCS}/${docId}`).update(patch);
      const next = w.upload(fakePdf('v2'), { extra: { documentId: target } });
      expect(await processUpload(next, w.deps())).toMatchObject({
        outcome: 'not_allowed',
        reason: 'target_unavailable',
      });
      expect(w.files.objects.has(next.path)).toBe(false);
    });

    it('a paralegal cannot add a version to a privileged document', async () => {
      const { w, docId } = await withDocument();
      await w.db.doc(`${DOCS}/${docId}`).update({ privileged: true });
      const next = w.upload(fakePdf('v2'), { uid: 'user-paralegal', extra: { documentId: docId } });
      expect(await processUpload(next, w.deps())).toMatchObject({
        outcome: 'not_allowed',
        reason: 'target_unavailable',
      });
    });

    it('stops at the version limit', async () => {
      const { w, docId } = await withDocument();
      const versions = Array.from({ length: DOCUMENT_VERSIONS_MAX }, (_, i) => ({
        version: i + 1,
        uploadId: `old-${i}`,
      }));
      await w.db.doc(`${DOCS}/${docId}`).update({ versions, version: DOCUMENT_VERSIONS_MAX });
      const next = w.upload(fakePdf('too many'), { extra: { documentId: docId } });
      expect(await processUpload(next, w.deps())).toMatchObject({ outcome: 'rejected', reason: 'version_limit' });
    });
  });

  describe('idempotency', () => {
    it('a redelivered event adds nothing', async () => {
      const w = world();
      const event = w.upload(fakePdf('once'));
      await processUpload(event, w.deps());
      const before = w.doc(`${DOCS}/${event.uploadId}`);
      expect(await processUpload(event, w.deps())).toEqual({ outcome: 'already_done', docId: event.uploadId });
      expect(w.doc(`${DOCS}/${event.uploadId}`)).toEqual(before);
      expect(w.after).toHaveLength(1);
    });

    it('a retry after a crash reuses the reserved version number', async () => {
      const w = world();
      const event = w.upload(fakePdf('crash'));
      const crashing: PipelineDeps = {
        ...w.deps(),
        files: Object.assign(Object.create(w.files) as MemoryFiles, {
          write: async () => Promise.reject(new Error('network')),
        }),
      };
      await expect(processUpload(event, crashing)).rejects.toThrow('network');
      expect(w.doc(`${DOCS}/${event.uploadId}`)).toMatchObject({ versionSeq: 1, upload: { version: 1 } });
      expect(await processUpload(event, w.deps())).toEqual({ outcome: 'stored', docId: event.uploadId, version: 1 });
      expect(w.doc(`${DOCS}/${event.uploadId}`)).toMatchObject({ versionSeq: 1, version: 1 });
    });

    it('reserveVersion counts past every version ever reserved', async () => {
      const w = world();
      const ref = w.db.doc(`${DOCS}/d1`);
      await ref.set({ version: 2, versionSeq: 4, versions: [{ version: 1 }, { version: 2 }] });
      expect(await reserveVersion(w.db, ref, 'restore-1')).toBe(5);
      expect(await reserveVersion(w.db, ref, 'restore-2')).toBe(6);
    });
  });
});

describe('expirePendingUploads', () => {
  it('deletes quarantined uploads older than the TTL and marks their documents expired', async () => {
    const w = world();
    const old = w.upload(`${FAKE_SCANNER_TIMEOUT_MARKER}`, { fileName: 'stuck.txt' });
    await processUpload(old, w.deps());
    const young = w.upload(fakePdf('young'));
    (w.files.objects.get(young.path) as { object: { timeCreated: Date } }).object.timeCreated = new Date(
      '2026-10-05T23:00:00Z',
    );
    w.clock.set(new Date('2026-10-06T01:00:00Z'));
    expect(await expirePendingUploads(w.deps(), 24 * 60 * 60 * 1000)).toBe(1);
    expect(w.files.objects.has(old.path)).toBe(false);
    expect(w.files.objects.has(young.path)).toBe(true);
    expect(w.doc(`${DOCS}/${old.uploadId}`)).toMatchObject({
      upload: { status: 'expired' },
      scan: { status: 'error' },
    });
  });
});

describe('helpers', () => {
  it('analysePdf reads page counts and encryption, and survives damage', async () => {
    expect(await analysePdf(await samplePdf({ pages: 4 }))).toEqual({ pageCount: 4, encrypted: false });
    expect(await analysePdf(await samplePdf({ encrypted: true }))).toEqual({ encrypted: true });
    expect(await analysePdf(Buffer.from(fakePdf('broken')))).toEqual({ encrypted: false });
  });

  it('scanWithTimeout passes verdicts through and turns failures into ScannerUnavailableError', async () => {
    const request = { bucket: 'b', path: 'p', data: Buffer.from('fictional') };
    await expect(scanWithTimeout(fakeMalwareScan, request, 1000)).resolves.toEqual({ verdict: 'clean' });
    const broken: MalwareScanPort = { scan: async () => Promise.reject(new TypeError('boom')) };
    await expect(scanWithTimeout(broken, request, 1000)).rejects.toMatchObject({ reason: 'unavailable' });
    let aborted = false;
    const slow: MalwareScanPort = {
      scan: (_r, signal) => new Promise(() => signal?.addEventListener('abort', () => void (aborted = true))),
    };
    await expect(scanWithTimeout(slow, request, 5)).rejects.toMatchObject({ reason: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('timestamps are stored as Firestore timestamps', async () => {
    const w = world();
    const event = w.upload(fakePdf('ts'));
    await processUpload(event, w.deps());
    expect((w.doc(`${DOCS}/${event.uploadId}`) as Data)['createdAt']).toBeInstanceOf(Timestamp);
  });
});
