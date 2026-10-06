import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import type { Role } from '@materia/domain';

import { DOCX_MIME } from './docx';
import { generateDefinition, generatedDocumentId } from './generate';
import { systemTemplateDocx } from './system-templates';
import {
  deleteTemplateDefinition,
  downloadTemplateDefinition,
  previewTemplateDefinition,
  publishTemplateDefinition,
  saveLetterheadDefinition,
  saveTemplateDefinition,
  unpublishTemplateDefinition,
} from './templates';
import { docxText, docxWith, doyleSources } from './testing';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { MemoryFiles } from '../documents/testing';
import { memoryFirestore } from '../orgs/testing';
import { EICAR_TEST_STRING, FAKE_SCANNER_TIMEOUT_MARKER, FakeClock, FakeTaskQueue, fakePorts } from '../ports/fakes';

/** Unit tests for the document template callables (INT-06). Every firm, person and matter is fictional. */

const ORG = 'org-a';
const MATTERS = `orgs/${ORG}/matters`;
const TEMPLATES = `orgs/${ORG}/docTemplates`;
const at = new Date('2026-09-01T00:00:00.000Z');
const meta = { createdAt: at, createdBy: 'user-owner', updatedAt: at, updatedBy: 'user-owner', schemaVersion: 1 };

type Data = Record<string, unknown>;

const sources = doyleSources();
const letter = systemTemplateDocx('system-letter').data;

const matter = (extra: Data = {}) => ({
  ...meta,
  createdAt: new Date('2026-07-20T01:00:00.000Z'),
  number: 'HV-2026-0001',
  title: 'Estate of Margaret Doyle',
  type: 'probate',
  jurisdiction: 'VIC',
  status: 'active',
  privileged: false,
  responsibleUid: 'user-lawyer',
  clientContactIds: ['c-catherine-doyle'],
  deceased: { contactId: 'c-margaret-doyle', dateOfDeath: '2026-07-17', domicile: 'VIC' },
  fee: { arrangement: 'fixed', amountCents: 440_000 },
  deletedAt: null,
  ...extra,
});

const templateVersion = (version: number, extra: Data = {}) => ({
  version,
  storagePath: `${TEMPLATES}/dt-1/v${version}.docx`,
  fileName: `Engagement letter v${version}.docx`,
  sizeBytes: letter.length,
  sha256: String(version).repeat(64),
  fields: ['client.firstName'],
  warnings: [],
  uploadedAt: at,
  uploadedBy: 'user-owner',
  ...extra,
});

const template = (extra: Data = {}) => ({
  ...meta,
  name: 'Engagement letter',
  kind: 'letter',
  matterTypes: [],
  storagePath: `${TEMPLATES}/dt-1/v2.docx`,
  fields: ['client.firstName'],
  version: 2,
  versions: [
    templateVersion(1),
    templateVersion(2, { warnings: ['The PDF preview uses a similar font in place of Aptos.'] }),
  ],
  published: true,
  publishedVersion: 1,
  deletedAt: null,
  ...extra,
});

