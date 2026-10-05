import {
  attachmentDisposition,
  BulkUpdateDocumentsInput,
  canAddVersion,
  detectFileKind,
  documentDisplayName,
  documentVersionPath,
  downloadFileName,
  findVersion,
  GetDownloadUrlInput,
  isEmailFile,
  MessageRenditionSchema,
  kindMatchesExtension,
  PENDING_UPLOAD_PATH,
  pendingUploadPath,
  REMOVED_DOCUMENT_LABEL,
  renditionPath,
  SaveAttachmentInput,
  scanRetryDelaySeconds,
  StartZipInput,
  UPLOAD_EXTENSIONS,
  UPLOAD_TYPES,
  uploadContentType,
  uploadExtension,
  UploadMetadataSchema,
  uploadSettings,
  versionHistory,
  zipDownloadNames,
  zipEntryNames,
} from './documents';
import { DOCUMENT_VERSIONS_MAX, MatterDocument, type DocumentVersion } from './schemas/matter-records';

/** Documents (CORE-12): the upload contract, magic bytes and version helpers. Fictional data only. */

const SHA = 'ab'.repeat(32);
const enc = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => new Uint8Array(values);

/** A minimal stored zip (no compression) with the given entry names, built by hand. */
function zipOf(names: string[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const name of names) {
    const nameBytes = [...enc(name)];
    const offset = local.length;
    local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0));
    local.push(...u32(0), ...u16(nameBytes.length), ...u16(0), ...nameBytes);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0));
    central.push(...u32(0), ...u32(0), ...u32(0), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0));
    central.push(...u16(0), ...u32(0), ...u32(offset), ...nameBytes);
  }
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(names.length),
    ...u16(names.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0),
  ];
  return new Uint8Array([...local, ...central, ...end]);
}

const cfb = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0);

describe('detectFileKind', () => {
  it.each([
    ['pdf', enc('%PDF-1.7\n%âãÏÓ\n')],
    ['pdf (after junk)', enc('\r\n\r\n%PDF-1.4\n')],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0)],
    ['webp', enc('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')],
    ['heic', new Uint8Array([0, 0, 0, 24, ...enc('ftypheic'), 0, 0, 0, 0])],
    ['heic (mif1)', new Uint8Array([0, 0, 0, 24, ...enc('ftypmif1'), 0, 0, 0, 0])],
    ['cfb', cfb],
  ])('%s', (label, content) => {
    expect(detectFileKind(content)).toBe(label.split(' ')[0]);
  });

  it('tells Office Open XML from other zips by their parts', () => {
    expect(detectFileKind(zipOf(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']))).toBe('docx');
    expect(detectFileKind(zipOf(['[Content_Types].xml', 'xl/workbook.xml']))).toBe('xlsx');
    expect(detectFileKind(zipOf(['[Content_Types].xml', 'ppt/presentation.xml']))).toBe('pptx');
    expect(detectFileKind(zipOf(['[Content_Types].xml', 'other/thing.xml']))).toBe('zip');
    expect(detectFileKind(zipOf(['notes.txt', 'word/not-really.xml']))).toBe('zip');
    // An empty archive is just the end record.
    expect(detectFileKind(zipOf([]))).toBe('zip');
    // A zip signature with no readable directory: damaged, but still a zip.
    expect(detectFileKind(enc('PK\u0003\u0004 truncated'))).toBe('damaged_zip');
  });

  it('reads zip entry names, and gives up on damaged or ZIP64 archives', () => {
    expect(zipEntryNames(zipOf(['a.txt', 'dir/b.txt']))).toEqual(['a.txt', 'dir/b.txt']);
    expect(zipEntryNames(enc('PK\u0003\u0004 no end record'))).toBeNull();
    const zip = zipOf(['a.txt']);
    const damaged = zip.slice();
    // Point the central directory past the end of the file.
    damaged.set([0xf0, 0xff, 0, 0], damaged.length - 6);
    expect(zipEntryNames(damaged)).toBeNull();
    const zip64 = zip.slice();
    zip64.set([0xff, 0xff, 0xff, 0xff], zip64.length - 6);
    expect(zipEntryNames(zip64)).toBeNull();
    const wrongSignature = zip.slice();
    const centralStart = wrongSignature.length - 22 - (46 + 5);
    wrongSignature.set([0, 0, 0, 0], centralStart);
    expect(zipEntryNames(wrongSignature)).toBeNull();
    const truncatedName = zipOf(['abcdefgh']);
    // Claim a longer name than the file holds.
    truncatedName.set([0xff, 0x00], truncatedName.length - 22 - (46 + 8) + 28);
    expect(zipEntryNames(truncatedName)).toBeNull();
  });

  it('text: UTF-8, Latin-1 CSV and UTF-16 with a BOM; binary is unknown', () => {
    expect(detectFileKind(enc('Name,Amount\r\nFictional Estate,100\r\n'))).toBe('text');
    expect(detectFileKind(enc('From: someone@example.test\r\nSubject: Fictional\r\n\r\nBody'))).toBe('text');
    expect(detectFileKind(bytes(0x43, 0x61, 0x66, 0xe9, 0x0a))).toBe('text');
    expect(detectFileKind(bytes(0xff, 0xfe, 0x41, 0x00))).toBe('text');
    expect(detectFileKind(bytes(0x4d, 0x5a, 0x90, 0x00, 0x03))).toBe('unknown');
    expect(detectFileKind(new Uint8Array(200).fill(0x01))).toBe('unknown');
    expect(detectFileKind(new Uint8Array(0))).toBe('unknown');
  });

  it('an executable renamed to .pdf is not a PDF', () => {
    const exe = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00);
    expect(kindMatchesExtension(detectFileKind(exe), 'pdf')).toBe(false);
  });
});

