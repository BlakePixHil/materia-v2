import { createHash } from 'node:crypto';

import { copyFilesCommand, EMULATOR_FILES_BUCKET } from '../src/copy-files.ts';
import type { CopyReport } from '../src/files/copy.ts';
import { EICAR_TEST_STRING } from '../src/files/scanner.ts';

/**
 * MIG-05 against the Storage emulator: made-up legacy attachments in a `demo-legacy` bucket, the
 * transform's lines for them (MIG-03's contract) in a run of the migration bucket, then
 * `materia-migrate copy-files --env emulator`. The clean files must arrive at their document paths
 * with the same bytes, their sha256 and scan in the metadata and no legacy download token; the
 * EICAR file must stay in quarantine; the records and report must say so; and a re-run must copy
 * nothing again. Fictional data only.
 */

const LEGACY = 'demo-legacy.firebasestorage.app';
const RUNS = 'materia-v2-dev-migration';
const FILES = EMULATOR_FILES_BUCKET;
const OWNER = { authorization: 'Bearer owner' };
const ORG = 'org-fictional-rivers';
const MATTER = 'm-estate-quill';

const host = process.env['FIREBASE_STORAGE_EMULATOR_HOST'] ?? '';
// The emulator serves metadata patches only without the /storage/v1 prefix (reads take either).
const ROOT = host.includes('://') ? host : `http://${host}`;
const UPLOAD = `${ROOT}/upload/storage/v1`;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const EICAR = Buffer.from(EICAR_TEST_STRING);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const objectUrl = (bucket: string, name: string) => `${ROOT}/b/${bucket}/o/${encodeURIComponent(name)}`;

async function ok(res: Promise<Response>): Promise<Response> {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r;
}

interface Meta {
  size: string;
  generation: string;
  md5Hash: string;
  crc32c: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

async function upload(bucket: string, name: string, data: Buffer | string, contentType: string): Promise<Meta> {
  const query = new URLSearchParams({ uploadType: 'media', name });
  await ok(
    fetch(`${UPLOAD}/b/${bucket}/o?${query}`, {
      method: 'POST',
      headers: { ...OWNER, 'content-type': contentType },
      body: data,
    }),
  );
  return stat(bucket, name) as Promise<Meta>;
}

async function stat(bucket: string, name: string): Promise<Meta | null> {
  const res = await fetch(objectUrl(bucket, name), { headers: OWNER });
  if (res.status === 404) return null;
  return (await ok(Promise.resolve(res))).json() as Promise<Meta>;
}

async function bytes(bucket: string, name: string): Promise<Buffer> {
  return Buffer.from(await (await ok(fetch(`${objectUrl(bucket, name)}?alt=media`, { headers: OWNER }))).arrayBuffer());
}

/** A legacy attachment, with a Firebase download token as legacy objects have, and its transform line. */
async function attachment(runId: string, id: string, data: Buffer | null, fileName: string, mime: string) {
  const legacyName = `workflows/wf-rivers/cards/card-quill/attachments/${runId}-${id}${fileName.slice(fileName.lastIndexOf('.'))}`;
  let meta: Meta | null = null;
  if (data) {
    await upload(LEGACY, legacyName, data, mime);
    await ok(
      fetch(objectUrl(LEGACY, legacyName), {
        method: 'PATCH',
        headers: { ...OWNER, 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { firebaseStorageDownloadTokens: 'made-up-legacy-token' } }),
      }),
    );
    meta = await stat(LEGACY, legacyName);
  }
  const path = `orgs/${ORG}/matters/${MATTER}/documents/${runId}-${id}`;
  return {
    path,
    legacyPath: `workflows/wf-rivers/cards/card-quill/attachments/${id}`,
    data: {
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
      createdAt: { $timestamp: '2024-05-06T07:08:09.000Z' },
      createdBy: 'uid-alex-rivers',
      updatedAt: { $timestamp: '2024-05-06T07:08:09.000Z' },
      updatedBy: 'uid-alex-rivers',
      schemaVersion: 1,
    },
    copy: {
      ...(meta ? { source: legacyName, md5Hash: meta.md5Hash, crc32c: meta.crc32c, generation: meta.generation } : {}),
      target: `${path}/v1`,
      fileName,
      mime,
      sizeBytes: data?.length ?? 2048,
    },
  };
}