function world() {
  const contacts = Object.fromEntries(
    Object.entries(sources.contacts).map(([id, contact]) => [
      `orgs/${ORG}/contacts/${id}`,
      { ...meta, ...contact, deletedAt: null },
    ]),
  );
  const parties = Object.fromEntries(
    sources.parties
      .filter((party) => party.role !== 'deceased')
      .map((party, index) => [
        `${MATTERS}/m1/parties/p${index + 1}`,
        { ...meta, createdAt: new Date(at.getTime() + index * 1000), ...party, deletedAt: null },
      ]),
  );
  const member = (displayName: string, extra: Data = {}) => ({ ...meta, status: 'active', displayName, ...extra });
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { ...meta, name: 'Harbour & Vine Legal', abn: '00000000001', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/settings/letterhead`]: { ...meta, ...sources.letterhead },
    [`orgs/${ORG}/members/user-lawyer`]: member('Jordan Price', {
      title: 'Senior Associate',
      email: 'lawyer@harbourvine.example',
      defaultRateCents: 45_000,
    }),
    [`orgs/${ORG}/members/user-paralegal`]: member('Daniel Kim', { title: 'Paralegal' }),
    [`orgs/${ORG}/members/user-owner`]: member('Alex Morgan', { title: 'Principal' }),
    [`${MATTERS}/m1`]: matter(),
    [`${MATTERS}/m2`]: matter({ number: 'HV-2026-0002', privileged: true }),
    [`${MATTERS}/m3`]: matter({ number: 'HV-2026-0003', status: 'archived' }),
    [`${TEMPLATES}/dt-1`]: template(),
    [`${TEMPLATES}/dt-2`]: template({ name: 'Draft letter', published: false, publishedVersion: undefined }),
    [`${TEMPLATES}/dt-3`]: template({ name: 'Old letter', deletedAt: at, deletedBy: 'user-owner' }),
    ...contacts,
    ...parties,
  });
  const files = new MemoryFiles('demo-materia.appspot.com');
  files.put(`${TEMPLATES}/dt-1/v1.docx`, letter);
  files.put(`${TEMPLATES}/dt-1/v2.docx`, docxWith(['Version two for {client.fullName}']));
  const clock = new FakeClock(new Date('2026-10-05T23:00:00.000Z'));
  const tasks = new FakeTaskQueue();
  const ports = fakePorts({ tasks });
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = <T>(def: unknown, data: Data, role: Role = 'owner') =>
    runCallable(
      def as CallableDefinition<never, T>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(),
    );
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const audits = () =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, data]) => data);
  return { ...store, files, clock, tasks, call, doc, audits };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

const upload = (data: Buffer, fileName = 'Engagement letter.docx') => ({
  fileName,
  contentBase64: data.toString('base64'),
});

interface Generated {
  documentId: string;
  name: string;
  missing: string[];
  warnings: string[];
}

describe('docs-generate', () => {
  const def = generateDefinition(() => files);
  let files: MemoryFiles;

  const setup = () => {
    const w = world();
    files = w.files;
    return w;
  };

  it('generates a letter from a system template and saves it to the matter', async () => {
    const w = setup();
    const requestId = randomUUID();
    const result = await w.call<Generated>(
      def,
      {
        requestId,
        templateId: 'system-letter',
        matterId: 'm1',
        data: { body: 'Thank you for your **instructions**.' },
      },
      'lawyer',
    );
    const docId = generatedDocumentId(ORG, requestId);
    expect(result).toEqual({
      documentId: docId,
      name: 'Letter to client 6 October 2026.docx',
      missing: [],
      warnings: [],
    });

    const path = `${MATTERS}/m1/documents/${docId}`;
    const record = w.doc(path) as Data & { storagePath: string; sizeBytes: number };
    expect(record).toMatchObject({
      name: 'Letter to client 6 October 2026.docx',
      category: 'correspondence',
      source: 'generated',
      privileged: false,
      mime: DOCX_MIME,
      version: 1,
      scan: { status: 'clean' },
      ingest: { status: 'pending' },
      generatedFrom: { templateId: 'system-letter', version: 1 },
      createdBy: 'user-lawyer',
    });
    const file = await w.files.read(record.storagePath);
    expect(file?.length).toBe(record.sizeBytes);
    const text = docxText(file as Buffer);
    expect(text).toContain('Dear Catherine');
    expect(text).toContain('Thank you for your instructions.');
    expect(text).toContain('Jordan Price');
    expect(docxText(file as Buffer, 'word/header1.xml')).toContain('Harbour & Vine Legal');

    expect(w.tasks.queued).toEqual([
      {
        queue: 'documents-render',
        payload: { orgId: ORG, matterId: 'm1', docId, version: 1 },
        options: { dedupeKey: `render#${ORG}#m1#${docId}#1` },
      },
    ]);
    expect(w.audits()).toEqual([
      expect.objectContaining({ action: 'document.generated', actor: { uid: 'user-lawyer' } }),
    ]);
  });

  it('files a file note and a costs disclosure under their tags', async () => {
    const w = setup();
    const note = await w.call<Generated>(def, { templateId: 'system-file-note', matterId: 'm1' }, 'paralegal');
    const disclosure = await w.call<Generated>(def, { templateId: 'system-costs-disclosure', matterId: 'm1' });
    expect(w.doc(`${MATTERS}/m1/documents/${note.documentId}`)).toMatchObject({
      category: 'other',
      tags: ['file-note'],
    });
    expect(w.doc(`${MATTERS}/m1/documents/${disclosure.documentId}`)).toMatchObject({
      category: 'correspondence',
      tags: ['costs-disclosure'],
    });
    const text = docxText((await w.files.read(`${MATTERS}/m1/documents/${note.documentId}/v1`)) as Buffer);
    expect(text).toContain('Daniel Kim');
  });

  it('uses the published version of an org template, and names the document as asked', async () => {
    const w = setup();
    const result = await w.call<Generated>(
      def,
      { templateId: 'dt-1', matterId: 'm1', name: 'Engagement: Doyle/estate' },
      'lawyer',
    );
    expect(result.name).toBe('Engagement Doyle estate.docx');
    expect(w.doc(`${MATTERS}/m1/documents/${result.documentId}`)).toMatchObject({
      generatedFrom: { templateId: 'dt-1', version: 1 },
    });
    const text = docxText((await w.files.read(`${MATTERS}/m1/documents/${result.documentId}/v1`)) as Buffer);
    expect(text).toContain('Dear Catherine');
    expect(text).not.toContain('Version two');
  });

  it('lists missing fields and prints a marker for each', async () => {
    const w = setup();
    w.docs.set(`orgs/${ORG}/settings/letterhead`, { ...meta, phone: '(03) 5200 0000' });
    const result = await w.call<Generated>(def, { templateId: 'system-letter', matterId: 'm1' }, 'lawyer');
    expect(result.missing).toEqual(['firm.addressLine']);
    const header = docxText(
      (await w.files.read(`${MATTERS}/m1/documents/${result.documentId}/v1`)) as Buffer,
      'word/header1.xml',
    );
    expect(header).toContain('[[missing: firm.addressLine]]');
  });

  it('refuses an unpublished, deleted or unknown template', async () => {
    const w = setup();
    expect(await failure(w.call(def, { templateId: 'dt-2', matterId: 'm1' }, 'lawyer'))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'template_unpublished' },
    });
    expect(await failure(w.call(def, { templateId: 'dt-3', matterId: 'm1' }, 'lawyer'))).toMatchObject({
      code: 'not-found',
    });
    expect(await failure(w.call(def, { templateId: 'dt-404', matterId: 'm1' }, 'lawyer'))).toMatchObject({
      code: 'not-found',
    });
    expect(await failure(w.call(def, { templateId: 'system-nope', matterId: 'm1' }, 'lawyer'))).toMatchObject({
      code: 'not-found',
    });
    expect(w.tasks.queued).toEqual([]);
  });

  it('marks a document on a privileged matter privileged, and hides that matter from a paralegal', async () => {
    const w = setup();
    const result = await w.call<Generated>(def, { templateId: 'system-letter', matterId: 'm2' }, 'lawyer');
    expect(w.doc(`${MATTERS}/m2/documents/${result.documentId}`)).toMatchObject({ privileged: true });
    expect(await failure(w.call(def, { templateId: 'system-letter', matterId: 'm2' }, 'paralegal'))).toMatchObject({
      code: 'not-found',
    });
    expect(
      await failure(w.call(def, { templateId: 'system-letter', matterId: 'm1', privileged: true }, 'paralegal')),
    ).toMatchObject({ code: 'permission-denied', details: { reason: 'privileged_not_allowed' } });
  });

  it('refuses an archived matter and a read-only member', async () => {
    const w = setup();
    expect(await failure(w.call(def, { templateId: 'system-letter', matterId: 'm3' }, 'lawyer'))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'matter_archived' },
    });
    expect(await failure(w.call(def, { templateId: 'system-letter', matterId: 'm1' }, 'readonly'))).toMatchObject({
      code: 'permission-denied',
    });
  });

  it('saves one document when the same request is retried', async () => {
    const w = setup();
    const requestId = randomUUID();
    const first = await w.call<Generated>(def, { requestId, templateId: 'system-letter', matterId: 'm1' }, 'lawyer');
    const second = await w.call<Generated>(def, { requestId, templateId: 'system-letter', matterId: 'm1' }, 'lawyer');
    expect(second.documentId).toBe(first.documentId);
    expect([...w.docs.keys()].filter((path) => path.startsWith(`${MATTERS}/m1/documents/`))).toHaveLength(1);
  });

  it('refuses a body that is too long', async () => {
    const w = setup();
    expect(
      await failure(
        w.call(def, { templateId: 'system-letter', matterId: 'm1', data: { body: 'x'.repeat(50_001) } }, 'lawyer'),
      ),
    ).toMatchObject({ code: 'invalid-argument' });
  });
});

