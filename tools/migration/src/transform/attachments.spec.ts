import { createHash } from 'node:crypto';

import { domain } from '../domain.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { FIXTURE_DIR, FIXTURE_UIDS } from '../legacy/fixtures.ts';
import type { StorageObject } from '../legacy/snapshot.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { documentTarget, inlineImageDocument, inlineImageName, mapAttachment, mapAttachments } from './attachments.ts';
import type { MatterRef } from './comments.ts';
import { migId, Warnings, type TransformContext, type WarningCode } from './context.ts';
import type { InlineImage } from './html.ts';
import { CopyPlanSchema } from './run.ts';

const UID = FIXTURE_UIDS.subject;
const COLLEAGUE = FIXTURE_UIDS.colleague;
const CARD = 'workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/cards/WillsCardAuto0000002';
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const CARD_CREATED = new Date('2025-01-10T00:30:00.000Z');
const CARD_UPDATED = new Date('2025-02-10T00:30:00.000Z');
const MB = 1024 * 1024;

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map([[COLLEAGUE, 'Jordan Ellis']]),
    members: new Set([UID]),
    warnings: new Warnings(),
    ...over,
  };
}

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

const matter: MatterRef = {
  orgId: 'org1',
  matterId: migId(CARD),
  cardPath: CARD,
  createdAt: CARD_CREATED,
  updatedAt: CARD_UPDATED,
};

const attachmentPath = (id: string) => `${CARD}/attachments/${id}`;

/** An attachment document like the fixtures' (`attachments.json`). */
function attachment(id: string, ext: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    workflowId: '0b6f1c2e-5d4a-4c3b-9a8e-111111111111',
    cardId: 'WillsCardAuto0000002',
    originalFileName: `fictional-file.${ext}`,
    storagePath: `${attachmentPath(id)}.${ext}`,
    fileExtension: `.${ext}`,
    mimeType: 'application/pdf',
    sizeBytes: 120000,
    uploadedBy: UID,
    uploadedAt: '2025-02-01T00:00:00.000Z',
    downloadUrl: 'https://firebasestorage.googleapis.com/v0/b/fictional/o/x?alt=media',
    createdBy: UID,
    modifiedBy: UID,
    createdOn: '2025-02-01T00:00:00.000Z',
    updatedOn: '2025-02-01T00:00:00.000Z',
    ...over,
  };
}

const objectsOf = (...objects: StorageObject[]) => new Map(objects.map((object) => [object.name, object]));

function expectValid(record: { data?: Record<string, unknown>; copy?: unknown }) {
  expect(domain.MatterDocumentSchema.parse(record.data)).toEqual(record.data);
  expect(CopyPlanSchema.parse(record.copy)).toEqual(record.copy);
}

