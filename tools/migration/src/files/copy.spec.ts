import { createHash } from 'node:crypto';

import { MatterDocument } from '@materia/domain';

import type { CopySpec, DocumentLine } from './contract.ts';
import {
  copyFile,
  documentRecord,
  inPool,
  MIGRATION_QUARANTINE,
  quarantinePath,
  runCopyFiles,
  type CopyContext,
} from './copy.ts';
import type { StoredObject } from './gcs.ts';
import {
  EICAR_TEST_STRING,
  emulatorScanner,
  FAKE_SCANNER_UNAVAILABLE_MARKER,
  ScannerUnavailableError,
  type Scanner,
} from './scanner.ts';
import { memoryStore } from './testing.ts';
import { memorySink } from '../export/sink.ts';

const RUN = 'rehearsal-1';
const LEGACY = 'demo-legacy.firebasestorage.app';
const FILES = 'demo-materia.appspot.com';
const ORG = 'org-fictional';
const MATTER = 'm-quill';
const NOW = new Date('2026-10-07T01:00:00.000Z');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** A document as the transform writes it (MIG-03 contract): version 0, nothing scanned. */
function transformedData(id: string, fileName: string) {
  return {
    orgId: ORG,
    matterId: MATTER,
    name: fileName,
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
    createdAt: { $timestamp: '2024-03-01T02:03:04.000Z' },
    createdBy: 'uid-alex-rivers',
    updatedAt: { $timestamp: '2024-03-02T02:03:04.000Z' },
    updatedBy: 'uid-alex-rivers',
    schemaVersion: 1,
    needsReview: [id === 'never' ? 'x' : 'NEEDS_TYPE'],
  };
}

function setup(scanner: Scanner = emulatorScanner) {
  const s3 = memoryStore();
  const ctx: CopyContext = {
    runId: RUN,
    sourceBucket: LEGACY,
    filesBucket: FILES,
    store: s3.store,
    scanner,
    now: () => NOW,
  };
  /** A legacy object and the transform's line for it. */
  const attachment = (
    id: string,
    data: Buffer | null,
    { fileName = `${id}.pdf`, mime = 'application/pdf', copy = {} as Partial<CopySpec> } = {},
  ): DocumentLine => {
    const legacyName = `workflows/wf-1/cards/card-1/attachments/${id}${fileName.slice(fileName.lastIndexOf('.'))}`;
    let object: StoredObject | null = null;
    if (data) {
      object = s3.put(LEGACY, legacyName, data, {
        contentType: mime,
        metadata: { firebaseStorageDownloadTokens: 'legacy-token-never-copied' },
      });
    }
    const path = `orgs/${ORG}/matters/${MATTER}/documents/doc-${id}`;
    return {
      path,
      legacyPath: `workflows/wf-1/cards/card-1/attachments/${id}`,
      data: transformedData(id, fileName),
      copy: {
        ...(object
          ? { source: legacyName, md5Hash: object.md5Hash, crc32c: object.crc32c, generation: object.generation }
          : {}),
        target: `${path}/v1`,
        fileName,
        mime,
        sizeBytes: data?.length ?? 1234,
        ...copy,
      },
    };
  };
  return { ...s3, ctx, attachment };
}

/** Tagged instants back to Dates, as the load (MIG-06) will write them. */
function untag(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(untag);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['$timestamp'] === 'string') return new Date(record['$timestamp']);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, untag(v)]));
  }
  return value;
}