describe('the allow-list', () => {
  it('covers exactly the ticket’s extensions', () => {
    expect([...UPLOAD_EXTENSIONS].sort()).toEqual(
      [
        'pdf',
        'docx',
        'doc',
        'xlsx',
        'xls',
        'pptx',
        'msg',
        'eml',
        'txt',
        'csv',
        'png',
        'jpg',
        'jpeg',
        'heic',
        'webp',
        'zip',
      ].sort(),
    );
  });

  it('reads extensions case-insensitively and refuses others', () => {
    expect(uploadExtension('Will (signed).PDF')).toBe('pdf');
    expect(uploadExtension('archive.tar.zip')).toBe('zip');
    expect(uploadExtension('tool.exe')).toBeNull();
    expect(uploadExtension('README')).toBeNull();
    expect(uploadContentType('photo.HEIC')).toBe('image/heic');
    expect(uploadContentType('page.html')).toBeNull();
  });

  it('matches kinds to extensions; a zip may hold Office Open XML', () => {
    expect(kindMatchesExtension('docx', 'docx')).toBe(true);
    expect(kindMatchesExtension('docx', 'zip')).toBe(true);
    expect(kindMatchesExtension('zip', 'docx')).toBe(false);
    // Corrupt Office files and archives are stored as uploaded.
    for (const ext of ['docx', 'xlsx', 'pptx', 'zip'] as const)
      expect(kindMatchesExtension('damaged_zip', ext)).toBe(true);
    expect(kindMatchesExtension('damaged_zip', 'pdf')).toBe(false);
    expect(kindMatchesExtension('cfb', 'msg')).toBe(true);
    expect(kindMatchesExtension('text', 'eml')).toBe(true);
    expect(kindMatchesExtension('pdf', 'png')).toBe(false);
    for (const ext of UPLOAD_EXTENSIONS) expect(UPLOAD_TYPES[ext].kinds.length).toBeGreaterThan(0);
  });
});