describe('mapAttachment', () => {
  const id = 'a77a0000-0000-4000-8000-000000000001';
  const path = attachmentPath(id);
  const pdf: StorageObject = {
    name: `${path}.pdf`,
    size: 120000,
    contentType: 'application/pdf',
    md5Hash: 'bWQ1LWZpY3Rpb25hbA==',
    crc32c: 'AAAAAA==',
    generation: '1700000000000001',
  };

  it('maps an attachment to a document at version 0, waiting for its copy', () => {
    const ctx = makeCtx();
    const record = mapAttachment(ctx, matter, path, attachment(id, 'pdf'), objectsOf(pdf));
    const docId = migId(path);
    expect(record.entity).toBe('documents');
    expect(record.legacyPath).toBe(path);
    expect(record.path).toBe(`orgs/org1/matters/${matter.matterId}/documents/${docId}`);
    const uploaded = new Date('2025-02-01T00:00:00.000Z');
    expect(record.data).toEqual({
      orgId: 'org1',
      matterId: matter.matterId,
      name: 'fictional-file.pdf',
      category: 'other',
      privileged: false,
      tags: [],
      version: 0,
      versions: [],
      scan: { status: 'pending' },
      ingest: { status: 'pending' },
      source: 'migration',
      encrypted: false,
      accessRestricted: false,
      search: [],
      deletedAt: null,
      createdAt: uploaded,
      createdBy: UID,
      updatedAt: uploaded,
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: path, loadedAt: AS_OF },
    });
    expect(record.copy).toEqual({
      source: `${path}.pdf`,
      target: `orgs/org1/matters/${matter.matterId}/documents/${docId}/v1`,
      fileName: 'fictional-file.pdf',
      mime: 'application/pdf',
      sizeBytes: 120000,
      md5Hash: 'bWQ1LWZpY3Rpb25hbA==',
      crc32c: 'AAAAAA==',
      generation: '1700000000000001',
    });
    expectValid(record);
    expect(warned(ctx)).toEqual({});
  });

  it('copies to the v1 path of the document', () => {
    expect(documentTarget(matter, 'doc1')).toBe(`orgs/org1/matters/${matter.matterId}/documents/doc1/v1`);
    const record = mapAttachment(makeCtx(), matter, path, attachment(id, 'pdf'), objectsOf(pdf));
    expect(record.copy?.target).toBe(`${record.path}/v1`);
  });

  it("finds the object by the attachment's id under the card when storagePath doesn't name it", () => {
    const ctx = makeCtx();
    const record = mapAttachment(
      ctx,
      matter,
      path,
      attachment(id, 'pdf', { storagePath: 'somewhere/else.pdf' }),
      objectsOf({ name: 'workflows/other/cards/X/attachments/a77a.pdf', size: 1 }, pdf),
    );
    expect(record.copy?.source).toBe(pdf.name);
    expect(warned(ctx)).toEqual({});
  });

  it('finds the object by id when the document has no storagePath', () => {
    const record = mapAttachment(
      makeCtx(),
      matter,
      path,
      attachment(id, 'pdf', { storagePath: undefined }),
      objectsOf(pdf),
    );
    expect(record.copy?.source).toBe(pdf.name);
  });

  it("never takes the object of another attachment whose id starts with this one's", () => {
    const ctx = makeCtx();
    const record = mapAttachment(
      ctx,
      matter,
      attachmentPath('a1'),
      attachment('a1', 'pdf', { storagePath: '' }),
      objectsOf({ name: `${attachmentPath('a12')}.pdf`, size: 10 }),
    );
    expect(record.copy).not.toHaveProperty('source');
    expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_OBJECT_MISSING: [attachmentPath('a1')] });
  });

  it('finds an object named by the id alone, with no extension', () => {
    const ctx = makeCtx();
    const record = mapAttachment(
      ctx,
      matter,
      path,
      attachment(id, 'pdf', { storagePath: '' }),
      objectsOf({ name: path, size: 120000, contentType: 'application/pdf' }),
    );
    expect(record.copy?.source).toBe(path);
    expect(warned(ctx)).toEqual({});
  });

  it('never takes an object further down under the id', () => {
    const record = mapAttachment(
      makeCtx(),
      matter,
      path,
      attachment(id, 'pdf', { storagePath: '' }),
      objectsOf({ name: `${path}.pdf/thumbnail.png`, size: 10 }),
    );
    expect(record.copy).not.toHaveProperty('source');
  });

  it('keeps the document when its object is missing, with nothing to copy', () => {
    const ctx = makeCtx();
    const record = mapAttachment(ctx, matter, path, attachment(id, 'pdf'), objectsOf());
    expect(record.copy).toEqual({
      target: `${record.path}/v1`,
      fileName: 'fictional-file.pdf',
      mime: 'application/pdf',
      sizeBytes: 120000,
    });
    expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_OBJECT_MISSING: [path] });
    expectValid(record);
  });

  it('sizes a missing object with no recorded size at 0', () => {
    const record = mapAttachment(makeCtx(), matter, path, attachment(id, 'pdf', { sizeBytes: '12 KB' }), objectsOf());
    expect(record.copy?.sizeBytes).toBe(0);
  });

  it("uses the object's size when the recorded size differs", () => {
    const ctx = makeCtx();
    const msgId = 'a77a0000-0000-4000-8000-000000000004';
    const msgPath = attachmentPath(msgId);
    const record = mapAttachment(
      ctx,
      matter,
      msgPath,
      attachment(msgId, 'msg', { mimeType: '', sizeBytes: 40000 }),
      objectsOf({ name: `${msgPath}.msg`, size: 41000 }),
    );
    expect(record.copy).toMatchObject({ sizeBytes: 41000, mime: 'application/vnd.ms-outlook' });
    expect(warned(ctx)).toEqual({
      MIG_W_ATTACHMENT_SIZE_MISMATCH: [msgPath],
      MIG_W_ATTACHMENT_TYPE_FROM_EXTENSION: [msgPath],
    });
    expectValid(record);
  });

  it("doesn't warn about a size when none was recorded", () => {
    const ctx = makeCtx();
    const record = mapAttachment(ctx, matter, path, attachment(id, 'pdf', { sizeBytes: undefined }), objectsOf(pdf));
    expect(record.copy?.sizeBytes).toBe(120000);
    expect(warned(ctx)).toEqual({});
  });

  it('still migrates a file over the 25 MB legacy limit, with a warning', () => {
    const ctx = makeCtx();
    const big = { ...pdf, size: 26 * MB };
    const record = mapAttachment(ctx, matter, path, attachment(id, 'pdf', { sizeBytes: 26 * MB }), objectsOf(big));
    expect(record.copy?.sizeBytes).toBe(26 * MB);
    expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_OVERSIZE: [path] });
  });

  it('takes exactly 25 MB without a warning', () => {
    const ctx = makeCtx();
    const record = mapAttachment(
      ctx,
      matter,
      path,
      attachment(id, 'pdf', { sizeBytes: 25 * MB }),
      objectsOf({ ...pdf, size: 25 * MB }),
    );
    expect(record.copy?.sizeBytes).toBe(25 * MB);
    expect(warned(ctx)).toEqual({});
  });

  it.each([
    ['svg', 'image/svg+xml'],
    ['gif', 'image/gif'],
    ['bmp', 'image/bmp'],
  ])('migrates a .%s file as download-only', (ext, mime) => {
    const ctx = makeCtx();
    const object = { name: `${path}.${ext}`, size: 2000, contentType: mime };
    const record = mapAttachment(
      ctx,
      matter,
      path,
      attachment(id, ext, { mimeType: mime, sizeBytes: 2000 }),
      objectsOf(object),
    );
    expect(record.copy).toMatchObject({ mime, downloadOnly: true });
    expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_DOWNLOAD_ONLY: [path] });
    expectValid(record);
  });

  it('goes by the type as well as the extension for download-only files', () => {
    const ctx = makeCtx();
    const record = mapAttachment(
      ctx,
      matter,
      path,
      attachment(id, 'png', { originalFileName: 'diagram.png', mimeType: 'IMAGE/SVG+XML' }),
      objectsOf(pdf),
    );
    expect(record.copy?.downloadOnly).toBe(true);
    expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_DOWNLOAD_ONLY: [path] });
  });

  it('serves ordinary files inline', () => {
    const jpeg = mapAttachment(
      makeCtx(),
      matter,
      path,
      attachment(id, 'jpg', { mimeType: 'image/jpeg' }),
      objectsOf(pdf),
    );
    expect(jpeg.copy).not.toHaveProperty('downloadOnly');
  });

  describe('a missing content type', () => {
    it.each([
      ['msg', 'application/vnd.ms-outlook'],
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['eml', 'message/rfc822'],
      ['JPEG', 'image/jpeg'],
      ['weird', 'application/octet-stream'],
    ])('comes from the extension (.%s is %s)', (ext, mime) => {
      const ctx = makeCtx();
      const record = mapAttachment(
        ctx,
        matter,
        path,
        attachment(id, ext, { mimeType: '' }),
        objectsOf({ name: `${path}.${ext}`, size: 120000 }),
      );
      expect(record.copy?.mime).toBe(mime);
      expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_TYPE_FROM_EXTENSION: [path] });
      expectValid(record);
    });

    it("comes from the object's content type first, without a warning", () => {
      const ctx = makeCtx();
      const record = mapAttachment(ctx, matter, path, attachment(id, 'pdf', { mimeType: null }), objectsOf(pdf));
      expect(record.copy?.mime).toBe('application/pdf');
      expect(warned(ctx)).toEqual({});
    });

    it("reads the extension from fileExtension, then the object's name, when the file name has none", () => {
      const fromField = mapAttachment(
        makeCtx(),
        matter,
        path,
        attachment(id, 'msg', { originalFileName: 'Letter from bank', mimeType: '' }),
        objectsOf({ name: `${path}.msg`, size: 120000 }),
      );
      expect(fromField.copy?.mime).toBe('application/vnd.ms-outlook');
      const fromObject = mapAttachment(
        makeCtx(),
        matter,
        path,
        attachment(id, 'msg', { originalFileName: 'Letter from bank', fileExtension: '', mimeType: '' }),
        objectsOf({ name: `${path}.eml`, size: 120000 }),
      );
      expect(fromObject.copy?.mime).toBe('message/rfc822');
    });

    it('is application/octet-stream with nothing to go on', () => {
      const record = mapAttachment(
        makeCtx(),
        matter,
        path,
        attachment(id, 'pdf', { originalFileName: '', fileExtension: undefined, mimeType: '', storagePath: '' }),
        objectsOf(),
      );
      expect(record.copy).toMatchObject({ mime: 'application/octet-stream', fileName: id });
      expect(record.data?.['name']).toBe(id);
    });
  });

  it('names the file from its id and extension when it has no original name', () => {
    const record = mapAttachment(
      makeCtx(),
      matter,
      path,
      attachment(id, 'pdf', { originalFileName: '  ' }),
      objectsOf(pdf),
    );
    expect(record.data?.['name']).toBe(`${id}.pdf`);
    expect(record.copy?.fileName).toBe(`${id}.pdf`);
  });

  it('cuts a file name longer than 255 characters, keeping its extension, in the document and the copy', () => {
    const ctx = makeCtx();
    const record = mapAttachment(
      ctx,
      matter,
      path,
      attachment(id, 'pdf', { originalFileName: `${'n'.repeat(300)}.pdf` }),
      objectsOf(pdf),
    );
    const cut = `${'n'.repeat(251)}.pdf`;
    expect(cut).toHaveLength(255);
    expect(record.data?.['name']).toBe(cut);
    expect(record.copy?.fileName).toBe(cut);
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [path] });
    expectValid(record);
  });

  it('cuts a long file name with no extension to 255 characters', () => {
    const ctx = makeCtx();
    const record = mapAttachment(
      ctx,
      matter,
      path,
      attachment(id, 'pdf', { originalFileName: 'n'.repeat(300) }),
      objectsOf(pdf),
    );
    expect(record.data?.['name']).toBe('n'.repeat(255));
    expect(record.copy?.fileName).toBe('n'.repeat(255));
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [path] });
    expectValid(record);
  });

  it('keeps a file name of exactly 255 characters', () => {
    const ctx = makeCtx();
    const name = `${'n'.repeat(251)}.pdf`;
    const record = mapAttachment(ctx, matter, path, attachment(id, 'pdf', { originalFileName: name }), objectsOf(pdf));
    expect(record.data?.['name']).toBe(name);
    expect(record.copy?.fileName).toBe(name);
    expect(warned(ctx)).toEqual({});
  });

  it("is the migration's when someone else uploaded it", () => {
    const record = mapAttachment(
      makeCtx(),
      matter,
      path,
      attachment(id, 'pdf', { uploadedBy: COLLEAGUE }),
      objectsOf(pdf),
    );
    expect(record.data).toMatchObject({ createdBy: 'migration', updatedBy: 'migration' });
    const unknown = mapAttachment(
      makeCtx(),
      matter,
      path,
      attachment(id, 'pdf', { uploadedBy: undefined }),
      objectsOf(pdf),
    );
    expect(unknown.data).toMatchObject({ createdBy: 'migration' });
  });

  describe('dates', () => {
    it('is created when it was uploaded, and updated no earlier', () => {
      const record = mapAttachment(
        makeCtx(),
        matter,
        path,
        attachment(id, 'pdf', {
          uploadedAt: '2025-02-03T00:00:00.000Z',
          createdOn: '2025-02-01T00:00:00.000Z',
          updatedOn: '2025-02-02T00:00:00.000Z',
        }),
        objectsOf(pdf),
      );
      expect(record.data).toMatchObject({
        createdAt: new Date('2025-02-03T00:00:00.000Z'),
        updatedAt: new Date('2025-02-03T00:00:00.000Z'),
      });
    });

    it('keeps a later update', () => {
      const record = mapAttachment(
        makeCtx(),
        matter,
        path,
        attachment(id, 'pdf', { uploadedAt: '2025-02-01T00:00:00.000Z', updatedOn: '2025-03-01T00:00:00.000Z' }),
        objectsOf(pdf),
      );
      expect(record.data).toMatchObject({
        createdAt: new Date('2025-02-01T00:00:00.000Z'),
        updatedAt: new Date('2025-03-01T00:00:00.000Z'),
      });
    });

    it('falls back to createdOn when uploadedAt is missing or invalid', () => {
      const ctx = makeCtx();
      const record = mapAttachment(
        ctx,
        matter,
        path,
        attachment(id, 'pdf', { uploadedAt: 'soon', createdOn: '2025-01-15T00:00:00.000Z', updatedOn: null }),
        objectsOf(pdf),
      );
      expect(record.data).toMatchObject({
        createdAt: new Date('2025-01-15T00:00:00.000Z'),
        updatedAt: new Date('2025-01-15T00:00:00.000Z'),
      });
      expect(warned(ctx)).toEqual({});
    });

    it('uses the export time, with a warning, when no date can be read', () => {
      const ctx = makeCtx();
      const record = mapAttachment(
        ctx,
        matter,
        path,
        attachment(id, 'pdf', { uploadedAt: undefined, createdOn: 'never', updatedOn: undefined }),
        objectsOf(pdf),
      );
      expect(record.data).toMatchObject({ createdAt: AS_OF, updatedAt: AS_OF });
      expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [path] });
    });
  });

  it('copies only the checksums and generation the object has', () => {
    const record = mapAttachment(
      makeCtx(),
      matter,
      path,
      attachment(id, 'pdf'),
      objectsOf({ name: `${path}.pdf`, size: 120000, contentType: 'application/pdf', md5Hash: 'abc==' }),
    );
    expect(record.copy).toEqual({
      source: `${path}.pdf`,
      target: `${record.path}/v1`,
      fileName: 'fictional-file.pdf',
      mime: 'application/pdf',
      sizeBytes: 120000,
      md5Hash: 'abc==',
    });
  });
});

