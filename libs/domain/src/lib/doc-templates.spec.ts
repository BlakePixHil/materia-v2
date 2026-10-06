import {
  applyMergeFilter,
  buildMergeData,
  checkMergeTags,
  displayTag,
  DOC_MERGE_FIELD_SECTIONS,
  DOC_TEMPLATE_KINDS,
  DOC_TEMPLATE_KIND_LABELS,
  docTemplateCategory,
  docTemplateTags,
  formatMergeValue,
  GenerateDocumentInput,
  isBlankValue,
  isSystemDocTemplateId,
  joinNames,
  LetterheadDoc,
  letterheadPath,
  missingMarker,
  offeredDocTemplates,
  parseMergeTag,
  personFields,
  resolveMergeTag,
  SaveDocTemplateInput,
  SYSTEM_DOC_TEMPLATES,
  systemDocTemplate,
  templateFields,
  templateInputs,
  valueAt,
  type MergeSources,
  type TemplateTag,
} from './doc-templates';
import { DocTemplate } from './schemas/org-records';
import { dateOnly } from './values/date-only';

/** Document templates and docx merge (INT-06). Every firm, person and matter is fictional. */

const tag = (value: string, kind: TemplateTag['kind'] = 'value', scope: string[] = []): TemplateTag => ({
  value,
  kind,
  scope,
});
const REQUEST = '0b8f5d64-9a4b-4d1e-8c55-0d7d0e3f5a11';

describe('kinds and system templates', () => {
  it('labels every kind and files it under a category', () => {
    expect(DOC_TEMPLATE_KINDS.every((kind) => DOC_TEMPLATE_KIND_LABELS[kind])).toBe(true);
    expect(docTemplateCategory('letter')).toBe('correspondence');
    expect(docTemplateCategory('file_note')).toBe('other');
    expect(docTemplateCategory('court_book_index')).toBe('court_document');
    expect(docTemplateTags('file_note')).toEqual(['file-note']);
    expect(docTemplateTags('costs_disclosure')).toEqual(['costs-disclosure']);
    expect(docTemplateTags('letter')).toEqual([]);
  });

  it('ships a letterhead and three samples', () => {
    expect(SYSTEM_DOC_TEMPLATES.map((t) => t.kind)).toEqual(['letterhead', 'letter', 'file_note', 'costs_disclosure']);
    expect(isSystemDocTemplateId('system-letter')).toBe(true);
    expect(isSystemDocTemplateId('dt-1')).toBe(false);
    expect(systemDocTemplate('system-file-note')?.name).toBe('File note');
    expect(systemDocTemplate('system-nope')).toBeUndefined();
  });

  it('asks for a body or a recipient when the template has those tags', () => {
    expect(templateInputs(['body', 'recipient.name', 'client.fullName'])).toEqual(['body', 'recipient']);
    expect(templateInputs(['recipient'])).toEqual(['recipient']);
    expect(templateInputs(['client.fullName'])).toEqual([]);
  });
});

describe('the merge-field catalogue', () => {
  const tags = DOC_MERGE_FIELD_SECTIONS.flatMap((section) => section.fields.map((field) => field.tag));

  it('has unique tags, each with a label and an example (blocks and lists aside)', () => {
    expect(tags.filter((t, i) => tags.indexOf(t) !== i)).toEqual([]);
    for (const field of DOC_MERGE_FIELD_SECTIONS.flatMap((section) => section.fields)) {
      expect(field.label).not.toBe('');
      if (field.type !== 'list' && field.type !== 'block') expect(field.example).not.toBe('');
    }
  });

  it('accepts every tag it lists, and every list’s item fields inside that list', () => {
    const all = DOC_MERGE_FIELD_SECTIONS.flatMap((section) =>
      section.fields.flatMap((field) =>
        field.type === 'list'
          ? [tag(field.tag, 'section'), ...(field.items ?? []).map((item) => tag(item.tag, 'value', [field.tag]))]
          : field.type === 'block'
            ? [tag(field.tag, 'block')]
            : [tag(field.tag)],
      ),
    );
    expect(checkMergeTags(all)).toEqual([]);
  });
});

