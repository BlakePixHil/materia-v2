import {
  assetShareCents,
  assetValueChanged,
  defaultPassesOutside,
  distributionCents,
  distributionDependsOn,
  ESTATE_INVENTORY_FOOTER,
  ESTATE_INVENTORY_TITLE,
  estateTotals,
  EMPTY_ESTATE_TOTALS,
  inventoryCsv,
  inventoryFileName,
  inventorySchedule,
  isInsolvent,
  longDate,
  residueCalculation,
  sameEstateTotals,
  type InventoryAsset,
  type InventoryInput,
  type InventoryLiability,
} from './estate';
import { Asset, Distribution, Liability } from './schemas/matter-records';

/** CORE-16: the estate register's maths, in cents. Fictional data only. */

const asset = (id: string, o: Partial<InventoryAsset> = {}): InventoryAsset => ({
  id,
  class: 'bank',
  description: `Account ${id}`,
  valueAtDeathCents: 100_00,
  jointlyHeld: false,
  passesOutsideEstate: false,
  status: 'identified',
  ...o,
});
const liability = (id: string, o: Partial<InventoryLiability> = {}): InventoryLiability => ({
  id,
  class: 'debt',
  creditor: `Creditor ${id}`,
  amountCents: 10_00,
  status: 'notified',
  ...o,
});

describe('asset values', () => {
  it('counts the whole value, or the estate’s share rounded half up to the cent', () => {
    expect(assetShareCents({ valueAtDeathCents: 850_000_00 })).toBe(850_000_00);
    expect(assetShareCents({ valueAtDeathCents: 850_000_00, shareBps: 5000 })).toBe(425_000_00);
    expect(assetShareCents({ valueAtDeathCents: 1_01, shareBps: 5000 })).toBe(51); // 50.5 → 51
    expect(assetShareCents({ valueAtDeathCents: 100, shareBps: 3333 })).toBe(33); // 33.33
    expect(assetShareCents({ valueAtDeathCents: 3, shareBps: 1 })).toBe(0);
    expect(assetShareCents({ valueAtDeathCents: 0, shareBps: 2500 })).toBe(0);
  });

  it('passes a joint tenancy outside the estate by default, but not tenants in common', () => {
    expect(defaultPassesOutside(true, 'joint_tenants')).toBe(true);
    expect(defaultPassesOutside(true, 'tenants_in_common')).toBe(false);
    expect(defaultPassesOutside(true, undefined)).toBe(false);
    expect(defaultPassesOutside(false, 'joint_tenants')).toBe(false);
  });
});

describe('estate totals', () => {
  it('excludes assets passing outside the estate from gross and shows them separately', () => {
    const totals = estateTotals(
      [
        asset('house', {
          class: 'real_property',
          valueAtDeathCents: 900_000_00,
          shareBps: 5000,
          realisedCents: 455_000_00,
        }),
        asset('bank', { valueAtDeathCents: 42_317_55 }),
        asset('super', {
          class: 'superannuation',
          valueAtDeathCents: 412_000_00,
          passesOutsideEstate: true,
          realisedCents: 1,
        }),
        asset('jt', {
          valueAtDeathCents: 20_000_00,
          jointlyHeld: true,
          jointHolding: 'joint_tenants',
          shareBps: 5000,
          passesOutsideEstate: true,
        }),
        asset('gone', { valueAtDeathCents: 1_000_000_00, deletedAt: new Date() }),
      ],
      [
        liability('funeral', { class: 'funeral', amountCents: 8_500_00 }),
        liability('card', { amountCents: 1_234_56 }),
        liability('x', { amountCents: 99, deletedAt: new Date() }),
      ],
    );
    expect(totals).toEqual({
      grossCents: 450_000_00 + 42_317_55,
      liabilitiesCents: 8_500_00 + 1_234_56,
      netCents: 450_000_00 + 42_317_55 - 8_500_00 - 1_234_56,
      outsideCents: 412_000_00 + 10_000_00,
      realisedCents: 455_000_00,
      assetCount: 4,
      liabilityCount: 2,
    });
  });

  it('goes negative for an insolvent estate', () => {
    const totals = estateTotals(
      [asset('a', { valueAtDeathCents: 5_000_00 })],
      [liability('b', { amountCents: 7_500_01 })],
    );
    expect(totals.netCents).toBe(-2_500_01);
    expect(isInsolvent(totals)).toBe(true);
    expect(isInsolvent(EMPTY_ESTATE_TOTALS)).toBe(false);
  });

  it('is zero for an empty register, and compares field by field', () => {
    expect(EMPTY_ESTATE_TOTALS).toEqual({
      grossCents: 0,
      liabilitiesCents: 0,
      netCents: 0,
      outsideCents: 0,
      realisedCents: 0,
      assetCount: 0,
      liabilityCount: 0,
    });
    expect(sameEstateTotals(undefined, EMPTY_ESTATE_TOTALS)).toBe(false);
    expect(sameEstateTotals({ ...EMPTY_ESTATE_TOTALS }, EMPTY_ESTATE_TOTALS)).toBe(true);
    expect(sameEstateTotals({ ...EMPTY_ESTATE_TOTALS, netCents: 1 as never }, EMPTY_ESTATE_TOTALS)).toBe(false);
  });

  it('adds 500 share lines exactly', () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      asset(`s${i}`, { class: 'shares', valueAtDeathCents: 1_001 + i }),
    );
    expect(estateTotals(lines, []).grossCents).toBe(500 * 1_001 + (499 * 500) / 2);
  });
});