describe('copyFile', () => {
  it('copies a file through quarantine to its final path, with what the load needs in its metadata', async () => {
    const { ctx, attachment, get, names, calls } = setup();
    const line = attachment('letter', PDF);

    const result = await copyFile(ctx, line, 'document');

    expect(result).toEqual({
      outcome: 'copied',
      sha256: sha256(PDF),
      sizeBytes: PDF.length,
      kind: 'pdf',
      scannedAt: NOW.toISOString(),
    });
    const stored = get(FILES, line.copy.target);
    expect(stored?.data.equals(PDF)).toBe(true);
    expect(stored?.contentType).toBe('application/pdf');
    expect(stored?.metadata).toEqual({
      migrationRunId: RUN,
      legacyPath: line.legacyPath,
      sha256: sha256(PDF),
      scan: 'clean',
      scannedAt: NOW.toISOString(),
      kind: 'pdf',
    });
    // The legacy download token never comes across, and quarantine is empty again.
    expect(JSON.stringify(stored?.metadata)).not.toContain('legacy-token');
    expect(names(FILES)).toEqual([line.copy.target]);
    // The legacy object was copied once, by exactly the exported generation, into quarantine first.
    const fromLegacy = calls.filter((call) => call.op === 'rewrite' && call.from?.startsWith(LEGACY));
    expect(fromLegacy).toEqual([
      {
        op: 'rewrite',
        bucket: FILES,
        name: quarantinePath(RUN, line.copy.target),
        from: `${LEGACY}/${line.copy.source}`,
      },
    ]);
    // Nothing is ever written to or deleted from the legacy bucket.
    expect(calls.filter((call) => call.bucket === LEGACY && call.op !== 'stat')).toEqual([]);
  });

  it('skips a file whose final copy already holds the same content, scanned clean', async () => {
    const { ctx, attachment, calls } = setup();
    const line = attachment('letter', PDF);
    const first = await copyFile(ctx, line, 'document');
    calls.length = 0;

    const again = await copyFile(ctx, line, 'document');

    expect(again).toEqual({ ...first, outcome: 'skipped' });
    expect(calls.filter((call) => call.op !== 'stat')).toEqual([]);
  });

  it('reports a missing legacy object without copying anything', async () => {
    const { ctx, attachment, calls } = setup();
    expect(await copyFile(ctx, attachment('gone', null), 'document')).toEqual({ outcome: 'missing' });
    expect(calls).toEqual([]);
  });

  it('uploads an image the transform extracted (copy.content) through the same quarantine and scan', async () => {
    const { ctx, attachment, get, names, calls } = setup();
    const extracted = attachment('inline', null, {
      fileName: 'Description image 1.png',
      mime: 'image/png',
      copy: {
        content: { encoding: 'base64', data: PNG.toString('base64'), sha256: sha256(PNG) },
        md5Hash: createHash('md5').update(PNG).digest('base64'),
        sizeBytes: PNG.length,
      },
    });

    const result = await copyFile(ctx, extracted, 'document');

    expect(result).toMatchObject({ outcome: 'copied', sha256: sha256(PNG), sizeBytes: PNG.length, kind: 'png' });
    expect(get(FILES, extracted.copy.target)?.data.equals(PNG)).toBe(true);
    expect(get(FILES, extracted.copy.target)?.metadata).toMatchObject({
      scan: 'clean',
      legacyPath: extracted.legacyPath,
    });
    expect(names(FILES)).toEqual([extracted.copy.target]);
    expect(calls.find((call) => call.op === 'upload')).toEqual({
      op: 'upload',
      bucket: FILES,
      name: quarantinePath(RUN, extracted.copy.target),
    });
    // Nothing comes from (or goes to) the legacy bucket for it.
    expect(calls.filter((call) => call.bucket === LEGACY || call.from?.startsWith(LEGACY))).toEqual([]);
    // A re-run finds it in place.
    expect((await copyFile(ctx, extracted, 'document')).outcome).toBe('skipped');
  });

  it("fails extracted bytes that aren't what the transform hashed, uploading nothing", async () => {
    const { ctx, attachment, calls } = setup();
    const extracted = attachment('inline', null, {
      fileName: 'Description image 1.png',
      mime: 'image/png',
      copy: {
        content: { encoding: 'base64', data: PNG.toString('base64'), sha256: sha256(PDF) },
        md5Hash: createHash('md5').update(PNG).digest('base64'),
        sizeBytes: PNG.length,
      },
    });
    expect(await copyFile(ctx, extracted, 'document')).toEqual({ outcome: 'failed', reason: 'checksum_mismatch' });
    expect(calls.filter((call) => call.op === 'upload')).toEqual([]);
  });

  it('keeps an infected file in quarantine and never moves it to its final path', async () => {
    const { ctx, attachment, get, names } = setup();
    const line = attachment('eicar', Buffer.from(EICAR_TEST_STRING), { fileName: 'eicar.txt', mime: 'text/plain' });

    const result = await copyFile(ctx, line, 'document');

    const held = quarantinePath(RUN, line.copy.target);
    expect(result).toMatchObject({ outcome: 'infected', signature: 'Eicar-Test-Signature', quarantine: held });
    expect(names(FILES)).toEqual([held]);
    expect(get(FILES, held)?.metadata).toMatchObject({ scan: 'infected', signature: 'Eicar-Test-Signature' });
    // A re-run doesn't scan it again, or move it.
    expect(
      await copyFile({ ...ctx, scanner: () => Promise.reject(new Error('not called')) }, line, 'document'),
    ).toMatchObject({
      outcome: 'infected',
      quarantine: held,
    });
    expect(names(FILES)).toEqual([held]);
  });

  it('leaves a file in quarantine when the scanner is down, and scans it on a re-run without copying it again', async () => {
    const { ctx, attachment, names, calls } = setup();
    const line = attachment('letter', PDF);
    const down: Scanner = (data) =>
      emulatorScanner(Buffer.concat([data, Buffer.from(FAKE_SCANNER_UNAVAILABLE_MARKER)]));

    const first = await copyFile({ ...ctx, scanner: down }, line, 'document');
    expect(first).toMatchObject({ outcome: 'unscanned', sha256: sha256(PDF) });
    expect(names(FILES)).toEqual([quarantinePath(RUN, line.copy.target)]);

    calls.length = 0;
    expect(await copyFile(ctx, line, 'document')).toMatchObject({ outcome: 'copied', sha256: sha256(PDF) });
    expect(calls.some((call) => call.op === 'rewrite' && call.from?.startsWith(LEGACY))).toBe(false);
    expect(names(FILES)).toEqual([line.copy.target]);
  });

  it("fails a copy whose checksums don't match the export's, and deletes it", async () => {
    const { ctx, attachment, names } = setup();
    const line = attachment('letter', PDF, { copy: { md5Hash: 'bm90IHRoZSBtZDU=' } });
    expect(await copyFile(ctx, line, 'document')).toEqual({ outcome: 'failed', reason: 'checksum_mismatch' });
    expect(names(FILES)).toEqual([]);
  });

  it('fails when the exported generation is gone (the legacy file changed)', async () => {
    const { ctx, attachment } = setup();
    const line = attachment('letter', PDF, { copy: { generation: '1' } });
    expect(await copyFile(ctx, line, 'document')).toEqual({ outcome: 'failed', reason: 'source_gone' });
  });

  it('never overwrites a final path that holds another file', async () => {
    const { ctx, attachment, put, get } = setup();
    const line = attachment('letter', PDF);
    put(FILES, line.copy.target, Buffer.from('someone else'), { metadata: { legacyPath: 'workflows/other' } });
    expect(await copyFile(ctx, line, 'document')).toEqual({ outcome: 'failed', reason: 'target_taken' });
    expect(get(FILES, line.copy.target)?.data.toString()).toBe('someone else');
  });

  it('refuses files it cannot verify or that are too large', async () => {
    const { ctx, attachment } = setup();
    expect(
      await copyFile(ctx, attachment('a', PDF, { copy: { md5Hash: undefined, crc32c: undefined } }), 'document'),
    ).toEqual({ outcome: 'failed', reason: 'no_checksum' });
    expect(await copyFile(ctx, attachment('b', PDF, { copy: { sizeBytes: 60 * 1024 * 1024 } }), 'document')).toEqual({
      outcome: 'failed',
      reason: 'too_large',
    });
  });

  it("keeps a file whose bytes aren't what its extension says, and flags it", async () => {
    const { ctx, attachment } = setup();
    const line = attachment('notes', Buffer.from('plain text, named as a PDF'));
    expect(await copyFile(ctx, line, 'document')).toMatchObject({
      outcome: 'copied',
      kind: 'text',
      typeMismatch: true,
    });
  });

  it('serves download-only types (svg, gif, bmp) as attachments (D-13)', async () => {
    const { ctx, attachment, get } = setup();
    const line = attachment('plan', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
      fileName: 'Site plan.svg',
      mime: 'image/svg+xml',
      copy: { downloadOnly: true },
    });
    expect(await copyFile(ctx, line, 'document')).toMatchObject({ outcome: 'copied', kind: 'text' });
    expect(get(FILES, line.copy.target)?.contentDisposition).toMatch(/^attachment; filename="Site plan\.svg"/);
  });

  it('copies a profile photo only when it is an image, with its real type', async () => {
    const { ctx, put, get, names } = setup();
    const photo = put(LEGACY, 'profile-images/uid-alex-rivers.png', PNG, { contentType: 'application/octet-stream' });
    const avatar = {
      legacyPath: 'profile-images/uid-alex-rivers.png',
      copy: {
        source: photo.name,
        target: 'users/uid-alex-rivers/avatar.png',
        fileName: 'uid-alex-rivers.png',
        mime: 'image/png',
        sizeBytes: PNG.length,
        md5Hash: photo.md5Hash as string,
        generation: photo.generation,
      },
    };
    expect(await copyFile(ctx, avatar, 'avatar')).toMatchObject({ outcome: 'copied', kind: 'png' });
    expect(get(FILES, 'users/uid-alex-rivers/avatar.png')?.contentType).toBe('image/png');

    const text = put(LEGACY, 'profile-images/uid-other.png', Buffer.from('not an image'));
    const notImage = {
      legacyPath: 'profile-images/uid-other.png',
      copy: {
        ...avatar.copy,
        source: text.name,
        target: 'users/uid-other/avatar.png',
        sizeBytes: text.size,
        md5Hash: text.md5Hash as string,
        generation: text.generation,
      },
    };
    expect(await copyFile(ctx, notImage, 'avatar')).toMatchObject({ outcome: 'failed', reason: 'not_an_image' });
    expect(names(FILES)).toEqual(['users/uid-alex-rivers/avatar.png']);
  });

  it('cleans up a quarantined copy a run left behind after its final copy', async () => {
    const { ctx, attachment, put, get, names } = setup();
    const line = attachment('letter', PDF);
    await copyFile(ctx, line, 'document');
    put(FILES, quarantinePath(RUN, line.copy.target), get(FILES, line.copy.target)?.data as Buffer);
    expect(await copyFile(ctx, line, 'document')).toMatchObject({ outcome: 'skipped' });
    expect(names(FILES)).toEqual([line.copy.target]);
  });
});

