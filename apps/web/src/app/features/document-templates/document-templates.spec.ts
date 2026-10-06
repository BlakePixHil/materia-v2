import { ADMIN, cleanUpOverlays, LAWYER, meta, openMatter, ORG, PARALEGAL } from '../matter-detail/testing';

/**
 * Document templates and docx merge (INT-06): Settings → Document templates (letterhead details,
 * upload with tag checks, publish, test merge, the Template fields help) and New from template on
 * a matter's Documents tab. A fictional practice only.
 */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const TEMPLATES = `orgs/${ORG}/docTemplates`;
const SETTINGS = '/settings/document-templates';

const version = (n: number, extra: Seed = {}): Seed => ({
  version: n,
  storagePath: `${TEMPLATES}/dt-engagement/v${n}.docx`,
  fileName: `Engagement letter v${n}.docx`,
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  fields: ['client.firstName', 'body'],
  warnings: [],
  uploadedAt: new Date('2026-09-20T00:00:00Z'),
  uploadedBy: 'user-priya',
  ...extra,
});

const template = (extra: Seed = {}): Seed => ({
  name: 'Engagement letter',
  kind: 'letter',
  matterTypes: [],
  storagePath: `${TEMPLATES}/dt-engagement/v2.docx`,
  fields: ['client.firstName', 'body'],
  version: 2,
  versions: [version(1), version(2, { warnings: ['The PDF preview uses a similar font in place of Aptos.'] })],
  published: true,
  publishedVersion: 1,
  replaces: 'system-letter',
  deletedAt: null,
  ...meta,
  ...extra,
});

function templates(fs: Page['firestore']): void {
  fs.set(`${TEMPLATES}/dt-engagement`, template());
  fs.set(
    `${TEMPLATES}/dt-draft`,
    template({ name: 'Draft letter', published: false, publishedVersion: undefined, replaces: undefined }),
  );
  fs.set(`${TEMPLATES}/dt-will`, template({ name: 'Will instructions', matterTypes: ['will'], replaces: undefined }));
  fs.set(`orgs/${ORG}/settings/letterhead`, {
    address: 'Level 2, 10 Example Street\nGeelong VIC 3220',
    phone: '(03) 5200 0000',
    ...meta,
  });
}

/** Waits for a lazily loaded dialog. */
async function opened(page: Page): Promise<HTMLElement> {
  for (let i = 0; i < 30 && !page.dialog(); i++) await page.stable(10);
  await page.stable();
  return page.dialog() as HTMLElement;
}

const row = (page: Page, id: string) => page.body.querySelector<HTMLElement>(`[data-template="${id}"]`);

/** The template choices in New from template. */
const choices = (page: Page, dialog: HTMLElement) =>
  [...dialog.querySelectorAll<HTMLElement>('mt-radio-group label')].map((label) => page.text(label));

/** Picks the template choice whose label starts with `name`. */
async function pick(page: Page, dialog: HTMLElement, name: string): Promise<void> {
  const label = [...dialog.querySelectorAll<HTMLElement>('mt-radio-group label')].find((node) =>
    page.text(node).startsWith(name),
  );
  label?.querySelector<HTMLElement>('button')?.click();
  await page.stable();
}