describe('residue', () => {
  const assets = new Map([
    ['car', { valueAtDeathCents: 30_000_00 }],
    ['house', { valueAtDeathCents: 800_000_00, shareBps: 5000 }],
  ]);

  it('values a specific gift at its amount, else the estate’s share of the asset', () => {
    expect(distributionCents({ kind: 'specific', status: 'planned', assetId: 'house' }, assets)).toBe(400_000_00);
    expect(
      distributionCents({ kind: 'specific', status: 'planned', assetId: 'car', amountCents: 25_000_00 }, assets),
    ).toBe(25_000_00);
    expect(distributionCents({ kind: 'specific', status: 'planned', assetId: 'missing' }, assets)).toBe(0);
    expect(distributionCents({ kind: 'pecuniary', status: 'planned', amountCents: 10_000_00 }, assets)).toBe(10_000_00);
    expect(distributionCents({ kind: 'residuary', status: 'planned' }, assets)).toBe(0);
  });

  it('is net estate less specific and pecuniary gifts less the reserve, ignoring cancelled gifts', () => {
    const result = residueCalculation(
      500_000_00,
      [
        { kind: 'specific', status: 'paid', assetId: 'car' },
        { kind: 'pecuniary', status: 'approved', amountCents: 20_000_00 },
        { kind: 'pecuniary', status: 'paid', amountCents: 5_000_00 },
        { kind: 'pecuniary', status: 'cancelled', amountCents: 99_000_00 },
        { kind: 'pecuniary', status: 'planned', amountCents: 1_000_00, deletedAt: new Date() },
        { kind: 'residuary', status: 'planned' },
      ],
      assets,
      15_000_00,
    );
    expect(result).toEqual({
      netCents: 500_000_00,
      specificCents: 30_000_00,
      pecuniaryCents: 25_000_00,
      reservedCents: 15_000_00,
      residueCents: 500_000_00 - 30_000_00 - 25_000_00 - 15_000_00,
      paidCents: 35_000_00,
    });
  });

  it('shows a negative residue when the gifts can’t all be met (shown, not enforced)', () => {
    expect(
      residueCalculation(10_00, [{ kind: 'pecuniary', status: 'planned', amountCents: 20_00 }], assets).residueCents,
    ).toBe(-10_00);
  });
});

describe('distribution review', () => {
  it('notices changes to what an asset is worth to the estate', () => {
    const before = asset('a', { valueAtDeathCents: 100_00 });
    expect(assetValueChanged(undefined, before)).toBe(true);
    expect(assetValueChanged(before, { ...before, description: 'Renamed' } as never)).toBe(false);
    expect(assetValueChanged(before, { ...before, valueAtDeathCents: 101_00 })).toBe(true);
    expect(assetValueChanged(before, { ...before, shareBps: 5000 })).toBe(true);
    expect(assetValueChanged(before, { ...before, passesOutsideEstate: true })).toBe(true);
    expect(assetValueChanged(before, { ...before, realisedCents: 90_00 })).toBe(true);
    expect(assetValueChanged(before, { ...before, deletedAt: new Date() })).toBe(true);
    expect(assetValueChanged({ ...before, deletedAt: new Date() }, { ...before, deletedAt: new Date() })).toBe(false);
  });

  it('flags residuary gifts and unvalued specific gifts of the asset, never cancelled ones', () => {
    expect(distributionDependsOn({ kind: 'residuary', status: 'planned' }, 'a')).toBe(true);
    expect(distributionDependsOn({ kind: 'specific', status: 'paid', assetId: 'a' }, 'a')).toBe(true);
    expect(distributionDependsOn({ kind: 'specific', status: 'planned', assetId: 'a', amountCents: 5 }, 'a')).toBe(
      false,
    );
    expect(distributionDependsOn({ kind: 'specific', status: 'planned', assetId: 'b' }, 'a')).toBe(false);
    expect(distributionDependsOn({ kind: 'pecuniary', status: 'planned', amountCents: 5 }, 'a')).toBe(false);
    expect(distributionDependsOn({ kind: 'residuary', status: 'cancelled' }, 'a')).toBe(false);
    expect(distributionDependsOn({ kind: 'residuary', status: 'planned', deletedAt: new Date() }, 'a')).toBe(false);
  });
});

