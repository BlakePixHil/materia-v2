import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { MESSAGE_TEXT_MAX, MessageRenditionSchema, renditionPath, type Role } from '@materia/domain';

import { saveAttachmentDefinition } from './callables';
import { parseMessage, safeAttachmentName } from './email';
import { processUpload } from './pipeline';
import { startRenditions } from './renditions';
import { MemoryFiles, sampleEml, sampleMsg, sha256Of } from './testing';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakeMalwareScan, fakePorts } from '../ports/fakes';

/** Email documents (CORE-12): parsing, the message rendition and saving attachments. Fictional data only. */

const ORG = 'org-a';
const MATTERS = `orgs/${ORG}/matters`;
const DOCS = `${MATTERS}/m1/documents`;
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
type Data = Record<string, unknown>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('parseMessage', () => {
  it('reads an .eml: headers, plain text and attachments', async () => {
    const parsed = await parseMessage(
      'Letter.eml',
      sampleEml({
        attachments: [
          { fileName: 'Inventory of assets.txt', mime: 'text/plain', content: 'Fictional inventory\n' },
          { fileName: 'tool.exe', mime: 'application/octet-stream', content: 'MZ fictional' },
        ],
      }),
    );
    expect(MessageRenditionSchema.parse(parsed.rendition)).toEqual({
      format: 'message.v1',
      subject: 'Fictional valuation letter',
      from: { name: 'Rowan Example', address: 'rowan@example.test' },
      to: [{ name: 'Sam Sample', address: 'sam@example.test' }],
      cc: [{ name: 'Kit Placeholder', address: 'kit@example.test' }],
      date: '2026-10-04T22:30:00.000Z',
      text: expect.stringContaining('Please find the fictional valuation attached.'),
      textTruncated: false,
      attachments: [
        { index: 0, fileName: 'Inventory of assets.txt', mime: 'text/plain', sizeBytes: 20, savable: true },
        { index: 1, fileName: 'tool.exe', mime: 'application/octet-stream', sizeBytes: 12, savable: false },
      ],
      attachmentsTruncated: false,
    });
    expect(parsed.attachment(0)?.data.toString()).toBe('Fictional inventory\n');
    expect(parsed.attachment(5)).toBeNull();
  });

  it('reads an Outlook .msg', async () => {
    const parsed = await parseMessage('Statement.msg', sampleMsg());
    expect(parsed.rendition).toMatchObject({
      subject: 'Fictional settlement statement',
      from: { name: 'Rowan Example', address: 'rowan@example.test' },
      to: [{ name: 'Sam Sample', address: 'sam@example.test' }],
      cc: [],
      text: 'The fictional settlement statement is attached.',
      attachments: [{ index: 0, fileName: 'Inventory of assets.txt', mime: 'text/plain', savable: true }],
    });
    expect(parsed.attachment(0)?.data.toString()).toBe('Fictional inventory: one bicycle.\n');
  });

  it('turns HTML-only bodies into text and caps long ones', async () => {
    const html = Buffer.from(
      [
        'From: rowan@example.test',
        'Subject: Fictional HTML',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Dear Sam,</p><script>alert(1)</script><p>Fictional &amp; brief.</p>',
      ].join('\r\n'),
    );
    const parsed = await parseMessage('html.eml', html);
    expect(parsed.rendition.text).toContain('Fictional & brief.');
    expect(parsed.rendition.text).not.toContain('<');
    expect(parsed.rendition.text).not.toContain('alert');
    const long = await parseMessage(
      'long.eml',
      sampleEml({ text: 'x'.repeat(MESSAGE_TEXT_MAX + 10), attachments: [] }),
    );
    expect(long.rendition).toMatchObject({ textTruncated: true });
    expect(long.rendition.text).toHaveLength(MESSAGE_TEXT_MAX);
  });

  it('refuses other files and unreadable messages', async () => {
    await expect(parseMessage('notes.txt', Buffer.from('x'))).rejects.toThrow();
    await expect(parseMessage('broken.msg', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]))).rejects.toThrow();
  });

  it('keeps attachment names to a plain base name', () => {
    expect(safeAttachmentName('../../etc/passwd.txt', 0)).toBe('passwd.txt');
    expect(safeAttachmentName('C:\\Users\\x\\Report.pdf', 0)).toBe('Report.pdf');
    expect(safeAttachmentName('bad\u0000name.pdf', 0)).toBe('badname.pdf');
    expect(safeAttachmentName(undefined, 2)).toBe('attachment-3');
  });
});