describe('Settings → Document templates', () => {
  it('is in the sidebar for owners and admins', async () => {
    const page = await openMatter('/settings/practice', { session: ADMIN });
    expect(page.buttons('Document templates').length).toBeGreaterThan(0);
  });

  it('isn’t in the sidebar for lawyers', async () => {
    const page = await openMatter('/settings/team', { session: LAWYER });
    expect(page.buttons('Document templates')).toHaveLength(0);
  });

  it('lists the firm’s templates with their state, and the built-in ones', async () => {
    const page = await openMatter(SETTINGS, { session: ADMIN, configure: templates });
    expect(page.text(page.body.querySelector('h1'))).toBe('Document templates');
    const engagement = row(page, 'dt-engagement');
    expect(page.text(engagement)).toContain(
      'Letter · v2 · 2 fields · offered on every matter · replaces Letter to client',
    );
    expect(page.text(engagement)).toContain('Published v1');
    expect(page.buttons('Publish v2 of Engagement letter')).toHaveLength(1);
    expect(page.text(row(page, 'dt-draft'))).toContain('Draft');
    expect(page.text(row(page, 'dt-will'))).toContain('offered on Will');
    expect(page.text()).toContain('Engagement letter: The PDF preview uses a similar font in place of Aptos.');
    // The built-in letter is replaced while Engagement letter is published.
    expect(page.text(row(page, 'system-letter'))).toContain('Replaced by Engagement letter');
    expect(page.text(row(page, 'system-file-note'))).toContain('Built in');
    expect(page.text()).toContain('The costs disclosure is an illustrative placeholder');
  });

  it('publishes the latest version', async () => {
    const page = await openMatter(SETTINGS, {
      session: ADMIN,
      configure: templates,
      callables: { 'docs-publishTemplate': () => ({ templateId: 'dt-engagement' }) },
    });
    await page.click('Publish v2 of Engagement letter');
    expect(page.calls('docs-publishTemplate')).toEqual([
      expect.objectContaining({ templateId: 'dt-engagement', version: 2 }),
    ]);
    expect(page.text()).toContain('Engagement letter v2 published');
  });

  it('saves the letterhead details, trimmed, without blanks', async () => {
    const page = await openMatter(SETTINGS, {
      session: ADMIN,
      configure: templates,
      callables: { 'docs-saveLetterhead': () => ({ saved: true }) },
    });
    const form = page.body.querySelector<HTMLElement>('form[aria-label="Letterhead details"]') as HTMLElement;
    expect(form.querySelector<HTMLInputElement>('input[name="phone"], mt-text-field input')?.value).toBe(
      '(03) 5200 0000',
    );
    await page.fill('Email', '  reception@harbourvine.example ', form);
    await page.fill(
      'Footer line',
      'Liability limited by a scheme approved under professional standards legislation.',
      form,
    );
    await page.click('Save letterhead', form);
    expect(page.calls('docs-saveLetterhead')).toEqual([
      expect.objectContaining({
        address: 'Level 2, 10 Example Street\nGeelong VIC 3220',
        phone: '(03) 5200 0000',
        email: 'reception@harbourvine.example',
        footer: 'Liability limited by a scheme approved under professional standards legislation.',
      }),
    ]);
    expect(page.calls('docs-saveLetterhead')[0]).not.toHaveProperty('website');
    expect(page.text()).toContain('Letterhead details saved');
  });

  it('uploads a template, and lists each tag the server refused', async () => {
    let attempt = 0;
    const page = await openMatter(SETTINGS, {
      session: ADMIN,
      configure: templates,
      callables: {
        'docs-saveTemplate': () => {
          attempt += 1;
          if (attempt === 1) {
            throw Object.assign(new Error('The template has tags that need fixing'), {
              code: 'functions/invalid-argument',
              details: {
                code: 'INVALID_ARGUMENT',
                reason: 'template_invalid',
                problems: [
                  {
                    tag: '{client.fullname}',
                    code: 'unknown_field',
                    message: '{client.fullname} isn’t a field. Did you mean {client.fullName}?',
                  },
                ],
              },
            });
          }
          return { templateId: 'dt-new', version: 1, fields: ['client.fullName'], warnings: [] };
        },
      },
    });
    await page.click('Upload template');
    const dialog = await opened(page);
    const input = dialog.querySelector<HTMLInputElement>('[data-testid="template-file-input"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['PK fictional docx'], 'Client care letter.docx')],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await page.stable();
    expect(page.text(dialog.querySelector('[data-testid="template-file-name"]'))).toBe('Client care letter.docx');
    await page.submit(dialog);
    for (let i = 0; i < 20 && !page.calls('docs-saveTemplate').length; i++) await page.stable(10);
    await page.stable();
    expect(page.calls('docs-saveTemplate')[0]).toMatchObject({
      name: 'Client care letter',
      kind: 'letter',
      matterTypes: [],
      file: { fileName: 'Client care letter.docx', contentBase64: btoa('PK fictional docx') },
    });
    expect(page.text(dialog)).toContain('Some tags in the template need fixing.');
    expect(page.text(dialog.querySelector('[data-testid="template-problems"]'))).toBe(
      '{client.fullname} isn’t a field. Did you mean {client.fullName}?',
    );

    await page.submit(dialog);
    for (let i = 0; i < 20 && page.dialog(); i++) await page.stable(10);
    expect(page.dialog()).toBeNull();
    expect(page.text()).toContain('Client care letter v1 uploaded');
  });

  it('refuses a file that isn’t a .docx before sending it', async () => {
    const page = await openMatter(SETTINGS, { session: ADMIN, configure: templates });
    await page.click('Upload template');
    const dialog = await opened(page);
    const input = dialog.querySelector<HTMLInputElement>('[data-testid="template-file-input"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['%PDF'], 'Letter.pdf')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await page.stable();
    expect(page.text(dialog)).toContain('Choose a Word .docx file.');
    await page.submit(dialog);
    expect(page.calls('docs-saveTemplate')).toHaveLength(0);
  });

  it('test-merges a template against a chosen matter', async () => {
    const page = await openMatter(SETTINGS, {
      session: ADMIN,
      // Matter search lists recently active matters first.
      matter: { lastActivityAt: new Date('2026-10-03T00:00:00Z') },
      configure: templates,
      callables: {
        'docs-previewTemplate': () => ({
          html: '<p>Dear Avery,</p><p>Thank you for your instructions.</p>',
          missing: ['client.address'],
          warnings: [],
          fileName: 'Letter to client (test merge).docx',
          contentBase64: btoa('PK merged'),
        }),
      },
    });
    await page.click('Test merge Letter to client');
    const dialog = await opened(page);
    await page.fill('Matter', 'Whitfield', dialog);
    for (let i = 0; i < 30 && !page.buttons('M-2026-0142', dialog).length; i++) await page.stable(20);
    await page.click('M-2026-0142', dialog);
    expect(page.text(dialog.querySelector('[data-testid="test-merge-matter"]'))).toBe(
      'M-2026-0142 · Estate of Margaret Whitfield',
    );
    await page.submit(dialog);
    expect(page.calls('docs-previewTemplate')).toEqual([
      expect.objectContaining({
        templateId: 'system-letter',
        matterId: 'm-whitfield',
        data: { body: expect.stringContaining('Thank you for your instructions.') },
      }),
    ]);
    expect(page.text(dialog.querySelector('[data-testid="test-merge-missing"]'))).toBe(
      '1 field had no value: client.address. Each shows as [[missing: …]] in the document.',
    );
    expect(page.text(dialog.querySelector('.preview'))).toBe('Dear Avery,Thank you for your instructions.');
    expect(page.buttons('Download .docx', dialog)).toHaveLength(1);
  });

  it('lists every tag in the Template fields help', async () => {
    const page = await openMatter(SETTINGS, { session: ADMIN, configure: templates });
    const fields = page.body.querySelector<HTMLElement>('mt-template-fields') as HTMLElement;
    expect(page.text(fields.querySelector('[data-testid="template-field-rules"]'))).toContain(
      '{deceased.dateOfDeath|date} (3 October 2026)',
    );
    expect(page.text(fields.querySelector('[data-section="client"]'))).toContain('{client.fullName}');
    expect(page.text(fields.querySelector('[data-section="parties"]'))).toContain(
      '{#beneficiaries}{name}{/beneficiaries}',
    );
    expect(page.text(fields.querySelector('[data-section="supplied"]'))).toContain('{@body}');
  });
});

describe('New from template (matter Documents tab)', () => {
  const generated = (data: Seed, fs: Page['firestore']) => {
    const documentId = 'gen-1';
    fs.set(`orgs/${ORG}/matters/m-whitfield/documents/${documentId}`, {
      orgId: ORG,
      matterId: 'm-whitfield',
      name: 'Letter to client 4 October 2026.docx',
      category: 'correspondence',
      privileged: false,
      tags: [],
      storagePath: `orgs/${ORG}/matters/m-whitfield/documents/${documentId}/v1`,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 12_000,
      sha256: 'b'.repeat(64),
      version: 1,
      versionSeq: 1,
      versions: [],
      scan: { status: 'clean' },
      ingest: { status: 'pending' },
      source: 'generated',
      encrypted: false,
      accessRestricted: false,
      deletedAt: null,
      ...meta,
    });
    return {
      documentId,
      name: 'Letter to client 4 October 2026.docx',
      missing: data['templateId'] ? ['client.address'] : [],
      warnings: [],
    };
  };

  it('offers the published templates for the matter type and the built-in ones they don’t replace', async () => {
    const page = await openMatter('/matters/m-whitfield/documents', { configure: templates });
    await page.click('New from template');
    const dialog = await opened(page);
    expect(choices(page, dialog)).toEqual([
      'Engagement letterLetter · your template',
      'LetterheadLetterhead · built in',
      'File noteFile note · built in',
      'Costs disclosure (placeholder)Costs disclosure · built in',
      'Costs disclosure, short form (placeholder)Costs disclosure · built in',
    ]);
  });

  it('generates a document with a body and reports missing fields', async () => {
    const page = await openMatter('/matters/m-whitfield/documents', {
      configure: templates,
      callables: { 'docs-generate': generated },
    });
    await page.click('New from template');
    const dialog = await opened(page);
    await pick(page, dialog, 'File note');
    await page.fill('Body', 'Attended **Avery** by phone.', dialog);
    await page.submit(dialog);
    for (let i = 0; i < 20 && page.dialog(); i++) await page.stable(10);
    expect(page.calls('docs-generate')).toEqual([
      expect.objectContaining({
        templateId: 'system-file-note',
        matterId: 'm-whitfield',
        data: { body: 'Attended **Avery** by phone.' },
      }),
    ]);
    expect(page.text()).toContain('Letter to client 4 October 2026.docx added');
    expect(page.text()).toContain('1 field had no value: client.address.');
  });

  it('isn’t offered to a read-only member', async () => {
    const page = await openMatter('/matters/m-whitfield/documents', {
      session: (await import('../matter-detail/testing')).READONLY,
      configure: templates,
    });
    expect(page.buttons('New from template')).toHaveLength(0);
  });

  it('is offered to a paralegal, without the privileged option', async () => {
    const page = await openMatter('/matters/m-whitfield/documents', { session: PARALEGAL, configure: templates });
    await page.click('New from template');
    const dialog = await opened(page);
    expect(page.text(dialog)).not.toContain('Privileged');
  });
});