interface Saved {
  templateId: string;
  version: number;
  fields: string[];
  warnings: string[];
}

describe('docs-saveTemplate', () => {
  let files: MemoryFiles;
  const def = saveTemplateDefinition(() => files);
  const setup = () => {
    const w = world();
    files = w.files;
    return w;
  };

  it('saves a new template as an unpublished version 1, with its fields', async () => {
    const w = setup();
    const data = docxWith(['Dear {client.firstName}', '{#executors}{name}{/executors}', 'Date: {today|date}']);
    const result = await w.call<Saved>(def, { name: 'Executor letter', kind: 'letter', file: upload(data) });
    expect(result).toEqual({
      templateId: expect.stringMatching(/^dt-[0-9a-f]{24}$/),
      version: 1,
      fields: ['client.firstName', 'executors', 'executors.name', 'today'],
      warnings: [],
    });
    const stored = w.doc(`${TEMPLATES}/${result.templateId}`);
    expect(stored).toMatchObject({
      name: 'Executor letter',
      kind: 'letter',
      matterTypes: [],
      published: false,
      version: 1,
      storagePath: `${TEMPLATES}/${result.templateId}/v1.docx`,
      versions: [expect.objectContaining({ version: 1, fileName: 'Engagement letter.docx', sizeBytes: data.length })],
      createdBy: 'user-owner',
      deletedAt: null,
    });
    expect(await w.files.read(`${TEMPLATES}/${result.templateId}/v1.docx`)).toEqual(data);
  });

  it('names a bad tag and saves nothing', async () => {
    const w = setup();
    const data = docxWith(['Dear {client.fullname}', 'Today {today|shout}']);
    const result = await failure(w.call(def, { name: 'Broken', kind: 'letter', file: upload(data) }));
    expect(result.code).toBe('invalid-argument');
    expect(result.details['reason']).toBe('template_invalid');
    const messages = (data: Data) => (data['problems'] as { message: string }[]).map((p) => p.message);
    expect(messages(result.details)).toEqual([
      '{client.fullname} isn’t a field. Did you mean {client.fullName}?',
      '{today|shout} uses “shout”, which isn’t a formatter. Use date, money, upper, lower.',
    ]);
    const unclosed = await failure(
      w.call(def, { name: 'Unclosed', kind: 'letter', file: upload(docxWith(['{#executors}{name}'])) }),
    );
    expect(messages(unclosed.details)).toEqual(['{#executors} is never closed. Add {/executors} where it should end.']);
    expect([...w.files.objects.keys()].filter((path) => !path.includes('/dt-1/'))).toEqual([]);
  });

  it('refuses a file that isn’t a .docx, or is empty', async () => {
    const w = setup();
    expect(
      await failure(
        w.call(def, { name: 'Not a docx', kind: 'letter', file: upload(Buffer.from('%PDF-1.7 fictional')) }),
      ),
    ).toMatchObject({ code: 'invalid-argument', details: { reason: 'template_invalid' } });
    expect(await failure(w.call(def, { name: 'Empty', kind: 'letter', file: upload(Buffer.alloc(0)) }))).toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('refuses an infected file and says when the scanner is unavailable', async () => {
    const w = setup();
    const infected = docxWith(['Dear {client.firstName}'], { 'word/media/payload.bin': EICAR_TEST_STRING });
    expect(await failure(w.call(def, { name: 'Infected', kind: 'letter', file: upload(infected) }))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'infected' },
    });
    const slow = docxWith(['Dear {client.firstName}'], { 'word/media/slow.bin': FAKE_SCANNER_TIMEOUT_MARKER });
    expect(await failure(w.call(def, { name: 'Slow', kind: 'letter', file: upload(slow) }))).toMatchObject({
      code: 'unavailable',
    });
    expect([...w.files.objects.keys()].filter((path) => !path.includes('/dt-1/'))).toEqual([]);
  });

  it('adds a new version and keeps the published one', async () => {
    const w = setup();
    const data = docxWith(['Hello {client.fullName}, about {matter.number}']);
    const result = await w.call<Saved>(def, {
      templateId: 'dt-1',
      name: 'Engagement letter',
      kind: 'letter',
      file: upload(data),
    });
    expect(result).toMatchObject({ templateId: 'dt-1', version: 3, fields: ['client.fullName', 'matter.number'] });
    expect(w.doc(`${TEMPLATES}/dt-1`)).toMatchObject({
      version: 3,
      storagePath: `${TEMPLATES}/dt-1/v3.docx`,
      published: true,
      publishedVersion: 1,
      versions: [
        expect.objectContaining({ version: 1 }),
        expect.objectContaining({ version: 2 }),
        expect.objectContaining({ version: 3 }),
      ],
    });
  });

  it('renames a template and sets what it replaces without a new file', async () => {
    const w = setup();
    const result = await w.call<Saved>(def, {
      templateId: 'dt-1',
      name: 'Client letter',
      kind: 'letter',
      matterTypes: ['probate'],
      replaces: 'system-letter',
    });
    expect(result).toMatchObject({
      templateId: 'dt-1',
      version: 2,
      warnings: ['The PDF preview uses a similar font in place of Aptos.'],
    });
    expect(w.doc(`${TEMPLATES}/dt-1`)).toMatchObject({
      name: 'Client letter',
      matterTypes: ['probate'],
      replaces: 'system-letter',
      version: 2,
    });
    await w.call(def, { templateId: 'dt-1', name: 'Client letter', kind: 'letter', replaces: null });
    expect(w.doc(`${TEMPLATES}/dt-1`)).not.toHaveProperty('replaces');
  });

  it('needs a file for a new template, and an existing template to update', async () => {
    const w = setup();
    expect(await failure(w.call(def, { name: 'No file', kind: 'letter' }))).toMatchObject({ code: 'invalid-argument' });
    expect(await failure(w.call(def, { templateId: 'dt-404', name: 'Missing', kind: 'letter' }))).toMatchObject({
      code: 'not-found',
    });
    expect(await failure(w.call(def, { templateId: 'dt-3', name: 'Deleted', kind: 'letter' }))).toMatchObject({
      code: 'not-found',
    });
  });

  it('stops at the version limit', async () => {
    const w = setup();
    const versions = Array.from({ length: 50 }, (_, i) => templateVersion(i + 1, { sha256: 'a'.repeat(64) }));
    w.docs.set(`${TEMPLATES}/dt-1`, template({ versions, version: 50 }));
    expect(
      await failure(
        w.call(def, {
          templateId: 'dt-1',
          name: 'Engagement letter',
          kind: 'letter',
          file: upload(docxWith(['{today}'])),
        }),
      ),
    ).toMatchObject({ code: 'failed-precondition', details: { reason: 'version_limit' } });
  });

  it('is for owners and admins', async () => {
    const w = setup();
    const data = docxWith(['{today}']);
    expect(await failure(w.call(def, { name: 'Nope', kind: 'letter', file: upload(data) }, 'lawyer'))).toMatchObject({
      code: 'permission-denied',
    });
    await expect(w.call(def, { name: 'Yes', kind: 'file_note', file: upload(data) }, 'admin')).resolves.toMatchObject({
      version: 1,
    });
  });
});