describe('documentRecord', () => {
  it('fills in version 1 and the clean scan, and the result is a valid MatterDocument', async () => {
    const { ctx, attachment } = setup();
    const line = attachment('letter', PDF, { fileName: 'Letter to the executor.pdf' });
    const record = documentRecord(line, await copyFile(ctx, line, 'document'));

    expect(record).toMatchObject({
      storagePath: line.copy.target,
      mime: 'application/pdf',
      sizeBytes: PDF.length,
      sha256: sha256(PDF),
      version: 1,
      versionSeq: 1,
      scan: { status: 'clean', at: { $timestamp: NOW.toISOString() } },
      ingest: { status: 'pending' },
      versions: [
        {
          version: 1,
          storagePath: line.copy.target,
          fileName: 'Letter to the executor.pdf',
          uploadedAt: { $timestamp: '2024-03-01T02:03:04.000Z' },
          uploadedBy: 'uid-alex-rivers',
        },
      ],
    });
    expect(MatterDocument.schema.safeParse(untag(record)).success).toBe(true);
  });

  it('marks an infected file infected with no version, and leaves a missing one as the transform wrote it', async () => {
    const { ctx, attachment } = setup();
    const infected = attachment('eicar', Buffer.from(EICAR_TEST_STRING), { fileName: 'eicar.txt', mime: 'text/plain' });
    const record = documentRecord(infected, await copyFile(ctx, infected, 'document'));
    expect(record).toMatchObject({ version: 0, versions: [], scan: { status: 'infected' } });
    expect(record['storagePath']).toBeUndefined();
    expect(MatterDocument.schema.safeParse(untag(record)).success).toBe(true);

    const missing = attachment('gone', null);
    expect(documentRecord(missing, { outcome: 'missing' })).toEqual(missing.data);
  });
});

