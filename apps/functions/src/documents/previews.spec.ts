import { renditionPath, type DocumentVersion } from '@materia/domain';

import { previewService } from './preview';
import { previewFor, RENDER_QUEUE, renderPreview, RenderTaskSchema, startRenditions } from './renditions';
import { MemoryFiles } from './testing';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { PreviewUnavailableError, type PreviewPort } from '../ports';
import {
  FAKE_PREVIEW_FAIL_MARKER,
  FAKE_PREVIEW_JPEG,
  FAKE_PREVIEW_PDF,
  FakeClock,
  FakeTaskQueue,
  fakePorts,
  fakePreview,
} from '../ports/fakes';

/** Office and HEIC previews (CORE-12a): queueing, the render task and the HTTP adapter. Fictional data only. */

const ORG = 'org-a';
const DOCS = `orgs/${ORG}/matters/m1/documents`;
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
type Data = Record<string, unknown>;

const version = (n: number, fileName: string): DocumentVersion => ({
  version: n,
  storagePath: `${DOCS}/d1/v${n}`,
  fileName,
  mime: 'application/octet-stream',
  sizeBytes: 10,
  sha256: 'a'.repeat(64),
  uploadedAt: new Date('2026-10-05T00:00:00Z'),
  uploadedBy: 'user-lawyer',
  uploadId: `upload-${n}`,
});

function world(versions: DocumentVersion[] = [version(1, 'Fictional will.docx')], extra: Data = {}) {
  const current = versions.at(-1);
  const store = memoryFirestore({
    [`${DOCS}/d1`]: {
      ...meta,
      orgId: ORG,
      matterId: 'm1',
      name: 'Fictional will',
      version: current?.version ?? 0,
      versions,
      scan: { status: 'clean' },
      deletedAt: null,
      ...extra,
    },
  });
  const files = new MemoryFiles();
  for (const v of versions) files.put(v.storagePath, `fictional bytes of ${v.fileName}`);
  const tasks = new FakeTaskQueue();
  const preview = vi.fn<PreviewPort['render']>(fakePreview.render);
  const ports = fakePorts({ tasks, preview: { render: preview } });
  const logged: { message: string; entry: Data }[] = [];
  const log = createLog({ fn: 'test' }, (_s, message, entry) => void logged.push({ message, entry }));
  const deps = { db: store.db, files, ports, log, clock: new FakeClock(new Date('2026-10-05T01:00:00Z')) };
  const doc = () => store.docs.get(`${DOCS}/d1`) as Data;
  return { ...store, files, tasks, preview, deps, doc, logged };
}

describe('previewFor', () => {
  it('maps Office files to a PDF preview and HEIC photos to a JPEG one', () => {
    for (const ext of ['docx', 'doc', 'xlsx', 'xls', 'pptx']) {
      expect(previewFor(`Fictional.${ext.toUpperCase()}`)).toMatchObject({
        rendition: 'previewPdf',
        from: ext,
        to: 'pdf',
      });
    }
    expect(previewFor('IMG_0001.heic')).toEqual({
      rendition: 'previewImage',
      from: 'heic',
      to: 'jpeg',
      contentType: 'image/jpeg',
    });
    for (const name of ['Brief.pdf', 'Photo.jpg', 'Letter.eml', 'notes.txt', 'archive.zip', 'no-extension']) {
      expect(previewFor(name)).toBeNull();
    }
  });
});

describe('startRenditions', () => {
  it('queues a preview for Office and HEIC versions, once per version', async () => {
    const w = world([version(1, 'Fictional will.docx'), version(2, 'IMG_0001.heic')]);
    const base = { orgId: ORG, matterId: 'm1', docId: 'd1', kind: 'docx' as const, uploaderUid: 'user-lawyer' };
    await startRenditions(w.deps, { ...base, version: version(1, 'Fictional will.docx'), data: Buffer.from('x') });
    await startRenditions(w.deps, { ...base, version: version(2, 'IMG_0001.heic'), data: Buffer.from('x') });
    await startRenditions(w.deps, { ...base, version: version(3, 'Brief.pdf'), data: Buffer.from('%PDF-') });
    expect(w.tasks.queued).toEqual([
      {
        queue: RENDER_QUEUE,
        payload: { orgId: ORG, matterId: 'm1', docId: 'd1', version: 1 },
        options: { dedupeKey: `render#${ORG}#m1#d1#1` },
      },
      expect.objectContaining({ payload: { orgId: ORG, matterId: 'm1', docId: 'd1', version: 2 } }),
    ]);
    expect(RenderTaskSchema.parse(w.tasks.queued[0]?.payload)).toBeTruthy();
    expect(w.preview).not.toHaveBeenCalled(); // converting waits for the task
  });
});