describe('the upload contract', () => {
  it('builds paths', () => {
    expect(pendingUploadPath('org-a', 'm-1', 'upload-0001')).toBe('orgs/org-a/matters/m-1/pending/upload-0001');
    expect(PENDING_UPLOAD_PATH.exec('orgs/org-a/matters/m-1/pending/upload-0001')?.slice(1)).toEqual([
      'org-a',
      'm-1',
      'upload-0001',
    ]);
    expect(PENDING_UPLOAD_PATH.test('orgs/org-a/matters/m-1/pending/upload-0001/x.pdf')).toBe(false);
    expect(PENDING_UPLOAD_PATH.test('orgs/org-a/matters/m-1/pending/short')).toBe(false);
    expect(documentVersionPath('org-a', 'm-1', 'd-1', 3)).toBe('orgs/org-a/matters/m-1/documents/d-1/v3');
    expect(renditionPath('org-a', 'm-1', 'd-1', 2, 'previewPdf')).toBe(
      'orgs/org-a/matters/m-1/documents/d-1/renditions/v2/preview.pdf',
    );
    expect(renditionPath('org-a', 'm-1', 'd-1', 2, 'message')).toMatch(/message\.json$/);
  });

  it('uploadSettings gives the content type and metadata the rules expect', () => {
    expect(uploadSettings({ uid: 'u-1', fileName: 'Letter.docx', sha256: SHA.toUpperCase() })).toEqual({
      contentType: UPLOAD_TYPES.docx.mime,
      customMetadata: { uploaderUid: 'u-1', fileName: 'Letter.docx', sha256: SHA },
    });
    expect(
      uploadSettings({
        uid: 'u-1',
        fileName: 'Will v2.pdf',
        sha256: SHA,
        documentId: 'd-1',
        category: 'will',
        privileged: true,
      }).customMetadata,
    ).toEqual({
      uploaderUid: 'u-1',
      fileName: 'Will v2.pdf',
      sha256: SHA,
      documentId: 'd-1',
      category: 'will',
      privileged: 'true',
    });
    expect(() => uploadSettings({ uid: 'u-1', fileName: 'tool.exe', sha256: SHA })).toThrow(/not accepted/);
    expect(() => uploadSettings({ uid: 'u-1', fileName: 'a.pdf', sha256: 'nope' })).toThrow();
  });

  it('the metadata schema refuses unknown keys and bad values', () => {
    const base = { uploaderUid: 'u-1', fileName: 'a.pdf', sha256: SHA };
    expect(UploadMetadataSchema.safeParse(base).success).toBe(true);
    expect(UploadMetadataSchema.safeParse({ ...base, scan: 'clean' }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ ...base, privileged: 'yes' }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ ...base, category: 'spreadsheet' }).success).toBe(false);
  });
});

const version = (n: number, extra: Partial<DocumentVersion> = {}): DocumentVersion => ({
  version: n,
  storagePath: documentVersionPath('org-a', 'm-1', 'd-1', n),
  fileName: `Will v${n}.pdf`,
  mime: 'application/pdf',
  sizeBytes: 100 * n,
  sha256: SHA,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  uploadedBy: 'u-1',
  ...extra,
});

