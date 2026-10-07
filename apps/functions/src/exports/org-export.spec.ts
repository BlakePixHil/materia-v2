import { createHash } from 'node:crypto';

import { unzipSync } from 'fflate';
import type { HttpsError } from 'firebase-functions/v2/https';

import {
  ORG_EXPORT_QUEUE,
  OrgExportManifestSchema,
  orgExportPartPath,
  type OrgExportManifest,
  type Role,
} from '@materia/domain';

import { exportGroups, exportSchemas, firestorePortable, safeName } from './org-format';
import { orgExportDefinition } from './org-full';
import { memorySource } from './org-source';
import { exportedVersions, otherFile, runOrgExport, type RunOrgExportDeps } from './run-org-full';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import { MemoryFiles } from '../documents/testing';
import { getExportUrlDefinition } from '../jobs/get-export-url';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeSignedUrls, FakeTaskQueue, fakePorts } from '../ports/fakes';

/** Unit tests for the practice's full export (SEC-05). Every person, matter and file is fictional. */

const ORG = 'org-x';
const NOW = new Date('2026-10-06T23:00:00Z');
const REQUEST_ID = '6f0e8a2c-1b3d-4e5f-8a7b-9c0d1e2f3a4b';
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

type Data = Record<string, unknown>;
const meta = { createdAt: NOW, createdBy: 'seed', updatedAt: NOW, updatedBy: 'seed', schemaVersion: 1 };

const WILL_V1 = Buffer.from('%PDF-1.7 fictional will, first draft\n%%EOF\n');
const WILL_V2 = Buffer.from('%PDF-1.7 fictional will, signed\n%%EOF\n');
const LETTER = Buffer.from('Fictional letter to the executor');
const TEMPLATE = Buffer.from('PK fictional letterhead template');

const version = (n: number, bytes: Buffer, fileName: string) => ({
  version: n,
  storagePath: `orgs/${ORG}/matters/m1/documents/d1/v${n}`,
  fileName,
  contentType: 'application/pdf',
  sizeBytes: bytes.length,
  sha256: sha(bytes),
  uploadedAt: NOW,
  uploadedBy: 'user-owner',
});