describe('mapAttachments', () => {
  it('maps every attachment of a card, skipping ones whose document is gone', () => {
    const ctx = makeCtx();
    const svgId = 'a77a0000-0000-4000-8000-000000000003';
    const msgId = 'a77a0000-0000-4000-8000-000000000004';
    const records: ExportRecord[] = [
      {
        path: attachmentPath(svgId),
        data: attachment(svgId, 'svg', { mimeType: 'image/svg+xml', sizeBytes: 2000 }),
      },
      { path: attachmentPath('gone'), data: null },
      { path: attachmentPath(msgId), data: attachment(msgId, 'msg', { mimeType: '', sizeBytes: 40000 }) },
    ] as ExportRecord[];
    const objects = objectsOf(
      { name: `${attachmentPath(svgId)}.svg`, size: 2000, contentType: 'image/svg+xml' },
      { name: `${attachmentPath(msgId)}.msg`, size: 41000 },
    );
    const documents = mapAttachments(ctx, matter, records, objects);
    expect(documents.map((record) => record.legacyPath)).toEqual([attachmentPath(svgId), attachmentPath(msgId)]);
    for (const record of documents) expectValid(record);
    expect(warned(ctx)).toEqual({
      MIG_W_ATTACHMENT_DOWNLOAD_ONLY: [attachmentPath(svgId)],
      MIG_W_ATTACHMENT_SIZE_MISMATCH: [attachmentPath(msgId)],
      MIG_W_ATTACHMENT_TYPE_FROM_EXTENSION: [attachmentPath(msgId)],
    });
  });

  it('maps nothing for a card without attachments', () => {
    expect(mapAttachments(makeCtx(), matter, [], new Map())).toEqual([]);
  });
});