describe('runCopyFiles', () => {
  const jsonl = (lines: unknown[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join('');

  function run(files: Map<string, string>, scanner?: Scanner) {
    const env = setup(scanner);
    const sink = memorySink(RUN, files);
    const log: string[] = [];
    return {
      ...env,
      sink,
      log,
      go: () =>
        runCopyFiles(
          {
            runId: RUN,
            env: 'emulator',
            sourceBucket: LEGACY,
            filesBucket: FILES,
            concurrency: 2,
            toolVersion: 'test',
          },
          { sink, store: env.store, scanner: env.ctx.scanner, now: () => NOW, log: (line) => void log.push(line) },
        ),
    };
  }

  it('copies every planned file, writes the records and a report, and a re-run copies nothing again', async () => {
    const files = new Map<string, string>();
    const r = run(files);
    const letter = r.attachment('letter', PDF);
    const eicar = r.attachment('eicar', Buffer.from(EICAR_TEST_STRING), { fileName: 'eicar.txt', mime: 'text/plain' });
    const gone = r.attachment('gone', null);
    const photo = r.put(LEGACY, 'profile-images/uid-alex-rivers.png', PNG);
    files.set('transformed/documents.jsonl', jsonl([eicar, gone, letter]));
    files.set(
      'transformed/avatars.jsonl',
      jsonl([
        {
          path: 'users/uid-alex-rivers/avatar.png',
          legacyPath: 'profile-images/uid-alex-rivers.png',
          copy: {
            source: photo.name,
            target: 'users/uid-alex-rivers/avatar.png',
            fileName: 'uid-alex-rivers.png',
            mime: 'image/png',
            sizeBytes: PNG.length,
            crc32c: photo.crc32c,
            generation: Number(photo.generation),
          },
        },
      ]),
    );
    files.set(
      'report.json',
      JSON.stringify({ storage: { orphans: [{ name: 'workflows/wf-1/attachments/board.pdf', size: 10 }] } }),
    );

    const report = await r.go();

    expect(report.counts).toEqual({
      documents: 3,
      avatars: 1,
      copied: 2,
      skipped: 0,
      missing: 1,
      infected: 1,
      unscanned: 0,
      failed: 0,
      typeMismatches: 0,
      orphans: 1,
    });
    expect(report.complete).toBe(true);
    expect(report.missing).toEqual([gone.legacyPath]);
    expect(report.infected).toEqual([
      {
        legacyPath: eicar.legacyPath,
        signature: 'Eicar-Test-Signature',
        quarantine: `${MIGRATION_QUARANTINE}/${RUN}/${eicar.copy.target}`,
      },
    ]);
    expect(report.orphans).toEqual([{ name: 'workflows/wf-1/attachments/board.pdf', size: 10 }]);
    expect(JSON.parse(files.get('files/report.json') as string)).toEqual(report);

    // The records, sorted by path, with the copy's result beside each.
    const records = (files.get('files/documents.jsonl') as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(records.map((record) => record.path)).toEqual([eicar.path, gone.path, letter.path].sort());
    const letterRecord = records.find((record) => record.path === letter.path);
    expect(letterRecord.data.sha256).toBe(sha256(PDF));
    expect(letterRecord.result.outcome).toBe('copied');
    expect(letterRecord.copy).toEqual(letter.copy);
    const avatars = (files.get('files/avatars.jsonl') as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(avatars).toMatchObject([{ path: 'users/uid-alex-rivers/avatar.png', result: { outcome: 'copied' } }]);
    // Logs say how many, never which.
    expect(r.log.join('\n')).not.toMatch(/letter|eicar|uid-alex/);

    r.calls.length = 0;
    const again = await r.go();
    expect(again.counts).toMatchObject({ copied: 0, skipped: 2, missing: 1, infected: 1 });
    expect(r.calls.filter((call) => call.op === 'rewrite' || call.op === 'remove')).toEqual([]);
  });

  it('says the run is incomplete when files are unscanned or failed', async () => {
    const files = new Map<string, string>();
    const r = run(files, () => Promise.reject(new ScannerUnavailableError()));
    files.set(
      'transformed/documents.jsonl',
      jsonl([r.attachment('letter', PDF), r.attachment('bad', PDF, { copy: { generation: '1' } })]),
    );
    const report = await r.go();
    expect(report).toMatchObject({ complete: false, counts: { unscanned: 1, failed: 1 }, orphans: null });
    expect(report.failed).toEqual([
      { legacyPath: 'workflows/wf-1/cards/card-1/attachments/bad', reason: 'source_gone' },
    ]);
  });

  it("stops before copying anything when the transform's output is missing or malformed", async () => {
    const files = new Map<string, string>();
    const r = run(files);
    await expect(r.go()).rejects.toThrow(/no transformed\/documents\.jsonl: run the transform \(MIG-03\)/);

    const line = r.attachment('letter', PDF);
    files.set('transformed/documents.jsonl', jsonl([{ ...line, copy: { ...line.copy, target: 'elsewhere/v1' } }]));
    await expect(r.go()).rejects.toThrow(/line 1: copy\.target must be the document path followed by \/v1/);
    files.set('transformed/documents.jsonl', jsonl([line, line]));
    await expect(r.go()).rejects.toThrow(/Two lines copy to/);
    expect(r.calls.filter((call) => call.op === 'rewrite')).toEqual([]);
  });
});

describe('inPool', () => {
  it('runs at most n at a time and keeps the order', async () => {
    let running = 0;
    let most = 0;
    const out = await inPool([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
    expect(await inPool([], 8, async () => 1)).toEqual([]);
  });
});
