import {
  canExport,
  contactExportCells,
  contactPassesFilters,
  CreateExportInput,
  csvTextCell,
  deadlineExportCells,
  EXPORT_COLUMNS,
  EXPORT_KINDS,
  exportHeader,
  exportIncludesPrivileged,
  exportLine,
  invoiceExportCells,
  invoicePassesFilter,
  matterExportCells,
  matterPassesFilters,
  timeExportCells,
  type ContactFilterRow,
  type MatterFilterRow,
} from './exports';
import type { DateOnly } from './values/date-only';

/** INS-03: the CSV rows, escaping, filters and who may export. All fictional. */

const REQUEST_ID = '0f5d6c1e-2b7a-4c3d-9e8f-1a2b3c4d5e6f';

describe('CSV cells', () => {
  it('defuses formulas in every cell (=, +, -, @) and quotes what needs it', () => {
    expect(
      exportLine(['=HYPERLINK("http://evil.example")', '+61 3', '-1', '@SUM(A1)', 'plain', 'a,b', 'say "hi"']),
    ).toBe(`"'=HYPERLINK(""http://evil.example"")",'+61 3,'-1,'@SUM(A1),plain,"a,b","say ""hi"""`);
  });

  it('keeps text cells quoted, so a leading zero survives Excel, and still defuses them', () => {
    expect(csvTextCell('0412 345 678')).toBe('"0412 345 678"');
    expect(csvTextCell('3220')).toBe('"3220"');
    expect(csvTextCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvTextCell('')).toBe('');
  });

  it('has a header for every kind', () => {
    for (const kind of EXPORT_KINDS) expect(exportHeader(kind).split(',')).toHaveLength(EXPORT_COLUMNS[kind].length);
  });
});

describe('rows', () => {
  it('writes a matter with ISO dates and decimal dollars', () => {
    const cells = matterExportCells(
      {
        number: '0042',
        title: 'Estate of Fictional Person',
        type: 'probate',
        status: 'open',
        jurisdiction: 'VIC',
        nextDeadline: { title: 'File the inventory', dueDate: '2026-10-20' },
        wipCents: 123456,
        disbursementWipCents: 5000,
        outstandingCents: -250,
        labels: ['Geelong', 'urgent'],
        privileged: false,
      },
      { openedOn: '2026-07-01' as DateOnly, closedOn: null, clients: ['Ada Fictional'], responsible: 'Ben Lawyer' },
    );
    expect(exportLine(cells)).toMatchInlineSnapshot(
      `""0042",Estate of Fictional Person,probate,Open,Ada Fictional,Ben Lawyer,VIC,2026-07-01,,File the inventory,2026-10-20,1234.56,50.00,-2.50,Geelong; urgent,No"`,
    );
  });

  it('writes a contact with its phone as national text (leading zero kept)', () => {
    const cells = contactExportCells({
      kind: 'person',
      givenNames: 'Ada',
      familyName: 'Fictional',
      emails: [
        { type: 'personal', address: 'ada.fictional@example.com' },
        { type: 'work', address: 'ada@work.example' },
      ],
      phones: [
        { type: 'mobile', number: '+61412345678' },
        { type: 'home', number: '+61352001234' },
      ],
      addresses: [
        {
          type: 'residential',
          line1: '1 Fictional St',
          suburb: 'Geelong',
          state: 'VIC',
          postcode: '3220',
          country: 'AU',
        },
      ],
      tags: ['executor'],
      isReferrer: false,
      matterRoles: ['executor'],
    });
    expect(exportLine(cells)).toMatchInlineSnapshot(
      `"Ada Fictional,person,Ada,Fictional,,,ada.fictional@example.com,ada@work.example,"0412 345 678","(03) 5200 1234","1 Fictional St, Geelong, VIC, 3220",executor,No,executor"`,
    );
  });

  it('writes a time entry with hours, rate and amount', () => {
    const cells = timeExportCells({
      date: '2026-10-01',
      matterNumber: '0042',
      matterTitle: 'Estate of Fictional Person',
      person: 'Ben Lawyer',
      narrative: '=cmd|calc',
      minutes: 42,
      units: 7,
      unitMinutes: 6,
      rateCents: 45000,
      amountCents: 31500,
      billable: true,
      status: 'final',
    });
    expect(exportLine(cells)).toMatchInlineSnapshot(
      `"2026-10-01,"0042",Estate of Fictional Person,Ben Lawyer,'=cmd|calc,42,7,0.70,450.00,315.00,Yes,final,,"`,
    );
  });

  it('writes an invoice with what was paid and what is owed', () => {
    const cells = invoiceExportCells({
      number: 'INV-0007',
      status: 'part_paid',
      matterNumber: '0042',
      matterTitle: 'Estate of Fictional Person',
      buyer: { name: 'Ada Fictional' },
      issueDate: '2026-10-01',
      dueDate: '2026-10-15',
      subtotalCents: 100000,
      gstCents: 10000,
      totalCents: 110000,
      creditedCents: 10000,
      payments: [{ amountCents: 50000 }, { amountCents: 20000, reversedAt: '2026-10-03' }],
    });
    expect(exportLine(cells)).toMatchInlineSnapshot(
      `""INV-0007",part_paid,"0042",Estate of Fictional Person,Ada Fictional,2026-10-01,2026-10-15,1000.00,100.00,1100.00,100.00,500.00,500.00,No"`,
    );
    expect(exportLine(invoiceExportCells({ number: '', status: 'draft', totalCents: 0 })).split(',')[0]).toBe(
      '"Pre-bill"',
    );
  });

  it('writes a deadline', () => {
    const cells = deadlineExportCells(
      { dueDate: '2026-10-20', dueTime: '16:00', title: 'File the inventory', kind: 'court', critical: true },
      { matterNumber: '0042', matterTitle: 'Estate of Fictional Person', jurisdiction: 'VIC', assignee: 'Ben Lawyer' },
    );
    expect(exportLine(cells)).toMatchInlineSnapshot(
      `"2026-10-20,16:00,File the inventory,court,Yes,"0042",Estate of Fictional Person,VIC,Ben Lawyer"`,
    );
  });
});