describe('tags', () => {
  it('parses a path and its formatters', () => {
    expect(parseMergeTag('deceased.dateOfDeath | date')).toEqual({ path: 'deceased.dateOfDeath', filters: ['date'] });
    expect(parseMergeTag('client.fullName|upper|lower')).toEqual({
      path: 'client.fullName',
      filters: ['upper', 'lower'],
    });
  });

  it('resolves list items, group fields and groups where they stand', () => {
    expect(resolveMergeTag('fullName', ['executors'])).toMatchObject({
      path: 'executors.fullName',
      field: { label: 'Full name' },
    });
    expect(resolveMergeTag('name', ['beneficiaries'])).toMatchObject({ path: 'beneficiaries.name' });
    expect(resolveMergeTag('email', ['client'])).toMatchObject({ path: 'client.email' });
    expect(resolveMergeTag('name', ['recipient'])).toMatchObject({ path: 'recipient.name' });
    expect(resolveMergeTag('matter.number', ['executors'])).toMatchObject({ path: 'matter.number' });
    expect(resolveMergeTag('client')).toEqual({ path: 'client', group: true });
    expect(resolveMergeTag('nope')).toEqual({ path: 'nope' });
  });

  it('shows a tag as it was written', () => {
    expect(displayTag(tag('client.fullName'))).toBe('{client.fullName}');
    expect(displayTag(tag('executors', 'section'))).toBe('{#executors}');
    expect(displayTag(tag('body', 'block'))).toBe('{@body}');
  });

  it('names each problem’s tag', () => {
    expect(
      checkMergeTags([
        tag('client.fullname'),
        tag('fullname', 'value', ['executors']),
        tag('client.nickname'),
        tag('today|shout'),
        tag('client full name'),
        tag('client'),
        tag('recipient'),
        tag('executors'),
        tag('body'),
        tag('client.fullName', 'block'),
      ]).map((problem) => [problem.tag, problem.code, problem.message]),
    ).toEqual([
      ['{client.fullname}', 'unknown_field', '{client.fullname} isn’t a field. Did you mean {client.fullName}?'],
      ['{fullname}', 'unknown_field', '{fullname} isn’t a field. Did you mean {fullName}?'],
      [
        '{client.nickname}',
        'unknown_field',
        '{client.nickname} isn’t a field. See Template fields for the ones you can use.',
      ],
      [
        '{today|shout}',
        'unknown_filter',
        '{today|shout} uses “shout”, which isn’t a formatter. Use date, money, upper, lower.',
      ],
      [
        '{client full name}',
        'syntax',
        '{client full name} isn’t a field name. Use letters and dots, like {client.fullName}.',
      ],
      ['{client}', 'not_a_value', '{client} is a group of fields. Use one of them, like {client.fullName}.'],
      ['{recipient}', 'not_a_value', '{recipient} is a group of fields. Use one of them, like {recipient.name}.'],
      ['{executors}', 'not_a_list', '{executors} is a list. Write {#executors}{fullName}{/executors}.'],
      ['{body}', 'not_a_block', '{body} is a formatted block. Write {@body} on a paragraph of its own.'],
      [
        '{@client.fullName}',
        'not_a_block',
        '{@client.fullName}: only {@body} can be a formatted block. Use {client.fullName}.',
      ],
    ]);
  });

  it('accepts conditions on any field or group', () => {
    expect(checkMergeTags([tag('client.email', 'section'), tag('firm', 'section'), tag('body', 'block')])).toEqual([]);
  });

  it('lists the fields a template uses by their full paths', () => {
    expect(
      templateFields([
        tag('executors', 'section'),
        tag('fullName', 'value', ['executors']),
        tag('today|date'),
        tag('today'),
      ]),
    ).toEqual(['executors', 'executors.fullName', 'today']);
  });
});