describe('docs-publishTemplate, unpublishTemplate and deleteTemplate', () => {
  it('publishes a version and audits it', async () => {
    const w = world();
    await w.call(publishTemplateDefinition, { templateId: 'dt-1', version: 2 });
    expect(w.doc(`${TEMPLATES}/dt-1`)).toMatchObject({
      published: true,
      publishedVersion: 2,
      publishedBy: 'user-owner',
    });
    expect(w.audits()).toEqual([
      expect.objectContaining({ action: 'doc_template.published', actor: { uid: 'user-owner' } }),
    ]);
    expect(await failure(w.call(publishTemplateDefinition, { templateId: 'dt-1', version: 9 }))).toMatchObject({
      code: 'not-found',
    });
  });

  it('unpublishes and deletes, keeping the files', async () => {
    const w = world();
    await w.call(unpublishTemplateDefinition, { templateId: 'dt-1' });
    expect(w.doc(`${TEMPLATES}/dt-1`)).toMatchObject({ published: false, publishedVersion: 1 });
    await w.call(deleteTemplateDefinition, { templateId: 'dt-1' });
    expect(w.doc(`${TEMPLATES}/dt-1`)).toMatchObject({ published: false, deletedBy: 'user-owner' });
    expect(w.doc(`${TEMPLATES}/dt-1`)?.['deletedAt']).toBeTruthy();
    expect(await w.files.read(`${TEMPLATES}/dt-1/v1.docx`)).toBeTruthy();
    expect(await failure(w.call(publishTemplateDefinition, { templateId: 'dt-1', version: 1 }))).toMatchObject({
      code: 'not-found',
    });
    expect(await failure(w.call(deleteTemplateDefinition, { templateId: 'dt-404' }))).toMatchObject({
      code: 'not-found',
    });
  });

  it('is for owners and admins', async () => {
    const w = world();
    expect(
      await failure(w.call(publishTemplateDefinition, { templateId: 'dt-2', version: 1 }, 'lawyer')),
    ).toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('docs-previewTemplate', () => {
  let files: MemoryFiles;
  const def = previewTemplateDefinition(() => files);

  it('test-merges the latest version against a matter, as HTML and a .docx', async () => {
    const w = world();
    files = w.files;
    const result = await w.call<{
      html: string;
      missing: string[];
      warnings: string[];
      fileName: string;
      contentBase64: string;
    }>(def, {
      templateId: 'dt-1',
      matterId: 'm1',
    });
    expect(result.html).toContain('Version two for Catherine Doyle');
    expect(result).toMatchObject({
      missing: [],
      warnings: ['The PDF preview uses a similar font in place of Aptos.'],
      fileName: 'Engagement letter (test merge).docx',
    });
    expect(docxText(Buffer.from(result.contentBase64, 'base64'))).toBe('Version two for Catherine Doyle');
    // A test merge saves nothing.
    expect([...w.docs.keys()].some((path) => path.includes('/documents/'))).toBe(false);
  });

  it('test-merges a chosen version and a system template, with supplied data', async () => {
    const w = world();
    files = w.files;
    const v1 = await w.call<{ html: string }>(def, { templateId: 'dt-1', version: 1, matterId: 'm1' });
    expect(v1.html).toContain('Dear Catherine');
    const system = await w.call<{ html: string; missing: string[] }>(def, {
      templateId: 'system-letterhead',
      matterId: 'm1',
      data: { body: '## Next steps\n\n- Locate the will', recipient: { name: 'Thomas Doyle' } },
    });
    expect(system.html).toContain('Locate the will');
    expect(system.html).toContain('Thomas Doyle');
    expect(system.missing).toEqual([]);
  });

  it('can’t test-merge against a privileged matter without access, but can on an archived one', async () => {
    const w = world();
    files = w.files;
    await expect(w.call(def, { templateId: 'system-letter', matterId: 'm3' })).resolves.toBeTruthy();
    w.docs.set(`orgs/${ORG}/members/user-admin`, { ...meta, status: 'active', displayName: 'Sam Lee' });
    await expect(w.call(def, { templateId: 'system-letter', matterId: 'm2' }, 'admin')).resolves.toBeTruthy();
    expect(await failure(w.call(def, { templateId: 'system-letter', matterId: 'm404' }))).toMatchObject({
      code: 'not-found',
    });
  });
});

describe('docs-downloadTemplate', () => {
  let files: MemoryFiles;
  const def = downloadTemplateDefinition(() => files);

  it('downloads a system template and a version of an org template', async () => {
    const w = world();
    files = w.files;
    const system = await w.call<{ fileName: string; contentBase64: string }>(def, { templateId: 'system-file-note' });
    expect(system.fileName).toBe('File note.docx');
    expect(Buffer.from(system.contentBase64, 'base64')).toEqual(systemTemplateDocx('system-file-note').data);
    const org = await w.call<{ fileName: string; contentBase64: string }>(def, { templateId: 'dt-1', version: 1 });
    expect(org.fileName).toBe('Engagement letter v1.docx');
    expect(Buffer.from(org.contentBase64, 'base64')).toEqual(letter);
    expect(await failure(w.call(def, { templateId: 'system-letter', version: 2 }))).toMatchObject({
      code: 'not-found',
    });
  });
});

describe('docs-saveLetterhead', () => {
  it('saves the firm’s details, dropping blanks and keeping when it was created', async () => {
    const w = world();
    await w.call(saveLetterheadDefinition, {
      address: '1 Example Road\nGeelong VIC 3220',
      phone: '(03) 5200 0001',
      website: '',
    });
    const saved = w.doc(`orgs/${ORG}/settings/letterhead`);
    expect(saved).toMatchObject({
      address: '1 Example Road\nGeelong VIC 3220',
      phone: '(03) 5200 0001',
      updatedBy: 'user-owner',
    });
    expect(saved).not.toHaveProperty('website');
    expect(saved).not.toHaveProperty('email');
    expect((saved?.['createdAt'] as { toDate: () => Date }).toDate()).toEqual(at);
  });

  it('checks the details and is for owners and admins', async () => {
    const w = world();
    expect(await failure(w.call(saveLetterheadDefinition, { phone: 'x'.repeat(41) }))).toMatchObject({
      code: 'invalid-argument',
    });
    expect(await failure(w.call(saveLetterheadDefinition, { phone: '(03) 5200 0001' }, 'lawyer'))).toMatchObject({
      code: 'permission-denied',
    });
  });
});