describe('inventory export', () => {
  const input: InventoryInput = {
    matterNumber: 'HV-2026-0001',
    matterTitle: 'Estate of Margaret Doyle',
    deceasedName: 'Margaret Doyle',
    dateOfDeath: '2026-07-16',
    preparedOn: '2026-10-05',
    assets: [
      asset('b2', {
        description: 'Savings account',
        institution: 'Corio Savings Bank',
        valueAtDeathCents: 42_317_55,
        valuationSource: 'Bank letter',
        valuedOn: '2026-08-01',
        status: 'valued',
      }),
      asset('b1', { description: 'Cheque account', valueAtDeathCents: 1_204_10 }),
      asset('h', {
        class: 'real_property',
        description: '12 Example Street, Geelong',
        valueAtDeathCents: 900_000_00,
        jointlyHeld: true,
        jointHolding: 'tenants_in_common',
        shareBps: 5000,
      }),
      asset('s', {
        class: 'superannuation',
        description: 'Super, "Fictional Fund", =SUM(A1)',
        valueAtDeathCents: 412_000_00,
        passesOutsideEstate: true,
      }),
      asset('us', {
        class: 'shares',
        description: 'US shares',
        valueAtDeathCents: 15_000_00,
        originalCurrency: 'USD',
        originalAmount: 9876.5,
        realisedCents: 15_100_00,
        status: 'realised',
      }),
      asset('x', { description: 'Deleted', deletedAt: new Date() }),
    ],
    liabilities: [
      liability('f', { class: 'funeral', creditor: 'Bay Funerals', amountCents: 8_500_00, status: 'paid' }),
    ],
  };

  it('groups by class in register order, with totals, outside assets apart, and the summary', () => {
    const schedule = inventorySchedule(input);
    expect(schedule.title).toBe(ESTATE_INVENTORY_TITLE);
    expect(schedule.footer).toBe(ESTATE_INVENTORY_FOOTER);
    expect(schedule.footer).toContain('not a court form');
    expect(schedule.dateOfDeath).toBe('16 July 2026');
    expect(schedule.preparedOn).toBe('5 October 2026');
    expect(schedule.assetGroups.map((g) => [g.label, g.lines.map((l) => l.description), g.total])).toEqual([
      ['Real property', ['12 Example Street, Geelong'], '$450,000.00'],
      ['Bank accounts', ['Cheque account', 'Savings account'], '$43,521.65'],
      ['Shares and investments', ['US shares'], '$15,000.00'],
    ]);
    expect(schedule.assetGroups[0]?.lines[0]?.detail).toBe('Tenants in common; 50% share of $900,000.00');
    expect(schedule.assetGroups[1]?.lines[1]).toEqual({
      description: 'Savings account',
      reference: 'Corio Savings Bank',
      detail: 'Valued on 1 August 2026 (Bank letter)',
      value: '$42,317.55',
    });
    expect(schedule.assetGroups[2]?.lines[0]?.detail).toBe('USD 9876.50 at the date of death; Realised $15,100.00');
    expect(schedule.outsideGroups.map((g) => [g.label, g.total])).toEqual([['Superannuation', '$412,000.00']]);
    expect(schedule.liabilityGroups).toEqual([
      {
        label: 'Funeral expenses',
        lines: [{ description: 'Bay Funerals', reference: '', detail: 'Paid', value: '$8,500.00' }],
        total: '$8,500.00',
      },
    ]);
    expect(schedule.summary).toEqual([
      { label: 'Gross estate', value: '$508,521.65' },
      { label: 'Liabilities', value: '$8,500.00' },
      { label: 'Net estate', value: '$500,021.65' },
      { label: 'Assets passing outside the estate', value: '$412,000.00' },
    ]);
    expect(schedule.insolvent).toBe(false);
  });

  it('is deterministic whatever order the rows come in', () => {
    const shuffled = { ...input, assets: [...input.assets].reverse(), liabilities: [...input.liabilities].reverse() };
    expect(inventorySchedule(shuffled)).toEqual(inventorySchedule(input));
    expect(inventoryCsv(shuffled)).toBe(inventoryCsv(input));
  });

  it('writes CSV with quoting, defused formulas, plain dollars and the not-a-court-form note', () => {
    const lines = inventoryCsv(input).split('\r\n');
    expect(lines[0]).toBe(
      'Section,Class,Description,Institution or reference,Value at date of death (AUD),Estate share (AUD),Share,Jointly held,Status,Realised (AUD),Valuation source,Valued on,Original currency,Original amount',
    );
    expect(lines[1]).toBe(
      'Assets,Real property,"12 Example Street, Geelong",,900000.00,450000.00,50% share,Tenants in common,Identified,,,,,',
    );
    expect(lines).toContain('Assets,Bank accounts,Total,,,43521.65,,,,,,,,');
    expect(lines).toContain(
      'Passing outside the estate,Superannuation,"Super, ""Fictional Fund"", =SUM(A1)",,412000.00,412000.00,,No,Identified,,,,,',
    );
    expect(lines).toContain(
      'Assets,Shares and investments,US shares,,15000.00,15000.00,,No,Realised,15100.00,,,USD,9876.50',
    );
    expect(lines).toContain('Liabilities,Funeral expenses,Bay Funerals,,,8500.00,,,Paid,,,,,');
    expect(lines).toContain('Summary,,Net estate,,,500021.65,,,,,,,,');
    expect(lines.at(-2)).toBe(`Note,,${ESTATE_INVENTORY_FOOTER},,,,,,,,,,,`);
    expect(lines.at(-1)).toBe('');
  });

  it('defuses text that starts like a formula, but keeps negative amounts as numbers', () => {
    const csv = inventoryCsv({
      ...input,
      assets: [asset('a', { description: '=HYPERLINK("x")', valueAtDeathCents: 1_00 })],
      liabilities: [liability('l', { creditor: '+Creditor', amountCents: 5_00 })],
    });
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`'+Creditor`);
    expect(csv).toContain('Summary,,Net estate,,,-4.00');
  });

  it('marks an insolvent estate', () => {
    expect(
      inventorySchedule({ ...input, liabilities: [liability('big', { amountCents: 2_000_000_00 })] }).insolvent,
    ).toBe(true);
  });

  it('formats dates and file names without the locale', () => {
    expect(longDate('2026-01-09')).toBe('9 January 2026');
    expect(longDate(undefined)).toBe('');
    expect(longDate('not a date')).toBe('');
    expect(inventoryFileName('HV/2026:1', 'pdf')).toBe(
      'Schedule of assets and liabilities (working draft) - HV-2026-1.pdf',
    );
  });
});