describe('values and formatters', () => {
  it('reads dotted paths and knows a blank value', () => {
    expect(valueAt({ a: { b: 'c' } }, 'a.b')).toBe('c');
    expect(valueAt({ a: null }, 'a.b')).toBeUndefined();
    expect(valueAt({ a: {} }, 'a.toString')).toBeUndefined();
    expect([undefined, null, ' ', []].every(isBlankValue)).toBe(true);
    expect([0, 'x', ['x'], false].some(isBlankValue)).toBe(false);
  });

  it('formats dates, money and case', () => {
    expect(applyMergeFilter('2026-10-03', 'date')).toBe('3 October 2026');
    expect(applyMergeFilter('not a date', 'date')).toBe('not a date');
    expect(applyMergeFilter(123_456, 'money')).toBe('$1,234.56');
    expect(applyMergeFilter('x', 'money')).toBe('x');
    expect(applyMergeFilter('Doyle', 'upper')).toBe('DOYLE');
    expect(applyMergeFilter('Doyle', 'lower')).toBe('doyle');
    expect(applyMergeFilter(3, 'upper')).toBe(3);
    expect(applyMergeFilter(3, 'lower')).toBe(3);
  });

  it('formats date and money fields by default, then runs the tag’s formatters', () => {
    const date = { tag: 'today', label: 'Today', type: 'date' as const, example: '' };
    const money = { tag: 'fee.amount', label: 'Fee', type: 'money' as const, example: '' };
    expect(formatMergeValue('2026-10-03', date, [])).toBe('3 October 2026');
    expect(formatMergeValue('2026-10-03', date, ['upper'])).toBe('3 OCTOBER 2026');
    expect(formatMergeValue(440_000, money, [])).toBe('$4,400.00');
    expect(formatMergeValue(440_000, undefined, ['money'])).toBe('$4,400.00');
    expect(formatMergeValue('Text', undefined, ['nope'])).toBe('Text');
    expect(missingMarker('client.address')).toBe('[[missing: client.address]]');
  });
});