describe('renderPreview', () => {
  const task = (n = 1) => ({ orgId: ORG, matterId: 'm1', docId: 'd1', version: n });

  it('converts an Office version to PDF and records the rendition on the version and the document', async () => {
    const w = world();
    await expect(renderPreview(task(), w.deps)).resolves.toBe('rendered');
    expect(w.preview).toHaveBeenCalledWith(
      { from: 'docx', to: 'pdf', data: Buffer.from('fictional bytes of Fictional will.docx') },
      expect.any(AbortSignal),
    );
    const path = renditionPath(ORG, 'm1', 'd1', 1, 'previewPdf');
    expect(path).toBe(`${DOCS}/d1/renditions/v1/preview.pdf`);
    expect(w.files.objects.get(path)?.data.equals(FAKE_PREVIEW_PDF)).toBe(true);
    expect(w.files.objects.get(path)?.object.contentType).toBe('application/pdf');
    expect(w.doc()).toMatchObject({
      renditions: { previewPdf: path },
      versions: [expect.objectContaining({ renditions: { previewPdf: path } })],
    });
    // Once rendered, a redelivered task does nothing.
    await expect(renderPreview(task(), w.deps)).resolves.toBe('skipped');
    expect(w.preview).toHaveBeenCalledTimes(1);
  });

  it('converts a HEIC photo to a JPEG preview', async () => {
    const w = world([version(1, 'IMG_0001.HEIC')]);
    await expect(renderPreview(task(), w.deps)).resolves.toBe('rendered');
    const path = renditionPath(ORG, 'm1', 'd1', 1, 'previewImage');
    expect(w.files.objects.get(path)?.data.equals(FAKE_PREVIEW_JPEG)).toBe(true);
    expect(w.files.objects.get(path)?.object.contentType).toBe('image/jpeg');
    expect(w.doc()['renditions']).toEqual({ previewImage: path });
  });

  it('gives an older version its preview without touching the current one', async () => {
    const w = world([version(1, 'Draft.docx'), version(2, 'Final.docx')]);
    await renderPreview(task(1), w.deps);
    expect(w.doc()['renditions']).toBeUndefined();
    expect((w.doc()['versions'] as DocumentVersion[])[0]?.renditions?.previewPdf).toBe(
      renditionPath(ORG, 'm1', 'd1', 1, 'previewPdf'),
    );
  });

  it('leaves a file the service cannot convert without a preview (no retry)', async () => {
    const w = world();
    w.files.put(`${DOCS}/d1/v1`, `damaged ${FAKE_PREVIEW_FAIL_MARKER}`);
    await expect(renderPreview(task(), w.deps)).resolves.toBe('failed');
    expect([...w.files.objects.keys()].some((p) => p.includes('/renditions/'))).toBe(false);
    expect(w.logged).toContainEqual(
      expect.objectContaining({ message: 'preview failed', entry: expect.objectContaining({ from: 'docx' }) }),
    );
    expect(JSON.stringify(w.logged)).not.toContain('Fictional will');
  });

  it('throws while the service is down or not deployed, so Cloud Tasks retries', async () => {
    const w = world();
    w.preview.mockRejectedValueOnce(new PreviewUnavailableError('unavailable'));
    await expect(renderPreview(task(), w.deps)).rejects.toMatchObject({ reason: 'unavailable' });
    w.preview.mockRejectedValueOnce(new PreviewUnavailableError('not_configured'));
    await expect(renderPreview(task(), w.deps)).rejects.toMatchObject({ reason: 'not_configured' });
    expect(w.doc()['renditions']).toBeUndefined();
  });

  it('skips removed documents, missing versions or bytes, and files without a preview', async () => {
    expect(await renderPreview(task(), world(undefined, { deletedAt: new Date('2026-10-05T00:30:00Z') }).deps)).toBe(
      'skipped',
    );
    expect(await renderPreview(task(7), world().deps)).toBe('skipped');
    expect(await renderPreview(task(), world([version(1, 'Brief.pdf')]).deps)).toBe('skipped');
    const gone = world();
    await gone.files.remove(`${DOCS}/d1/v1`);
    expect(await renderPreview(task(), gone.deps)).toBe('skipped');
    expect(await renderPreview({ ...task(), docId: 'nope' }, world().deps)).toBe('skipped');
  });
});

describe('previewService', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('fictional')]);
  const respond = (status: number, body: Uint8Array | string = '') =>
    vi.fn<typeof fetch>(async () => new Response(body as BodyInit, { status }));

  it('posts the bytes with an ID token and returns the converted file', async () => {
    const fetch = respond(200, pdf);
    const service = previewService({
      url: () => 'https://preview.example.test/',
      idToken: async (a) => `token-for-${a}`,
      fetch,
    });
    const out = await service.render({ from: 'docx', to: 'pdf', data: Buffer.from('fictional docx') });
    expect(out.equals(pdf)).toBe(true);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://preview.example.test/convert?from=docx&to=pdf');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer token-for-https://preview.example.test' },
    });
    expect(Buffer.from(init.body as ArrayBuffer).toString()).toBe('fictional docx');
    const jpeg = previewService({
      url: () => 'https://p.example.test',
      idToken: async () => 't',
      fetch: respond(200, FAKE_PREVIEW_JPEG),
    });
    expect((await jpeg.render({ from: 'heic', to: 'jpeg', data: Buffer.from('x') })).equals(FAKE_PREVIEW_JPEG)).toBe(
      true,
    );
  });

  it.each([
    ['no URL configured', '', respond(200, pdf), 'not_configured'],
    ['an unsupported file', 'https://p.example.test', respond(415), 'failed'],
    ['a file that cannot be converted', 'https://p.example.test', respond(422), 'failed'],
    ['bytes that are not a PDF', 'https://p.example.test', respond(200, '<html>'), 'failed'],
    ['a server error', 'https://p.example.test', respond(503), 'unavailable'],
    ['a refused token', 'https://p.example.test', respond(403), 'unavailable'],
    [
      'a network error',
      'https://p.example.test',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
      'unavailable',
    ],
  ])('reports %s', async (_label, url, fetch, reason) => {
    const service = previewService({
      url: () => url,
      idToken: async () => 't',
      fetch: fetch as typeof globalThis.fetch,
    });
    const error = await service.render({ from: 'docx', to: 'pdf', data: Buffer.from('x') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreviewUnavailableError);
    expect(error).toMatchObject({ reason });
  });
});