describe('schemas', () => {
  const meta = { createdAt: new Date(), createdBy: 'u', updatedAt: new Date(), updatedBy: 'u', schemaVersion: 1 };

  it('accepts a foreign, tenants-in-common asset with valuation documents', () => {
    expect(
      Asset.schema.parse({
        class: 'real_property',
        description: 'Holiday unit',
        institution: 'Title 1234/567',
        valueAtDeathCents: 50_000_00,
        valuationSource: 'Agent appraisal',
        valuedOn: '2026-08-01',
        jointlyHeld: true,
        jointHolding: 'tenants_in_common',
        shareBps: 2500,
        passesOutsideEstate: false,
        status: 'valued',
        originalCurrency: 'NZD',
        originalAmount: 55_000,
        documentIds: ['doc-1'],
        ...meta,
      }),
    ).toMatchObject({ shareBps: 2500, documentIds: ['doc-1'] });
  });

  it('refuses negative or fractional money, bad shares and currencies', () => {
    const base = {
      class: 'bank',
      description: 'A',
      jointlyHeld: false,
      passesOutsideEstate: false,
      status: 'identified',
      ...meta,
    };
    expect(Asset.schema.safeParse({ ...base, valueAtDeathCents: -1 }).success).toBe(false);
    expect(Asset.schema.safeParse({ ...base, valueAtDeathCents: 1.5 }).success).toBe(false);
    expect(Asset.schema.safeParse({ ...base, valueAtDeathCents: 1, shareBps: 10_001 }).success).toBe(false);
    expect(Asset.schema.safeParse({ ...base, valueAtDeathCents: 1, originalCurrency: 'usd' }).success).toBe(false);
    expect(
      Liability.schema.safeParse({ class: 'tax', creditor: 'ATO', amountCents: -5, status: 'notified', ...meta })
        .success,
    ).toBe(false);
    expect(
      Distribution.schema.safeParse({
        beneficiaryPartyId: 'p',
        kind: 'pecuniary',
        amountCents: -1,
        status: 'planned',
        ...meta,
      }).success,
    ).toBe(false);
  });
});