const jsonl = (lines: unknown[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join('');
const runFile = (runId: string, name: string) => bytes(RUNS, `runs/${runId}/${name}`).then(String);

let logs: string[];
async function copyFiles(runId: string): Promise<number> {
  logs = [];
  const log = (line: string) => void logs.push(line);
  return copyFilesCommand(['--run', runId, '--env', 'emulator', '--concurrency', '3'], log, log);
}

describe('materia-migrate copy-files on the Storage emulator', () => {
  it('copies, verifies, scans and reports, keeps EICAR in quarantine, and copies nothing twice', async () => {
    const runId = `int-${Date.now()}`;
    const letter = await attachment(runId, 'letter', PDF, 'Letter to the executor.pdf', 'application/pdf');
    const eicar = await attachment(runId, 'eicar', EICAR, 'eicar.txt', 'text/plain');
    const gone = await attachment(runId, 'gone', null, 'Lost scan.pdf', 'application/pdf');
    const photoName = `profile-images/${runId}-uid-alex-rivers.png`;
    const photo = await upload(LEGACY, photoName, PNG, 'image/png');
    const avatarPath = `users/${runId}-uid-alex-rivers/avatar.png`;

    await upload(
      RUNS,
      `runs/${runId}/manifest.json`,
      JSON.stringify({ runId, sourceBucket: LEGACY }),
      'application/json',
    );
    await upload(
      RUNS,
      `runs/${runId}/transformed/documents.jsonl`,
      jsonl([eicar, gone, letter]),
      'application/x-ndjson',
    );
    await upload(
      RUNS,
      `runs/${runId}/transformed/avatars.jsonl`,
      jsonl([
        {
          path: avatarPath,
          legacyPath: 'profile-images/uid-alex-rivers.png',
          copy: {
            source: photoName,
            target: avatarPath,
            fileName: 'uid-alex-rivers.png',
            mime: 'image/png',
            sizeBytes: PNG.length,
            md5Hash: photo.md5Hash,
            crc32c: photo.crc32c,
            generation: photo.generation,
          },
        },
      ]),
      'application/x-ndjson',
    );
    await upload(
      RUNS,
      `runs/${runId}/report.json`,
      JSON.stringify({ storage: { orphans: [{ name: 'workflows/wf-rivers/attachments/board-notes.pdf', size: 99 }] } }),
      'application/json',
    );

    expect(await copyFiles(runId)).toBe(0);

    // The clean attachment, at its document path, byte for byte, with what the load needs.
    const stored = await stat(FILES, letter.copy.target);
    expect(await bytes(FILES, letter.copy.target)).toEqual(PDF);
    expect(stored).toMatchObject({ contentType: 'application/pdf', md5Hash: letter.copy.md5Hash });
    expect(stored?.metadata).toMatchObject({
      migrationRunId: runId,
      legacyPath: letter.legacyPath,
      sha256: sha256(PDF),
      scan: 'clean',
      kind: 'pdf',
    });
    expect(JSON.stringify(stored)).not.toContain('made-up-legacy-token');
    expect(await stat(FILES, `migration-quarantine/${runId}/${letter.copy.target}`)).toBeNull();
    expect((await stat(FILES, avatarPath))?.metadata).toMatchObject({ scan: 'clean', kind: 'png' });

    // EICAR stays in quarantine, never at its document path.
    expect(await stat(FILES, eicar.copy.target)).toBeNull();
    expect((await stat(FILES, `migration-quarantine/${runId}/${eicar.copy.target}`))?.metadata).toMatchObject({
      scan: 'infected',
      signature: 'Eicar-Test-Signature',
    });

    // The legacy objects are untouched.
    expect((await stat(LEGACY, letter.copy.source as string))?.generation).toBe(letter.copy.generation);

    const report = JSON.parse(await runFile(runId, 'files/report.json')) as CopyReport;
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
    expect(report.missing).toEqual([gone.legacyPath]);
    expect(report.infected.map((item) => item.legacyPath)).toEqual([eicar.legacyPath]);
    const records = (await runFile(runId, 'files/documents.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { path: string; data: Record<string, unknown> });
    expect(records.find((record) => record.path === letter.path)?.data).toMatchObject({
      version: 1,
      sha256: sha256(PDF),
      storagePath: letter.copy.target,
      scan: { status: 'clean' },
    });
    expect(records.find((record) => record.path === eicar.path)?.data).toMatchObject({
      version: 0,
      scan: { status: 'infected' },
    });
    expect(logs.join('\n')).not.toMatch(/Letter|eicar\.txt|uid-alex/);

    // A re-run finds everything done.
    expect(await copyFiles(runId)).toBe(0);
    const again = JSON.parse(await runFile(runId, 'files/report.json')) as CopyReport;
    expect(again.counts).toMatchObject({ copied: 0, skipped: 2, missing: 1, infected: 1, failed: 0 });
    expect((await stat(FILES, letter.copy.target))?.generation).toBe(stored?.generation);
  });

  it('uploads an image a description embedded through quarantine and the scan, once', async () => {
    const runId = `int-inline-${Date.now()}`;
    const line = await attachment(runId, 'inline', null, 'Image 1 from the description.png', 'image/png');
    const inline = {
      ...line,
      legacyPath: 'workflows/wf-rivers/cards/card-quill#description/image-1',
      copy: {
        ...line.copy,
        sizeBytes: PNG.length,
        md5Hash: createHash('md5').update(PNG).digest('base64'),
        content: { encoding: 'base64', data: PNG.toString('base64'), sha256: sha256(PNG) },
      },
    };
    await upload(
      RUNS,
      `runs/${runId}/manifest.json`,
      JSON.stringify({ runId, sourceBucket: LEGACY }),
      'application/json',
    );
    await upload(RUNS, `runs/${runId}/transformed/documents.jsonl`, jsonl([inline]), 'application/x-ndjson');

    expect(await copyFiles(runId)).toBe(0);
    expect(await bytes(FILES, inline.copy.target)).toEqual(PNG);
    expect((await stat(FILES, inline.copy.target))?.metadata).toMatchObject({
      legacyPath: inline.legacyPath,
      sha256: sha256(PNG),
      scan: 'clean',
      kind: 'png',
    });
    expect(await stat(FILES, `migration-quarantine/${runId}/${inline.copy.target}`)).toBeNull();
    const report = JSON.parse(await runFile(runId, 'files/report.json')) as CopyReport;
    expect(report.counts).toMatchObject({ documents: 1, copied: 1, missing: 0, failed: 0 });

    expect(await copyFiles(runId)).toBe(0);
    const again = JSON.parse(await runFile(runId, 'files/report.json')) as CopyReport;
    expect(again.counts).toMatchObject({ copied: 0, skipped: 1 });
  });

  it("fails a copy whose checksum doesn't match the export's, keeps nothing of it, and exits 5", async () => {
    const runId = `int-bad-${Date.now()}`;
    const line = await attachment(runId, 'altered', PDF, 'Altered.pdf', 'application/pdf');
    const altered = { ...line, copy: { ...line.copy, md5Hash: 'bm90IHRoZSBleHBvcnRlZCBtZDU=' } };
    await upload(
      RUNS,
      `runs/${runId}/manifest.json`,
      JSON.stringify({ runId, sourceBucket: LEGACY }),
      'application/json',
    );
    await upload(RUNS, `runs/${runId}/transformed/documents.jsonl`, jsonl([altered]), 'application/x-ndjson');

    expect(await copyFiles(runId)).toBe(5);
    expect(await stat(FILES, line.copy.target)).toBeNull();
    expect(await stat(FILES, `migration-quarantine/${runId}/${line.copy.target}`)).toBeNull();
    const report = JSON.parse(await runFile(runId, 'files/report.json')) as CopyReport;
    expect(report.failed).toEqual([{ legacyPath: line.legacyPath, reason: 'checksum_mismatch' }]);
    expect(report.complete).toBe(false);
  });
});
