import { TestBed } from '@angular/core/testing';

import { OrgContext } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';

import { DocumentUploads, uploadErrorCopy, uploadView, type UploadItem } from './document-uploads';
import type { DocumentRow } from './documents-view';
import { docRow, FakeUploadPort, pipelineUpload, storedVersion } from './testing';
import { lazyUploadPort, UPLOAD_PORT, UploadCancelled, type UploadPort } from './upload-port';

/** The upload queue (CORE-12): hashing, sending a few at a time, cancel and retry. Fictional data only. */

const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
/** The `i`th entry, which the test expects to exist. */
function nth<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`No entry ${i}`);
  return value;
}
const file = (name: string, text = `Fictional contents of ${name}`) => new File([text], name, { type: 'text/plain' });

function setup() {
  const port = new FakeUploadPort();
  TestBed.configureTestingModule({
    providers: [provideInMemoryFirestore(new InMemoryFirestore()), { provide: UPLOAD_PORT, useValue: port }],
  });
  TestBed.inject(OrgContext).setSession({ uid: 'user-jordan', orgId: 'org-harbour-vine', role: 'lawyer' });
  const uploads = TestBed.inject(DocumentUploads);
  const phases = () => uploads.items().map((item) => `${item.fileName}:${item.phase}`);
  return { port, uploads, phases };
}