describe('merge data', () => {
  const address = (type: 'postal' | 'residential', line1: string) => ({
    type,
    line1,
    suburb: 'Geelong',
    state: 'VIC',
    postcode: '3220',
    country: 'AU' as const,
  });
  const sources = (overrides: Partial<MergeSources> = {}): MergeSources => ({
    org: { name: 'Harbour & Vine Legal', abn: '00000000001' },
    letterhead: { address: 'Level 2, 10 Example Street\n\nGeelong VIC 3220', phone: '(03) 5200 0000' },
    matter: {
      number: 'HV-2026-0001',
      title: 'Estate of Margaret Doyle',
      type: 'loa',
      jurisdiction: 'VIC',
      openedOn: dateOnly('2026-07-20'),
      externalRef: ' ',
      clientContactIds: ['c1', 'c-gone'],
      deceased: { contactId: 'c2', dateOfDeath: '2026-07-17', domicile: 'VIC', lastAddress: 'Geelong VIC' },
      testator: { contactId: 'c3' },
      fee: { arrangement: 'hourly', estimateLowCents: 400_000 },
      estate: { grantType: 'loa_with_will', grantNo: '2026/01234', grossValueCents: 100 },
      facts: { courtFileNo: 'S ECI 2026 01234' },
    },
    contacts: {
      c1: {
        kind: 'person',
        givenNames: 'Catherine Anne',
        familyName: 'Doyle',
        emails: [{ type: 'personal', address: 'catherine@example.com' }],
        addresses: [address('residential', '11 Example Street'), address('postal', 'PO Box 1')],
      },
      c2: { kind: 'person', givenNames: 'Margaret', familyName: 'Doyle', dateOfBirth: dateOnly('1944-03-02') },
      c3: { kind: 'organisation', orgName: 'Example Trustees Pty Ltd' },
      c4: { kind: 'person', givenNames: 'Peter', familyName: 'Hale', preferredName: 'Pete' },
    },
    parties: [
      { contactId: 'c1', role: 'executor' },
      { contactId: 'c4', role: 'executor' },
      { contactId: 'c4', role: 'beneficiary', share: ' One half ' },
      { contactId: 'c-gone', role: 'beneficiary' },
    ],
    lawyer: { displayName: 'Jordan Price', title: 'Senior Associate', defaultRateCents: 45_000 },
    today: dateOnly('2026-10-06'),
    ...overrides,
  });

  it('builds the matter, people, estate, fee and firm fields', () => {
    const data = buildMergeData(sources());
    expect(data['matter']).toEqual({
      number: 'HV-2026-0001',
      title: 'Estate of Margaret Doyle',
      type: 'Letters of administration',
      jurisdiction: 'VIC',
      openedOn: '2026-07-20',
      reference: undefined,
      courtFileNo: 'S ECI 2026 01234',
      willDate: undefined,
    });
    expect(data['client']).toMatchObject({
      fullName: 'Catherine Anne Doyle',
      firstName: 'Catherine',
      lastName: 'Doyle',
      email: 'catherine@example.com',
      address: 'PO Box 1\nGeelong VIC 3220',
      addressLine: 'PO Box 1, Geelong VIC 3220',
    });
    expect(data['deceased']).toMatchObject({
      fullName: 'Margaret Doyle',
      email: undefined,
      dateOfBirth: '1944-03-02',
      dateOfDeath: '2026-07-17',
      domicile: 'Victoria',
      lastAddress: 'Geelong VIC',
    });
    expect(data['testator']).toMatchObject({
      fullName: 'Example Trustees Pty Ltd',
      firstName: undefined,
      lastName: undefined,
    });
    expect(data['estate']).toMatchObject({
      grantType: 'Letters of administration with the will annexed',
      grossValue: 100,
    });
    expect(data['fee']).toMatchObject({ hourlyRate: 45_000, estimateLow: 400_000, amount: undefined });
    expect(data['firm']).toMatchObject({
      name: 'Harbour & Vine Legal',
      abn: '00 000 000 001',
      address: 'Level 2, 10 Example Street\nGeelong VIC 3220',
      addressLine: 'Level 2, 10 Example Street, Geelong VIC 3220',
      phone: '(03) 5200 0000',
      email: undefined,
    });
    expect(data['lawyer']).toEqual({ fullName: 'Jordan Price', title: 'Senior Associate', email: undefined });
    expect(data['author']).toBeUndefined();
    expect(data['today']).toBe('2026-10-06');
  });

  it('lists parties by role, in order, with their names joined', () => {
    const data = buildMergeData(sources());
    expect(data['executors']).toEqual([
      expect.objectContaining({ name: 'Catherine Anne Doyle', fullName: 'Catherine Anne Doyle', share: undefined }),
      expect.objectContaining({ name: 'Pete Hale', firstName: 'Pete', lastName: 'Hale' }),
    ]);
    expect(data['executorNames']).toBe('Catherine Anne Doyle and Pete Hale');
    expect(data['beneficiaries']).toEqual([expect.objectContaining({ fullName: 'Pete Hale', share: 'One half' })]);
    expect(data['witnesses']).toEqual([]);
    expect(data['witnessNames']).toBeUndefined();
    // No client party rows: the matter's clients are listed.
    expect(data['clients']).toEqual([expect.objectContaining({ name: 'Catherine Anne Doyle' })]);
    expect(data['clientNames']).toBe('Catherine Anne Doyle');
  });

  it('leaves out an hourly rate on a fixed fee unless the matter has its own', () => {
    const fixed = (fee: NonNullable<MergeSources['matter']['fee']>) =>
      buildMergeData(sources({ matter: { ...sources().matter, fee } }))['fee'] as Record<string, unknown>;
    expect(fixed({ arrangement: 'fixed', amountCents: 440_000 })).toMatchObject({
      arrangement: 'Fixed fee',
      hourlyRate: undefined,
    });
    expect(fixed({ arrangement: 'fixed', rateOverrideCents: 30_000 })['hourlyRate']).toBe(30_000);
    expect(fixed({})).toMatchObject({ arrangement: undefined, hourlyRate: 45_000 });
  });

  it('leaves out what the matter doesn’t have', () => {
    const data = buildMergeData(
      sources({
        org: { name: ' ' },
        matter: { number: 'HV-2', title: 'Will', type: 'will', jurisdiction: 'VIC', clientContactIds: [] },
        letterhead: {},
        parties: [],
      }),
    );
    expect(data['client']).toBeUndefined();
    expect(data['deceased']).toBeUndefined();
    expect(data['testator']).toBeUndefined();
    expect(data['firm']).toMatchObject({ name: undefined, abn: undefined, address: undefined });
    expect(data['clients']).toEqual([]);
  });

  it('joins names and reads a contact’s person fields', () => {
    expect(joinNames([])).toBeUndefined();
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(personFields(undefined)).toBeUndefined();
    expect(
      personFields({ kind: 'person', givenNames: 'Thomas', phones: [{ type: 'mobile', number: '+61400000001' }] }),
    ).toMatchObject({
      firstName: 'Thomas',
      phone: '0400 000 001',
      address: undefined,
    });
  });
});