function world() {
  const version = (fileName: string, n = 1) => ({
    version: n,
    storagePath: `${DOCS}/d-mail/v${n}`,
    fileName,
    mime: 'message/rfc822',
    sizeBytes: 100,
    sha256: 'a'.repeat(64),
    uploadedAt: new Date('2026-10-01T00:00:00Z'),
    uploadedBy: 'user-lawyer',
  });
  const emailDoc = (extra: Data = {}) => ({
    ...meta,
    orgId: ORG,
    matterId: 'm1',
    name: 'Valuation email',
    category: 'correspondence',
    privileged: false,
    version: 1,
    versions: [version('Valuation.eml')],
    scan: { status: 'clean' },
    deletedAt: null,
    ...extra,
  });
  const store = memoryFirestore({
    [`orgs/${ORG}/members/user-lawyer`]: { ...meta, role: 'lawyer', status: 'active' },
    [`orgs/${ORG}/members/user-paralegal`]: { ...meta, role: 'paralegal', status: 'active' },
    [`${MATTERS}/m1`]: { ...meta, number: 'BL-2026-0042', status: 'active', privileged: false, deletedAt: null },
    [`${DOCS}/d-mail`]: emailDoc(),
    [`${DOCS}/d-msg`]: emailDoc({ versions: [{ ...version('Statement.msg'), storagePath: `${DOCS}/d-msg/v1` }] }),
    [`${DOCS}/d-priv`]: emailDoc({
      privileged: true,
      versions: [{ ...version('Advice.eml'), storagePath: `${DOCS}/d-priv/v1` }],
    }),
    [`${DOCS}/d-pdf`]: emailDoc({ versions: [{ ...version('Brief.pdf'), storagePath: `${DOCS}/d-pdf/v1` }] }),
  });
  const files = new MemoryFiles();
  files.put(
    `${DOCS}/d-mail/v1`,
    sampleEml({
      attachments: [
        { fileName: 'Inventory of assets.txt', mime: 'text/plain', content: 'Fictional inventory\n' },
        { fileName: 'tool.exe', mime: 'application/octet-stream', content: 'MZ fictional' },
        { fileName: 'Photo.png', mime: 'image/png', content: PNG },
      ],
    }),
  );
  files.put(`${DOCS}/d-msg/v1`, sampleMsg());
  files.put(`${DOCS}/d-priv/v1`, sampleEml());
  files.put(`${DOCS}/d-pdf/v1`, '%PDF-1.7 fictional');
  const clock = new FakeClock(new Date('2026-10-05T00:00:00.000Z'));
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => fakePorts(),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const def = saveAttachmentDefinition(() => files);
  const save = (data: Data, role: Role = 'lawyer') =>
    runCallable(
      def as unknown as CallableDefinition<never, { uploadId: string; docId: string; fileName: string }>,
      {
        data: { requestId: randomUUID(), matterId: 'm1', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(),
    );
  const log = createLog({ fn: 'test' }, () => undefined);
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  return { ...store, files, clock, save, log, doc, deps };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

describe('startRenditions', () => {
  it('writes the message rendition and records it on the version and the current document', async () => {
    const w = world();
    const data = (await w.files.read(`${DOCS}/d-mail/v1`)) as Buffer;
    const version = (w.doc(`${DOCS}/d-mail`)?.['versions'] as never[])[0] as never;
    await startRenditions(
      { db: w.db, files: w.files, ports: fakePorts(), log: w.log, clock: w.clock },
      { orgId: ORG, matterId: 'm1', docId: 'd-mail', version, kind: 'text', data, uploaderUid: 'user-lawyer' },
    );
    const path = renditionPath(ORG, 'm1', 'd-mail', 1, 'message');
    const json = JSON.parse(((await w.files.read(path)) as Buffer).toString());
    expect(MessageRenditionSchema.parse(json)).toMatchObject({ subject: 'Fictional valuation letter' });
    expect(w.files.objects.get(path)?.object.contentType).toBe('application/json');
    expect(w.doc(`${DOCS}/d-mail`)).toMatchObject({
      renditions: { message: path },
      versions: [expect.objectContaining({ renditions: { message: path } })],
    });
  });

  it('skips other files and unreadable messages', async () => {
    const w = world();
    const deps = { db: w.db, files: w.files, ports: fakePorts(), log: w.log, clock: w.clock };
    const base = { orgId: ORG, matterId: 'm1', docId: 'd-mail', kind: 'text' as const, uploaderUid: 'user-lawyer' };
    const versionOf = (fileName: string) => ({ ...(w.doc(`${DOCS}/d-mail`)?.['versions'] as Data[])[0], fileName });
    await startRenditions(deps, { ...base, version: versionOf('Brief.pdf') as never, data: Buffer.from('%PDF-') });
    await startRenditions(deps, { ...base, version: versionOf('Bad.msg') as never, data: Buffer.from('not cfb') });
    expect([...w.files.objects.keys()].some((p) => p.includes('/renditions/'))).toBe(false);
  });
});

describe('documents-saveAttachment', () => {
  it('uploads the attachment to the pending area as the caller; the pipeline stores it', async () => {
    const w = world();
    const result = await w.save({ docId: 'd-mail', attachmentIndex: 0 });
    expect(result).toMatchObject({ fileName: 'Inventory of assets.txt' });
    expect(result.uploadId).toMatch(/^att-[0-9a-f]{40}$/);
    expect(result.docId).toBe(result.uploadId);
    const path = `${MATTERS}/m1/pending/${result.uploadId}`;
    const pending = w.files.objects.get(path);
    expect(pending?.object).toMatchObject({
      contentType: 'text/plain',
      metadata: {
        uploaderUid: 'user-lawyer',
        fileName: 'Inventory of assets.txt',
        sha256: sha256Of('Fictional inventory\n'),
        category: 'correspondence',
      },
    });

    // What documents-onUpload then does with it.
    const outcome = await processUpload(
      { path, generation: pending?.object.generation as string, size: 20, metadata: pending?.object.metadata ?? {} },
      {
        db: w.db,
        files: w.files,
        scanner: fakeMalwareScan,
        clock: w.clock,
        log: w.log,
        ports: fakePorts(),
        scheduleRescan: async () => undefined,
      },
    );
    expect(outcome).toMatchObject({ outcome: 'stored', docId: result.uploadId });
    expect(w.doc(`${DOCS}/${result.uploadId}`)).toMatchObject({
      name: 'Inventory of assets.txt',
      category: 'correspondence',
      createdBy: 'user-lawyer',
    });
  });

  it('saves from .msg files, keeps a category and marks attachments of privileged emails privileged', async () => {
    const w = world();
    const fromMsg = await w.save({ docId: 'd-msg', attachmentIndex: 0, category: 'financial' });
    expect(w.files.objects.get(`${MATTERS}/m1/pending/${fromMsg.uploadId}`)?.object.metadata).toMatchObject({
      category: 'financial',
    });
    const privileged = await w.save({ docId: 'd-priv', attachmentIndex: 0 });
    expect(w.files.objects.get(`${MATTERS}/m1/pending/${privileged.uploadId}`)?.object.metadata).toMatchObject({
      privileged: 'true',
    });
  });

  it('a retry of the same request writes the same upload once', async () => {
    const w = world();
    const requestId = randomUUID();
    const first = await w.save({ docId: 'd-mail', attachmentIndex: 2, requestId });
    const again = await w.save({ docId: 'd-mail', attachmentIndex: 2, requestId });
    expect(again.uploadId).toBe(first.uploadId);
    expect([...w.files.objects.keys()].filter((p) => p.includes('/pending/'))).toHaveLength(1);
  });

  it.each([
    ['a type off the allow-list', { docId: 'd-mail', attachmentIndex: 1 }, 'lawyer', 'failed-precondition'],
    ['a missing attachment', { docId: 'd-mail', attachmentIndex: 9 }, 'lawyer', 'not-found'],
    ['a document that is not an email', { docId: 'd-pdf', attachmentIndex: 0 }, 'lawyer', 'failed-precondition'],
    ['a privileged email as a paralegal', { docId: 'd-priv', attachmentIndex: 0 }, 'paralegal', 'not-found'],
    ['readonly', { docId: 'd-mail', attachmentIndex: 0 }, 'readonly', 'permission-denied'],
  ] as const)('refuses %s', async (_label, input, role, code) => {
    const w = world();
    expect(await failure(w.save(input, role))).toMatchObject({ code });
    expect([...w.files.objects.keys()].some((p) => p.includes('/pending/'))).toBe(false);
  });
});