describe('DocumentUploads', () => {
  it('hashes each file and sends it to the pending area with the contract metadata', async () => {
    const { port, uploads } = setup();
    uploads.add('m-whitfield', [file('note.txt', 'Fictional file note.')], { category: 'correspondence' });
    await settle();
    expect(port.transfers).toHaveLength(1);
    const [transfer] = port.transfers;
    const [item] = uploads.items();
    expect(transfer?.path).toBe(`orgs/org-harbour-vine/matters/m-whitfield/pending/${item?.uploadId}`);
    expect(transfer?.settings.customMetadata['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(transfer?.settings.customMetadata['category']).toBe('correspondence');
    expect(item?.phase).toBe('uploading');

    transfer?.progress(10);
    expect(uploadView(nth(uploads.items(), 0), new Map()).text).toBe('Uploading 50%');
    transfer?.finish();
    await settle();
    expect(uploads.items()[0]).toMatchObject({ phase: 'sent', sent: 20 });
    expect(uploadView(nth(uploads.items(), 0), new Map()).text).toBe('Checking the file…');
  });

  it('takes 20 files at once, three in flight, and refuses unusable files up front', async () => {
    const { port, uploads, phases } = setup();
    const files = Array.from({ length: 22 }, (_, i) => file(`note-${i + 1}.txt`));
    files[1] = file('tool.exe');
    const result = uploads.add('m-whitfield', files);
    expect(result).toEqual({ added: 20, dropped: 2 });
    await settle();
    expect(port.transfers).toHaveLength(3);
    expect(phases().slice(0, 5)).toEqual([
      'note-1.txt:uploading',
      'tool.exe:invalid',
      'note-3.txt:uploading',
      'note-4.txt:uploading',
      'note-5.txt:waiting',
    ]);
    expect(uploads.items()[1]?.error).toMatch(/can’t be added/);

    port.of('note-1.txt').finish();
    await settle();
    expect(port.transfers).toHaveLength(4);
    expect(uploads.forMatter('m-whitfield')).toHaveLength(20);
    expect(uploads.forMatter('m-other')).toHaveLength(0);
  });

  it('cancels, retries under a new upload id, and dismisses', async () => {
    const { port, uploads, phases } = setup();
    uploads.add('m-whitfield', [file('will.txt'), file('codicil.txt')], { documentId: 'd-will', privileged: true });
    await settle();
    const first = nth(uploads.items(), 0);
    expect(port.of('will.txt').settings.customMetadata['documentId']).toBe('d-will');
    uploads.cancel(first.key);
    await settle();
    expect(port.of('will.txt').cancelled).toBe(true);
    expect(phases()).toEqual(['will.txt:cancelled', 'codicil.txt:uploading']);
    expect(uploadView(nth(uploads.items(), 0), new Map())).toMatchObject({ text: 'Cancelled', canRetry: true });

    uploads.retry(first.key);
    await settle();
    expect(phases()[0]).toBe('will.txt:uploading');
    expect(uploads.items()[0]?.uploadId).not.toBe(first.uploadId);

    port.of('codicil.txt').fail({ code: 'storage/unauthorized' });
    await settle();
    expect(uploads.items()[1]).toMatchObject({
      phase: 'failed',
      error: 'Your role can’t add documents to this matter.',
    });
    // A running upload can't be retried; a failed one can.
    uploads.retry(nth(uploads.items(), 0).key);
    expect(phases()[0]).toBe('will.txt:uploading');

    uploads.dismiss(nth(uploads.items(), 0).key);
    uploads.clear([nth(uploads.items(), 0).key]);
    expect(uploads.items()).toEqual([]);
  });
});

describe('uploadErrorCopy', () => {
  it('says what went wrong without SDK text', () => {
    expect(uploadErrorCopy({ code: 'storage/quota-exceeded' })).toMatch(/no room/);
    expect(uploadErrorCopy({ code: 'INVALID_ARGUMENT' })).toBe('This type of file can’t be added.');
    expect(uploadErrorCopy(new Error('socket hang up'))).toBe(
      'The upload didn’t finish. Check your connection and try again.',
    );
  });
});

describe('uploadView', () => {
  const sent = (extra: Partial<UploadItem> = {}): UploadItem => ({
    key: 'u1',
    matterId: 'm-whitfield',
    fileName: 'Statement.pdf',
    size: 10,
    uploadId: 'up-1',
    phase: 'sent',
    sent: 10,
    ...extra,
  });
  const docs = (...rows: DocumentRow[]) => new Map(rows.map((row) => [row.id, row]));

  it('follows the new document through the pipeline', () => {
    expect(uploadView(sent({ phase: 'waiting' }), docs())).toMatchObject({ text: 'Waiting…', canCancel: true });
    expect(uploadView(sent({ phase: 'hashing' }), docs())).toMatchObject({ text: 'Preparing…' });
    expect(uploadView(sent({ phase: 'uploading', size: 0 }), docs()).percent).toBe(0);
    expect(uploadView(sent({ phase: 'invalid', error: 'This file is empty.' }), docs()).text).toBe(
      'This file is empty.',
    );
    expect(uploadView(sent({ phase: 'failed' }), docs()).canRetry).toBe(true);

    const scanning = docRow('up-1', 'Statement.pdf', { version: 0, versions: [], upload: pipelineUpload('scanning') });
    expect(uploadView(sent(), docs(scanning))).toMatchObject({ text: 'Scanning…', docId: 'up-1', finished: false });
    const delayed = docRow('up-1', 'Statement.pdf', { version: 0, versions: [], upload: pipelineUpload('delayed') });
    expect(uploadView(sent(), docs(delayed)).text).toBe('Scanning delayed');
    const infected = docRow('up-1', 'Statement.pdf', {
      version: 0,
      versions: [],
      scan: { status: 'infected' },
      upload: pipelineUpload('infected'),
    });
    expect(uploadView(sent(), docs(infected))).toMatchObject({ tone: 'danger', canRetry: false, finished: true });
    expect(uploadView(sent(), docs(infected)).text).toMatch(/^Quarantined: /);
    const rejected = docRow('up-1', 'Statement.pdf', {
      version: 0,
      versions: [],
      upload: pipelineUpload('rejected', { reason: 'too_large' }),
    });
    expect(uploadView(sent(), docs(rejected))).toMatchObject({
      text: 'Rejected: The file is over 50 MB.',
      canRetry: true,
    });
    expect(uploadView(sent(), docs(docRow('up-1', 'Statement.pdf')))).toMatchObject({ text: 'Ready', finished: true });
    expect(uploadView(sent(), docs(docRow('up-1', 'Statement.pdf', { deletedAt: new Date() })))).toMatchObject({
      text: 'Discarded',
    });
  });

  it('names the original of a possible duplicate', () => {
    const copy = docRow('up-1', 'Will copy.pdf', { duplicateOf: 'd-will' });
    expect(uploadView(sent(), docs(copy, docRow('d-will', 'Will.pdf')))).toMatchObject({
      text: 'Duplicate of Will.pdf',
      duplicate: true,
    });
    expect(uploadView(sent(), docs(copy)).text).toBe('Duplicate of Removed document');
  });

  it('reports a new version once it is added', () => {
    const item = sent({ documentId: 'd-will', uploadId: 'up-2' });
    expect(uploadView(item, docs()).text).toBe('Checking the file…');
    const before = docRow('d-will', 'Will.pdf');
    expect(uploadView(item, docs(before))).toMatchObject({ text: 'Checking the file…', docId: 'd-will' });
    const scanning = docRow('d-will', 'Will.pdf', { upload: pipelineUpload('scanning', { uploadId: 'up-2' }) });
    expect(uploadView(item, docs(scanning)).text).toBe('Scanning…');
    const added = docRow('d-will', 'Will.pdf', {
      version: 2,
      versions: [
        storedVersion('d-will', 1, 'Will.pdf'),
        storedVersion('d-will', 2, 'Will signed.pdf', { uploadId: 'up-2' }),
      ],
    });
    expect(uploadView(item, docs(added))).toMatchObject({ text: 'Added as version 2', finished: true });
  });
});

describe('lazyUploadPort', () => {
  it('loads the real port on the first upload only', async () => {
    const inner = new FakeUploadPort();
    let loads = 0;
    const port = lazyUploadPort(async () => {
      loads++;
      return inner as UploadPort;
    });
    const settings = { contentType: 'text/plain', customMetadata: {} };
    const a = port.upload('p/1', file('a.txt'), settings, () => undefined);
    const b = port.upload('p/2', file('b.txt'), settings, () => undefined);
    await settle();
    inner.of('a.txt').finish();
    inner.of('b.txt').finish();
    await Promise.all([a.done, b.done]);
    expect(loads).toBe(1);

    const c = port.upload('p/3', file('c.txt'), settings, () => undefined);
    c.cancel();
    await expect(c.done).rejects.toBeInstanceOf(UploadCancelled);
    expect(inner.transfers.map((t) => t.path)).toEqual(['p/1', 'p/2']);
  });
});