describe('inline images', () => {
  function image(mime: string, extension: string): InlineImage {
    const bytes = Buffer.from(`fictional ${extension} bytes`);
    return {
      mime,
      extension,
      base64: bytes.toString('base64'),
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      md5Hash: createHash('md5').update(bytes).digest('base64'),
    };
  }

  it('names an image by its position and extension', () => {
    expect(inlineImageName(0, image('image/png', 'png'))).toBe('Description image 1.png');
    expect(inlineImageName(2, image('image/jpeg', 'jpg'))).toBe('Description image 3.jpg');
  });

  it('makes a document of an image a description embedded, with its bytes in the copy', () => {
    const ctx = makeCtx();
    const png = image('image/png', 'png');
    const record = inlineImageDocument(ctx, matter, png, 1);
    const legacyPath = `${CARD}#description-image/2`;
    expect(record.legacyPath).toBe(legacyPath);
    expect(record.path).toBe(`orgs/org1/matters/${matter.matterId}/documents/${migId(legacyPath)}`);
    expect(record.data).toMatchObject({
      name: 'Description image 2.png',
      category: 'other',
      version: 0,
      source: 'migration',
      createdAt: CARD_CREATED,
      updatedAt: CARD_UPDATED,
      createdBy: UID,
    });
    expect(record.copy).toEqual({
      content: { encoding: 'base64', data: png.base64, sha256: png.sha256 },
      target: `${record.path}/v1`,
      fileName: 'Description image 2.png',
      mime: 'image/png',
      sizeBytes: png.sizeBytes,
      md5Hash: png.md5Hash,
    });
    expect(record.copy).not.toHaveProperty('source');
    expectValid(record);
    expect(warned(ctx)).toEqual({ MIG_W_INLINE_IMAGE_EXTRACTED: [CARD] });
  });

  it.each([
    ['image/gif', 'gif'],
    ['image/bmp', 'bmp'],
  ])('serves an embedded %s as a download only', (mime, extension) => {
    const record = inlineImageDocument(makeCtx(), matter, image(mime, extension), 0);
    expect(record.copy?.downloadOnly).toBe(true);
  });

  it('serves an embedded JPEG inline', () => {
    expect(inlineImageDocument(makeCtx(), matter, image('image/jpeg', 'jpg'), 0).copy).not.toHaveProperty(
      'downloadOnly',
    );
  });
});