function world(extra: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { ...meta, name: 'Fictional Harbour Legal', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-owner`]: { ...meta, role: 'owner', status: 'active', displayName: 'Olive Owner' },
    [`orgs/${ORG}/members/user-admin`]: { ...meta, role: 'admin', status: 'active', displayName: 'Adam Admin' },
    [`orgs/${ORG}/members/user-owner/tasks/p1`]: {
      ...meta,
      orgId: ORG,
      matterId: null,
      title: 'Renew practising certificate',
      status: 'todo',
      order: 1,
    },
    [`orgs/${ORG}/matters/m1`]: {
      ...meta,
      number: '0041',
      title: 'Estate of Fictional Smith',
      status: 'open',
      privileged: false,
    },
    [`orgs/${ORG}/matters/m2`]: {
      ...meta,
      number: '0042',
      title: 'Privileged dispute',
      status: 'open',
      privileged: true,
    },
    [`orgs/${ORG}/matters/m1/tasks/t1`]: {
      ...meta,
      orgId: ORG,
      matterId: 'm1',
      title: 'Grant of probate',
      status: 'todo',
      order: 1,
    },
    [`orgs/${ORG}/matters/m1/tasks/t2`]: {
      ...meta,
      orgId: ORG,
      matterId: 'm1',
      title: 'Advertise notice',
      status: 'done',
      order: 2,
    },
    [`orgs/${ORG}/matters/m2/notes/n1`]: {
      ...meta,
      bodyMd: 'Fictional privileged file note',
      ref: { not: 'a reference' },
    },
    [`orgs/${ORG}/matters/m1/documents/d1`]: {
      ...meta,
      name: 'Will – signed.pdf',
      category: 'will',
      version: 2,
      versions: [version(1, WILL_V1, 'Will draft.pdf'), version(2, WILL_V2, 'Will – signed.pdf')],
    },
    [`orgs/${ORG}/matters/m2/documents/d2`]: {
      ...meta,
      name: 'Letter.txt',
      version: 1,
      versions: [{ ...version(1, LETTER, 'Letter.txt'), storagePath: `orgs/${ORG}/matters/m2/documents/d2/v1` }],
    },
    [`orgs/${ORG}/matters/m1/documents/d1/chunks/c1`]: { text: 'Fictional chunk' },
    [`orgs/${ORG}/integrations/microsoft-user-owner`]: {
      provider: 'microsoft',
      uid: 'user-owner',
      ciphertext: 'secret',
    },
    [`orgs/${ORG}/invites/i1`]: { email: 'new@example.test', tokenHash: 'abc' },
    // Another practice whose id starts the same: never in this export.
    [`orgs/${ORG}y`]: { ...meta, name: 'Other Fictional Practice' },
    [`orgs/${ORG}y/matters/m9`]: { ...meta, number: '0001', title: 'Not ours', status: 'open' },
    [`orgs/${ORG}y/matters/m9/tasks/t9`]: {
      ...meta,
      orgId: `${ORG}y`,
      matterId: 'm9',
      title: 'Not ours',
      status: 'todo',
      order: 1,
    },
    ...extra,
  });
  const files = new MemoryFiles();
  files.put(`orgs/${ORG}/matters/m1/documents/d1/v1`, WILL_V1);
  files.put(`orgs/${ORG}/matters/m1/documents/d1/v2`, WILL_V2);
  files.put(`orgs/${ORG}/matters/m2/documents/d2/v1`, LETTER);
  files.put(`orgs/${ORG}/matters/m1/documents/d1/v2/renditions/preview.pdf`, 'preview');
  files.put(`orgs/${ORG}/matters/m1/pending/u1`, 'unfinished upload');
  files.put(`orgs/${ORG}/templates/letterhead.docx`, TEMPLATE);
  files.put(`orgs/${ORG}/exports/old-job.csv`, 'an earlier export');
  files.put(`orgs/${ORG}y/matters/m9/documents/d9/v1`, 'not ours');
  const clock = new FakeClock(NOW);
  const tasks = new FakeTaskQueue();
  const log = createLog({ fn: 'test' }, () => undefined);
  return { ...store, files, clock, tasks, log };
}
type World = ReturnType<typeof world>;

const callableDeps = (w: World): CallableDeps => ({
  db: () => w.db,
  clock: w.clock,
  ports: () => fakePorts({ tasks: w.tasks, clock: w.clock, signedUrls: new FakeSignedUrls() }),
  memberLookup: async () => true,
  idempotency: {
    begin: async () => ({ replay: false }),
    complete: async () => undefined,
    abandon: async () => undefined,
  },
  sink: () => undefined,
});

const startExport = (w: World, data: Data = {}, role: Role = 'owner', authAgoSeconds = 60) =>
  runCallable(
    orgExportDefinition({ partBytes: 10 * 1024 ** 3 }),
    {
      data: { requestId: REQUEST_ID, acknowledgePrivileged: true, ...data },
      auth: {
        uid: `user-${role}`,
        token: { orgId: ORG, role, auth_time: w.clock.now().getTime() / 1000 - authAgoSeconds },
      },
    },
    callableDeps(w),
  ).catch((error: unknown) => error as HttpsError);

const jobPath = (jobId: string) => `orgs/${ORG}/jobs/${jobId}`;

function exportDeps(w: World, overrides: Partial<RunOrgExportDeps> = {}): RunOrgExportDeps {
  return {
    db: w.db,
    files: w.files,
    clock: w.clock,
    log: w.log,
    ports: { tasks: w.tasks },
    attempt: 0,
    source: memorySource(w.docs, ORG),
    pageSize: 2,
    ...overrides,
  };
}

/** Starts an export job (with `partBytes`) and returns its id. */
async function queued(w: World, input: { allVersions?: boolean; partBytes?: number } = {}): Promise<string> {
  const result = (await runCallable(
    orgExportDefinition({ partBytes: input.partBytes ?? 10 * 1024 ** 3 }),
    {
      data: { requestId: crypto.randomUUID(), acknowledgePrivileged: true, allVersions: input.allVersions ?? false },
      auth: { uid: 'user-owner', token: { orgId: ORG, role: 'owner', auth_time: w.clock.now().getTime() / 1000 - 60 } },
    },
    callableDeps(w),
  )) as { jobId: string };
  return result.jobId;
}

/** Every part's files, unzipped, by name (with the part each came from). */
function unzipParts(w: World, jobId: string) {
  const job = w.docs.get(jobPath(jobId)) as Data;
  const output = job['output'] as { parts: { storagePath: string; sha256: string; sizeBytes: number }[] };
  const files = new Map<string, { part: number; bytes: Uint8Array }>();
  output.parts.forEach((part, index) => {
    const zip = w.files.objects.get(part.storagePath)?.data as Buffer;
    expect(sha(zip)).toBe(part.sha256);
    expect(zip.length).toBe(part.sizeBytes);
    for (const [name, bytes] of Object.entries(unzipSync(zip))) {
      expect(files.has(name), name).toBe(false);
      files.set(name, { part: index + 1, bytes });
    }
  });
  const manifest = OrgExportManifestSchema.parse(
    JSON.parse(Buffer.from(files.get('manifest.json')?.bytes ?? []).toString()),
  );
  return { job, output, files, manifest };
}

const jsonl = (bytes: Uint8Array | undefined) =>
  Buffer.from(bytes ?? [])
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { path: string; id: string; data: Data });

beforeEach(() => clearRetentionCache());

describe('the export format', () => {
  it('walks every org collection group but the excluded ones', () => {
    const groups = exportGroups();
    expect(groups).toEqual([...groups].sort());
    expect(groups).toEqual(expect.arrayContaining(['matters', 'tasks', 'documents', 'notes', 'members', 'audit']));
    expect(groups).not.toContain('chunks');
    expect(groups).not.toContain('integrations');
    expect(groups).not.toContain('invites');
    expect(groups).not.toContain('jobs');
  });

  it('has a JSON Schema per collection, with instants as $date and no references', () => {
    const schemas = exportSchemas();
    expect(schemas.has('matters')).toBe(true);
    expect(schemas.has('org')).toBe(true);
    expect(schemas.has('integrations')).toBe(false);
    const matters = JSON.stringify(schemas.get('matters'));
    expect(matters).toContain('"$date"');
    expect(matters).not.toContain('"$ref"');
  });

  it('writes Firestore values as portable JSON', () => {
    const at = new Date('2026-10-07T01:02:03.000Z');
    const timestamp = { toDate: () => at, toMillis: () => at.getTime() };
    expect(firestorePortable({ at: timestamp, n: [1, Number.NaN], skip: undefined }, ORG)).toEqual({
      at: { $date: '2026-10-07T01:02:03.000Z' },
      n: [1, { $number: 'NaN' }],
    });
  });

  it('names files safely and picks the versions to take', () => {
    expect(safeName('a/b\\c:d*?.pdf')).toBe('a_b_c_d_.pdf');
    expect(safeName('  ..  ', 'document')).toBe('document');
    expect(safeName(`${'x'.repeat(200)}.pdf`)).toHaveLength(150);
    const doc = { version: 2, versions: [version(2, WILL_V2, 'b.pdf'), version(1, WILL_V1, 'a.pdf')] };
    expect(exportedVersions(doc, false).map((v) => v.version)).toEqual([2]);
    expect(exportedVersions(doc, true).map((v) => v.version)).toEqual([1, 2]);
    expect(otherFile(ORG, `orgs/${ORG}/templates/letterhead.docx`)).toBe(true);
    expect(otherFile(ORG, `orgs/${ORG}/exports/j.zip`)).toBe(false);
    expect(otherFile(ORG, `orgs/${ORG}/matters/m1/documents/d1/v1`)).toBe(false);
    expect(otherFile(ORG, `orgs/${ORG}/matters/m1/pending/u1`)).toBe(false);
    expect(otherFile(ORG, `orgs/${ORG}/contacts/c1/renditions/x.pdf`)).toBe(false);
  });
});

describe('exports-orgFull', () => {
  it('queues the export for an owner who read the privileged warning, audited', async () => {
    const w = world();
    const result = (await startExport(w, { allVersions: true })) as { jobId: string; status: string };
    expect(result.status).toBe('queued');
    const job = w.docs.get(jobPath(result.jobId)) as Data;
    expect(job).toMatchObject({
      type: 'org.export',
      status: 'queued',
      createdBy: 'user-owner',
      input: { allVersions: true, partBytes: 10 * 1024 ** 3 },
      target: { kind: 'export', name: 'Fictional Harbour Legal export 2026-10-07' },
    });
    expect(w.tasks.queued).toEqual([
      {
        queue: ORG_EXPORT_QUEUE,
        payload: { orgId: ORG, jobId: result.jobId },
        options: { dedupeKey: `org-export-${result.jobId}-1` },
      },
    ]);
    const audit = [...w.docs.entries()].find(([path]) => path.startsWith(`orgs/${ORG}/audit/`))?.[1];
    expect(audit).toMatchObject({ action: 'export.created', data: { kind: 'org', privilegedAcknowledged: true } });
  });

  it('is for owners, signed in recently, who acknowledge the privileged material', async () => {
    const w = world();
    expect(await startExport(w, {}, 'admin')).toMatchObject({ code: 'permission-denied' });
    expect(await startExport(w, {}, 'owner', 3600)).toMatchObject({ code: 'unauthenticated' });
    expect(await startExport(w, { acknowledgePrivileged: false })).toMatchObject({ code: 'invalid-argument' });
  });

  it('runs one full export at a time', async () => {
    const w = world();
    await startExport(w);
    expect(await startExport(w)).toMatchObject({ code: 'failed-precondition', details: { reason: 'export_running' } });
    // A job silent for over two hours has died: it no longer blocks.
    w.clock.advance(3 * 60 * 60 * 1000);
    expect(await startExport(w)).toMatchObject({ status: 'queued' });
  });
});

describe('runOrgExport', () => {
  it('writes the practice as JSONL, its documents and other files, schemas, README and a manifest', async () => {
    const w = world();
    const jobId = await queued(w);
    expect(await runOrgExport(exportDeps(w), { orgId: ORG, jobId })).toBe('succeeded');
    const { job, output, files, manifest } = unzipParts(w, jobId);

    expect(job).toMatchObject({ status: 'succeeded', progress: { stage: 'done' } });
    expect(job['checkpoint']).toBeUndefined();
    expect(output.parts).toHaveLength(1);
    expect(output).toMatchObject({ storagePath: orgExportPartPath(ORG, jobId, 1), rows: expect.any(Number) });

    const names = [...files.keys()].sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'data/org.jsonl',
        'data/matters.jsonl',
        'data/matters.tasks.jsonl',
        'data/matters.notes.jsonl',
        'data/matters.documents.jsonl',
        'data/members.jsonl',
        'data/members.tasks.jsonl',
        'files/matters/m1/d1/v2/Will – signed.pdf',
        'files/matters/m2/d2/v1/Letter.txt',
        'files/templates/letterhead.docx',
        'schemas/matters.schema.json',
        'README.md',
        'manifest.json',
      ]),
    );
    // The current version only; no previews, pending uploads, exports, chunks, tokens or invites.
    expect(names.some((name) => name.includes('/v1/Will'))).toBe(false);
    expect(names.filter((name) => /renditions|pending|exports|chunks|integrations|invites|jobs/.test(name))).toEqual(
      [],
    );

    expect(jsonl(files.get('data/org.jsonl')?.bytes)).toEqual([
      expect.objectContaining({
        path: '',
        id: ORG,
        data: expect.objectContaining({ name: 'Fictional Harbour Legal' }),
      }),
    ]);
    const matters = jsonl(files.get('data/matters.jsonl')?.bytes);
    expect(matters.map((record) => record.path)).toEqual(['matters/m1', 'matters/m2']);
    expect(matters[0]?.data['createdAt']).toEqual({ $date: NOW.toISOString() });
    expect(jsonl(files.get('data/matters.tasks.jsonl')?.bytes).map((record) => record.id)).toEqual(['t1', 't2']);
    // No other practice's records, even one whose id starts the same.
    for (const [name, file] of files) {
      if (name.startsWith('data/')) expect(Buffer.from(file.bytes).toString()).not.toContain('Not ours');
    }

    // Every file's checksum is in the manifest, and the documents' match their recorded versions.
    expect(manifest).toMatchObject({
      orgId: ORG,
      orgName: 'Fictional Harbour Legal',
      parts: 1,
      allVersions: false,
      createdBy: 'user-owner',
    });
    expect(manifest.collections).toMatchObject({ org: 1, matters: 2, 'matters.tasks': 2, 'members.tasks': 1 });
    const listed = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    for (const [name, file] of files) {
      if (name === 'manifest.json') continue;
      expect(listed.get(name)?.sha256, name).toBe(sha(file.bytes));
      expect(listed.get(name)?.bytes, name).toBe(file.bytes.length);
    }
    expect(listed.get('files/matters/m1/d1/v2/Will – signed.pdf')).toMatchObject({
      kind: 'file',
      sha256: sha(WILL_V2),
      matterId: 'm1',
      documentId: 'd1',
      version: 2,
      storagePath: `orgs/${ORG}/matters/m1/documents/d1/v2`,
    });
    const readme = Buffer.from(files.get('README.md')?.bytes ?? []).toString();
    expect(readme).toContain('privileged and confidential material');

    // Told and audited; the manifest's working copy is gone.
    const notification = [...w.docs.entries()].find(([path]) => path.includes('/notifications/'))?.[1];
    expect(notification).toMatchObject({ kind: 'export_ready', exportId: jobId, link: `/exports/${jobId}` });
    const audits = [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, d]) => d);
    expect(audits).toContainEqual(expect.objectContaining({ action: 'export.org_completed' }));
    expect([...w.docs.keys()].filter((path) => path.startsWith(`${jobPath(jobId)}/manifest/`))).toEqual([]);
  });

  it('takes every version with allVersions', async () => {
    const w = world();
    const jobId = await queued(w, { allVersions: true });
    await runOrgExport(exportDeps(w), { orgId: ORG, jobId });
    const { files, manifest } = unzipParts(w, jobId);
    expect(Buffer.from(files.get('files/matters/m1/d1/v1/Will draft.pdf')?.bytes ?? []).equals(WILL_V1)).toBe(true);
    expect(Buffer.from(files.get('files/matters/m1/d1/v2/Will – signed.pdf')?.bytes ?? []).equals(WILL_V2)).toBe(true);
    expect(manifest.allVersions).toBe(true);
  });

  it('splits an export over the part size into several complete zips, the manifest in the last', async () => {
    const w = world();
    const jobId = await queued(w, { allVersions: true, partBytes: 600 });
    expect(await runOrgExport(exportDeps(w), { orgId: ORG, jobId })).toBe('succeeded');
    const { output, files, manifest } = unzipParts(w, jobId);
    expect(output.parts.length).toBeGreaterThan(2);
    expect(output.parts.map((part) => part.storagePath)).toEqual(
      output.parts.map((_, i) => orgExportPartPath(ORG, jobId, i + 1)),
    );
    expect(manifest.parts).toBe(output.parts.length);
    expect(files.get('manifest.json')?.part).toBe(output.parts.length);
    // Every file is listed once, in the part it is in, with its checksum.
    const listed = manifest.entries;
    expect(new Set(listed.map((entry) => entry.path)).size).toBe(listed.length);
    for (const entry of listed) {
      expect(files.get(entry.path)?.part, entry.path).toBe(entry.part);
      expect(sha(files.get(entry.path)?.bytes ?? new Uint8Array()), entry.path).toBe(entry.sha256);
    }
    // The records all arrive, a JSONL file continuing in the next part when cut.
    const tasks = [...files.keys()].filter((name) => /^data\/matters\.tasks(\.\d+)?\.jsonl$/.test(name));
    expect(tasks.flatMap((name) => jsonl(files.get(name)?.bytes).map((record) => record.id))).toEqual(['t1', 't2']);
    expect(manifest.collections['matters.tasks']).toBe(2);
  });

  it('hands over to the next task when out of time, and resumes where it stopped', async () => {
    const w = world();
    const jobId = await queued(w, { allVersions: true, partBytes: 600 });
    w.tasks.queued.length = 0;
    let now = 0;
    const deps = exportDeps(w, { budgetMs: 1000, elapsed: () => (now += 400) });
    let outcome = await runOrgExport(deps, { orgId: ORG, jobId });
    let tasks = 0;
    while (outcome === 'continued') {
      tasks++;
      const job = w.docs.get(jobPath(jobId)) as Data;
      const checkpoint = job['checkpoint'] as { part: number; writer?: unknown };
      // The next task is queued, and the job isn't held by a writer meanwhile.
      expect(w.tasks.queued.at(-1)).toEqual({
        queue: ORG_EXPORT_QUEUE,
        payload: { orgId: ORG, jobId },
        options: { dedupeKey: `org-export-${jobId}-${checkpoint.part}` },
      });
      expect(checkpoint.writer).toBeUndefined();
      expect(tasks).toBeLessThan(50);
      outcome = await runOrgExport(deps, { orgId: ORG, jobId });
    }
    expect(outcome).toBe('succeeded');
    expect(tasks).toBeGreaterThan(0);
    const { files, manifest } = unzipParts(w, jobId);
    for (const entry of manifest.entries)
      expect(sha(files.get(entry.path)?.bytes ?? new Uint8Array())).toBe(entry.sha256);
    expect(manifest.collections).toMatchObject({ matters: 2, 'matters.tasks': 2 });
  });

  it('waits while another task holds the job, and takes over from one gone silent', async () => {
    const w = world();
    const jobId = await queued(w);
    await w.db.doc(jobPath(jobId)).update({ checkpoint: { part: 1, writer: { token: 'other' } }, heartbeatAt: NOW });
    await expect(runOrgExport(exportDeps(w), { orgId: ORG, jobId })).rejects.toThrow(/Another task/);
    w.clock.advance(6 * 60_000);
    expect(await runOrgExport(exportDeps(w), { orgId: ORG, jobId })).toBe('succeeded');
  });

  it('discards the export when its owner is no longer one', async () => {
    const w = world();
    const jobId = await queued(w);
    await w.db.doc(`orgs/${ORG}/members/user-owner`).update({ role: 'admin' });
    expect(await runOrgExport(exportDeps(w), { orgId: ORG, jobId })).toBe('discarded');
    expect(w.docs.get(jobPath(jobId))).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } });
    expect(w.files.objects.has(orgExportPartPath(ORG, jobId, 1))).toBe(false);
  });

  it('retries a failed task, and the last attempt fails the job and removes its parts', async () => {
    const w = world();
    const jobId = await queued(w, { partBytes: 600 });
    const write = vi.spyOn(w.files, 'writeStream').mockRejectedValue(new Error('storage down'));
    const deps = exportDeps(w);
    await expect(runOrgExport(deps, { orgId: ORG, jobId })).rejects.toThrow('storage down');
    expect((w.docs.get(jobPath(jobId)) as Data)['checkpoint']).not.toHaveProperty('writer');
    expect(await runOrgExport({ ...deps, attempt: 7 }, { orgId: ORG, jobId })).toBe('failed');
    expect(w.docs.get(jobPath(jobId))).toMatchObject({ status: 'failed', error: { retryable: true } });
    write.mockRestore();
  });

  it('skips a job already finished', async () => {
    const w = world();
    const jobId = await queued(w);
    await runOrgExport(exportDeps(w), { orgId: ORG, jobId });
    expect(await runOrgExport(exportDeps(w), { orgId: ORG, jobId })).toBe('skipped');
  });
});

describe('jobs-getExportUrl for a split export', () => {
  it('signs the part asked for and says how many there are', async () => {
    const w = world();
    const jobId = await queued(w, { allVersions: true, partBytes: 600 });
    await runOrgExport(exportDeps(w), { orgId: ORG, jobId });
    const parts = ((w.docs.get(jobPath(jobId)) as Data)['output'] as { parts: unknown[] }).parts.length;
    const signedUrls = new FakeSignedUrls();
    const call = (part?: number) =>
      runCallable(
        getExportUrlDefinition(() => 'test-bucket'),
        {
          data: { jobId, ...(part ? { part } : {}) },
          auth: { uid: 'user-owner', token: { orgId: ORG, role: 'owner' } },
        },
        { ...callableDeps(w), ports: () => fakePorts({ signedUrls, clock: w.clock }) },
      ).catch((error: unknown) => error as HttpsError);
    expect(await call()).toMatchObject({
      part: 1,
      parts,
      fileName: `Fictional Harbour Legal export 2026-10-07 part 1 of ${parts}.zip`,
    });
    expect(await call(2)).toMatchObject({ part: 2, parts });
    expect(signedUrls.signed.at(-1)?.path).toBe(orgExportPartPath(ORG, jobId, 2));
    expect(await call(parts + 1)).toMatchObject({ code: 'not-found' });
  });
});

describe('the manifest', () => {
  it('is valid for the domain schema', () => {
    const manifest: OrgExportManifest = {
      format: 'materia.org-export',
      version: 1,
      orgId: ORG,
      orgName: 'Fictional Harbour Legal',
      createdAt: NOW.toISOString(),
      createdBy: 'user-owner',
      allVersions: false,
      parts: 1,
      collections: { matters: 2 },
      entries: [
        {
          path: 'data/matters.jsonl',
          part: 1,
          kind: 'data',
          bytes: 10,
          sha256: sha('x'),
          collection: 'matters',
          records: 2,
        },
      ],
    };
    expect(OrgExportManifestSchema.parse(manifest)).toEqual(manifest);
  });
});