describe('who may export', () => {
  it('lets everyone but read-only members export what they see', () => {
    expect(canExport('paralegal', 'matters')).toBe(true);
    expect(canExport('paralegal', 'time')).toBe(false);
    expect(canExport('paralegal', 'invoices')).toBe(false);
    expect(canExport('lawyer', 'invoices')).toBe(true);
    expect(canExport('readonly', 'matters')).toBe(false);
    expect(canExport(null, 'contacts')).toBe(false);
  });

  it('includes privileged rows only when a lawyer or above asks', () => {
    expect(exportIncludesPrivileged('lawyer', true)).toBe(true);
    expect(exportIncludesPrivileged('owner', false)).toBe(false);
    expect(exportIncludesPrivileged('paralegal', true)).toBe(false);
  });
});

describe('CreateExportInput', () => {
  it('drops filters sent as null and defaults the privileged choice to off', () => {
    const parsed = CreateExportInput.parse({
      requestId: REQUEST_ID,
      kind: 'contacts',
      filters: { kind: 'person', tag: null, query: null },
      includePrivileged: null,
    });
    expect(parsed).toEqual({
      requestId: REQUEST_ID,
      kind: 'contacts',
      filters: { kind: 'person' },
      includePrivileged: false,
    });
  });

  it('needs a date range for time entries, in order', () => {
    expect(CreateExportInput.safeParse({ requestId: REQUEST_ID, kind: 'time', filters: {} }).success).toBe(false);
    expect(
      CreateExportInput.safeParse({
        requestId: REQUEST_ID,
        kind: 'time',
        filters: { from: '2026-10-31', to: '2026-10-01' },
      }).success,
    ).toBe(false);
    expect(
      CreateExportInput.safeParse({
        requestId: REQUEST_ID,
        kind: 'time',
        filters: { from: '2026-10-01', to: '2026-10-31', unbilledOnly: true, matterType: 'probate' },
      }).success,
    ).toBe(true);
  });

  it('refuses filters a list doesn’t have', () => {
    expect(
      CreateExportInput.safeParse({ requestId: REQUEST_ID, kind: 'invoices', filters: { tag: 'x' } }).success,
    ).toBe(false);
  });
});

describe('filters', () => {
  const matter = (extra: Partial<MatterFilterRow> = {}): MatterFilterRow => ({
    status: 'open',
    type: 'probate',
    responsibleUid: 'user-ben',
    labels: ['Geelong'],
    jurisdiction: 'VIC',
    search: ['estate', 'fictional'],
    number: '0042',
    title: 'Estate of Fictional Person',
    ...extra,
  });
  const context = { viewerUid: 'user-ben', today: '2026-10-06' as DateOnly, now: new Date('2026-10-06T00:00:00Z') };

  it('applies the Matters list’s filters', () => {
    expect(matterPassesFilters(matter(), { status: ['open'], responsible: 'me', query: 'fictional' }, context)).toBe(
      true,
    );
    expect(matterPassesFilters(matter(), { status: ['closed'] }, context)).toBe(false);
    expect(matterPassesFilters(matter({ deletedAt: new Date() }), {}, context)).toBe(false);
    expect(matterPassesFilters(matter(), { hasOverdue: true }, context)).toBe(false);
    expect(
      matterPassesFilters(matter({ nextDeadline: { dueDate: '2026-10-01' } }), { hasOverdue: true }, context),
    ).toBe(true);
  });

  it('applies the Contacts list’s filters and hides merged contacts', () => {
    const contact: ContactFilterRow = {
      kind: 'person',
      familyName: 'Fictional',
      givenNames: 'Ada',
      tags: ['executor'],
      matterRoles: [],
      emails: [],
      phones: [],
    };
    expect(contactPassesFilters(contact, { kind: 'person', tag: 'executor', query: 'ada' })).toBe(true);
    expect(contactPassesFilters(contact, { kind: 'organisation' })).toBe(false);
    expect(contactPassesFilters({ ...contact, mergedInto: 'c2' })).toBe(false);
  });

  it('reads the Invoices screen’s "Show" choice', () => {
    expect(invoicePassesFilter('draft', 'live')).toBe(false);
    expect(invoicePassesFilter('part_paid', 'live')).toBe(true);
    expect(invoicePassesFilter('void', 'void')).toBe(true);
    expect(invoicePassesFilter('void', undefined)).toBe(true);
  });
});