describe('versions and display', () => {
  it('finds the current or a given version, and lists history newest first', () => {
    const doc = { name: 'Will', version: 2, versions: [version(1), version(3), version(2)] };
    expect(findVersion(doc)?.version).toBe(2);
    expect(findVersion(doc, 3)?.version).toBe(3);
    expect(findVersion(doc, 9)).toBeUndefined();
    expect(findVersion({ name: 'x' })).toBeUndefined();
    expect(versionHistory(doc).map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versionHistory({})).toEqual([]);
  });

  it('caps the history', () => {
    expect(canAddVersion({ versions: [version(1)] })).toBe(true);
    expect(canAddVersion({})).toBe(true);
    expect(canAddVersion({ versions: Array.from({ length: DOCUMENT_VERSIONS_MAX }, (_, i) => version(i + 1)) })).toBe(
      false,
    );
  });

  it('a removed document resolves as "Removed document"', () => {
    expect(documentDisplayName({ name: 'Will of Fictional Person.pdf' })).toBe('Will of Fictional Person.pdf');
    expect(documentDisplayName({ name: 'Will', deletedAt: new Date() })).toBe(REMOVED_DOCUMENT_LABEL);
    expect(documentDisplayName({ name: 'Will', deletedAt: null })).toBe('Will');
    expect(documentDisplayName({})).toBe(REMOVED_DOCUMENT_LABEL);
  });

  it('backs off scan retries from a minute to an hour', () => {
    expect([1, 2, 3, 4, 7, 8, 20].map(scanRetryDelaySeconds)).toEqual([60, 120, 240, 480, 3600, 3600, 3600]);
    expect(scanRetryDelaySeconds(0)).toBe(60);
  });

  it('download names keep the document name with the right extension', () => {
    expect(downloadFileName('Will of Fictional Person.pdf', 'scan.PDF')).toBe('Will of Fictional Person.pdf');
    expect(downloadFileName('Letter to executor', 'letter.docx')).toBe('Letter to executor.docx');
    expect(downloadFileName('Letter.docx', 'letter.docx', 'previewPdf')).toBe('Letter.pdf');
    expect(downloadFileName('Photo.heic', 'IMG_0001.HEIC', 'previewImage')).toBe('Photo.jpg');
    expect(downloadFileName('Email.eml', 'mail.eml', 'message')).toBe('Email.json');
    expect(downloadFileName('.pdf', 'a.pdf')).toBe('document.pdf');
    expect(downloadFileName('Odd', 'no-extension')).toBe('Odd');
  });

  it('Content-Disposition is always an attachment, with a safe ASCII fallback', () => {
    expect(attachmentDisposition('Will.pdf')).toBe(`attachment; filename="Will.pdf"; filename*=UTF-8''Will.pdf`);
    expect(attachmentDisposition('Café "draft" (1).pdf')).toBe(
      `attachment; filename="Caf_ _draft_ (1).pdf"; filename*=UTF-8''Caf%C3%A9%20%22draft%22%20%281%29.pdf`,
    );
  });
});

describe('the MatterDocument schema', () => {
  const base = {
    orgId: 'org-a',
    matterId: 'm-1',
    name: 'Will.pdf',
    category: 'will',
    version: 0,
    scan: { status: 'pending' },
    ingest: { status: 'pending' },
    source: 'upload',
    createdAt: new Date(),
    createdBy: 'u-1',
    updatedAt: new Date(),
    updatedBy: 'u-1',
    schemaVersion: 1,
  };

  it('a document in the pipeline has no version yet', () => {
    const parsed = MatterDocument.schema.parse({
      ...base,
      upload: {
        uploadId: 'upload-0001',
        fileName: 'Will.pdf',
        sizeBytes: 10,
        uploadedBy: 'u-1',
        at: new Date(),
        status: 'delayed',
        attempts: 2,
      },
    });
    expect(parsed.versions).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.privileged).toBe(false);
  });

  it('clients may set only the name, category, privileged flag, tags, notes and access flag', () => {
    expect(Object.keys(MatterDocument.update.shape).sort()).toEqual(
      ['accessRestricted', 'category', 'name', 'notes', 'privileged', 'tags'].sort(),
    );
    expect(MatterDocument.update.safeParse({ scan: { status: 'clean' } }).success).toBe(false);
    expect(MatterDocument.update.safeParse({ tags: ['x'.repeat(41)] }).success).toBe(false);
  });
});

describe('callable inputs', () => {
  it('getDownloadUrl defaults to the original file', () => {
    expect(GetDownloadUrlInput.parse({ matterId: 'm-1', docId: 'd-1' })).toEqual({
      matterId: 'm-1',
      docId: 'd-1',
      rendition: 'original',
    });
    expect(GetDownloadUrlInput.safeParse({ matterId: 'm-1', docId: 'd-1', rendition: 'thumbnail' }).success).toBe(
      false,
    );
  });

  it('bulk updates list each document once', () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    expect(
      BulkUpdateDocumentsInput.safeParse({ requestId, matterId: 'm-1', docIds: ['a', 'a'], change: { op: 'delete' } })
        .success,
    ).toBe(false);
    expect(
      BulkUpdateDocumentsInput.safeParse({
        requestId,
        matterId: 'm-1',
        docIds: ['a', 'b'],
        change: { op: 'category', category: 'financial' },
      }).success,
    ).toBe(true);
  });
});