describe('records and inputs', () => {
  it('keeps the letterhead details at settings/letterhead', () => {
    expect(letterheadPath('org-a')).toBe('orgs/org-a/settings/letterhead');
    expect(LetterheadDoc.schema.safeParse({ phone: 'x'.repeat(41) }).success).toBe(false);
  });

  it('checks a template record’s file path', () => {
    const version = {
      version: 1,
      storagePath: 'orgs/org-a/docTemplates/dt-1/v1.docx',
      fileName: 'Letter.docx',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      fields: [],
      uploadedAt: new Date(),
      uploadedBy: 'user-owner',
    };
    const base = {
      name: 'Letter',
      kind: 'letter',
      storagePath: version.storagePath,
      version: 1,
      versions: [version],
      deletedAt: null,
      createdAt: new Date(),
      createdBy: 'user-owner',
      updatedAt: new Date(),
      updatedBy: 'user-owner',
      schemaVersion: 1,
    };
    expect(DocTemplate.schema.parse(base)).toMatchObject({ published: false, matterTypes: [], fields: [] });
    expect(DocTemplate.schema.safeParse({ ...base, storagePath: 'orgs/org-a/documents/x.pdf' }).success).toBe(false);
  });

  it('needs a .docx for a new template and a system template to replace', () => {
    const file = { fileName: 'Letter.docx', contentBase64: 'UEsDBA==' };
    expect(SaveDocTemplateInput.safeParse({ requestId: REQUEST, name: 'Letter', kind: 'letter', file }).success).toBe(
      true,
    );
    expect(SaveDocTemplateInput.safeParse({ requestId: REQUEST, name: 'Letter', kind: 'letter' }).success).toBe(false);
    expect(
      SaveDocTemplateInput.safeParse({
        requestId: REQUEST,
        name: 'Letter',
        kind: 'letter',
        file: { ...file, fileName: 'Letter.pdf' },
      }).success,
    ).toBe(false);
    expect(
      SaveDocTemplateInput.safeParse({
        requestId: REQUEST,
        templateId: 'dt-1',
        name: 'Letter',
        kind: 'letter',
        replaces: 'dt-2',
      }).success,
    ).toBe(false);
    expect(
      SaveDocTemplateInput.safeParse({
        requestId: REQUEST,
        templateId: 'dt-1',
        name: 'Letter',
        kind: 'letter',
        replaces: 'system-letter',
      }).success,
    ).toBe(true);
  });

  it('takes only a body and a recipient as supplied data', () => {
    const input = { requestId: REQUEST, templateId: 'system-letter', matterId: 'm1' };
    expect(
      GenerateDocumentInput.safeParse({ ...input, data: { body: '**Hi**', recipient: { name: 'Thomas' } } }).success,
    ).toBe(true);
    expect(GenerateDocumentInput.safeParse({ ...input, data: { matter: { number: 'forged' } } }).success).toBe(false);
  });
});

describe('offeredDocTemplates', () => {
  const t = (
    id: string,
    extra: Partial<{ published: boolean; matterTypes: ('probate' | 'will')[]; replaces: string; deletedAt: Date }> = {},
  ) => ({
    id,
    published: true,
    matterTypes: [] as ('probate' | 'will')[],
    ...extra,
  });

  it('offers published templates for the matter type, then the system ones they don’t replace', () => {
    const offered = offeredDocTemplates(
      [
        t('dt-any'),
        t('dt-probate', { matterTypes: ['probate'], replaces: 'system-letter' }),
        t('dt-will', { matterTypes: ['will'] }),
        t('dt-draft', { published: false }),
        t('dt-gone', { deletedAt: new Date() }),
      ],
      'probate',
    );
    expect(offered.org.map((x) => x.id)).toEqual(['dt-any', 'dt-probate']);
    expect(offered.system.map((x) => x.id)).toEqual([
      'system-letterhead',
      'system-file-note',
      'system-costs-disclosure',
    ]);
    expect(
      offeredDocTemplates([t('dt-will', { matterTypes: ['will'], replaces: 'system-letter' })], 'probate').system,
    ).toHaveLength(4);
  });
});