describe('email messages', () => {
  it('recognises .eml and .msg files', () => {
    expect(isEmailFile('Letter from the bank.EML')).toBe(true);
    expect(isEmailFile('Outlook export.msg')).toBe(true);
    expect(isEmailFile('notes.txt')).toBe(false);
    expect(isEmailFile('eml')).toBe(false);
  });

  it('describes a message rendition', () => {
    const rendition = {
      format: 'message.v1',
      subject: 'Fictional valuation',
      from: { name: 'Rowan Example', address: 'rowan@example.test' },
      to: [],
      cc: [],
      date: null,
      text: 'Please find the valuation attached.',
      textTruncated: false,
      attachments: [{ index: 0, fileName: 'valuation.pdf', mime: 'application/pdf', sizeBytes: 10, savable: true }],
      attachmentsTruncated: false,
    };
    expect(MessageRenditionSchema.parse(rendition)).toEqual(rendition);
    expect(MessageRenditionSchema.safeParse({ ...rendition, format: 'message.v2' }).success).toBe(false);
  });

  it('saveAttachment names one attachment of one version', () => {
    const base = { requestId: '00000000-0000-4000-8000-000000000001', matterId: 'm-1', docId: 'd-1' };
    expect(SaveAttachmentInput.safeParse({ ...base, attachmentIndex: 0 }).success).toBe(true);
    expect(SaveAttachmentInput.safeParse({ ...base, attachmentIndex: -1 }).success).toBe(false);
    expect(SaveAttachmentInput.safeParse({ ...base, attachmentIndex: 0, category: 'nope' }).success).toBe(false);
  });

  it('names a zip download’s files safely and uniquely', () => {
    expect(
      zipDownloadNames([
        { name: 'Will of a fictional person', fileName: 'scan.pdf' },
        { name: 'will of a fictional person.pdf', fileName: 'other.pdf' },
        { name: 'Will of a fictional person', fileName: 'v3.pdf' },
        { name: 'Bank statement', fileName: 'statement.xlsx' },
        { name: '../Letters/Advice\u0000', fileName: 'advice.docx' },
        { name: '..', fileName: 'x' },
      ]),
    ).toEqual([
      'Will of a fictional person.pdf',
      'will of a fictional person (2).pdf',
      'Will of a fictional person (3).pdf',
      'Bank statement.xlsx',
      '.._Letters_Advice_.docx',
      'document',
    ]);
    const [long, longer] = zipDownloadNames([
      { name: 'x'.repeat(300), fileName: 'a.pdf' },
      { name: 'x'.repeat(300), fileName: 'a.pdf' },
    ]);
    expect(long).toHaveLength(255);
    expect(long?.endsWith('x.pdf')).toBe(true);
    expect(longer).toHaveLength(255);
    expect(longer?.endsWith(' (2).pdf')).toBe(true);
  });

  it('startZip takes 1 to 200 distinct documents of one matter', () => {
    const base = { requestId: '00000000-0000-4000-8000-000000000001', matterId: 'm-1' };
    expect(StartZipInput.safeParse({ ...base, docIds: ['d-1', 'd-2'] }).success).toBe(true);
    expect(StartZipInput.safeParse({ ...base, docIds: [] }).success).toBe(false);
    expect(StartZipInput.safeParse({ ...base, docIds: ['d-1', 'd-1'] }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => `d-${i}`);
    expect(StartZipInput.safeParse({ ...base, docIds: many.slice(0, 200) }).success).toBe(true);
    expect(StartZipInput.safeParse({ ...base, docIds: many }).success).toBe(false);
  });
});
