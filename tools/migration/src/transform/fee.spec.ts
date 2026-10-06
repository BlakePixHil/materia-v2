import { domain } from '../domain.ts';
import { FIXTURE_DIR, FIXTURE_UIDS } from '../legacy/fixtures.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { Warnings, type TransformContext, type WarningCode } from './context.ts';
import { mapFee, mapLegacyBilling } from './fee.ts';

const CARD = 'workflows/wf1/cards/Card0000000000000001';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: FIXTURE_UIDS.subject,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: new Date('2026-10-06T21:00:00.123Z'),
    people: new Map(),
    members: new Set([FIXTURE_UIDS.subject]),
    warnings: new Warnings(),
    ...over,
  };
}

function withFolio(folio: MappingProfile['fees']['billingTypes']['folio']): TransformContext {
  return makeCtx({
    profile: { ...profile, fees: { ...profile.fees, billingTypes: { ...profile.fees.billingTypes, folio } } },
  });
}

/** The warnings raised, by code, with their paths (zero counts left out). */
function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

/** The fee as the matter schema stores it. */
const feeSchema = () => domain.MatterSchema.shape.fee;

describe('mapFee', () => {
  it('maps a fixed fee in dollars to amountCents', () => {
    const ctx = makeCtx();
    const result = mapFee(ctx, { id: 'fee1', billingType: 'fixed', value: 3300 }, CARD);
    expect(result.fee).toEqual({ arrangement: 'fixed', amountCents: 330000, history: [] });
    expect(result.review).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.legacy).toEqual({ fee: { id: 'fee1', billingType: 'fixed', value: 3300 } });
    expect(warned(ctx)).toEqual({});
    expect(feeSchema().parse(result.fee)).toEqual(result.fee);
  });

  it('maps an hourly estimate with cents exactly (5500.5 dollars is 550050 cents)', () => {
    const ctx = makeCtx();
    const result = mapFee(ctx, { billingType: 'hourly', value: 5500.5 }, CARD);
    expect(result.fee).toEqual({ arrangement: 'hourly', estimateCents: 550050, history: [] });
    expect(result.review).toEqual([]);
    expect(feeSchema().parse(result.fee)).toEqual(result.fee);
  });

  it('reads amounts as cents when the profile says so', () => {
    const ctx = makeCtx({ profile: { ...profile, fees: { ...profile.fees, unit: 'cents' } } });
    expect(mapFee(ctx, { billingType: 'hourly', value: 5500.5 }, CARD).fee).toEqual({
      arrangement: 'hourly',
      estimateCents: 5501,
      history: [],
    });
  });

  it('trims the billing type', () => {
    const ctx = makeCtx();
    expect(mapFee(ctx, { billingType: ' hourly ', value: 10 }, CARD).fee).toEqual({
      arrangement: 'hourly',
      estimateCents: 1000,
      history: [],
    });
    expect(warned(ctx)).toEqual({});
  });

  it('maps a no-win fee to a conditional one for review, since legacy held no uplift or condition', () => {
    const ctx = makeCtx();
    const result = mapFee(ctx, { billingType: 'nowin', value: 25000 }, CARD);
    expect(result.fee).toEqual({ arrangement: 'conditional', estimateCents: 2500000, history: [] });
    expect(result.review).toEqual(['fee_conditional_terms']);
    expect(warned(ctx)).toEqual({});
    expect(feeSchema().parse(result.fee)).toEqual(result.fee);
  });

  it('maps a no-win fee with no value to a conditional one without an estimate', () => {
    const result = mapFee(makeCtx(), { billingType: 'nowin', value: 0 }, CARD);
    expect(result.fee).toEqual({ arrangement: 'conditional', history: [] });
    expect(result.review).toEqual(['fee_conditional_terms']);
  });

  describe('folio', () => {
    it.each([
      ['hourly', 'estimateCents'],
      ['fixed', 'amountCents'],
      ['capped', 'capCents'],
    ] as const)('maps folio to %s with the value as %s', (folio, field) => {
      const ctx = withFolio(folio);
      const result = mapFee(ctx, { billingType: 'folio', value: 1200.25 }, CARD);
      expect(result.fee).toEqual({ arrangement: folio, [field]: 120025, history: [] });
      expect(result.review).toEqual([]);
      expect(result.notes).toEqual([
        {
          key: 'fee-folio',
          text: `**Fee (imported)**\n\nThis matter was billed by folio in the legacy app. It is set up as ${folio} here.`,
        },
      ]);
      expect(warned(ctx)).toEqual({ MIG_W_FEE_FOLIO: [CARD] });
      expect(feeSchema().parse(result.fee)).toEqual(result.fee);
    });

    it('needs no amount when folio maps to hourly', () => {
      const ctx = withFolio('hourly');
      const result = mapFee(ctx, { billingType: 'folio', value: 0 }, CARD);
      expect(result.fee).toEqual({ arrangement: 'hourly', history: [] });
      expect(result.review).toEqual([]);
      expect(warned(ctx)).toEqual({ MIG_W_FEE_FOLIO: [CARD] });
    });

    it.each(['fixed', 'capped'] as const)('flags a missing amount when folio maps to %s', (folio) => {
      const ctx = withFolio(folio);
      const result = mapFee(ctx, { billingType: 'folio', value: 0 }, CARD);
      expect(result.fee).toEqual({ arrangement: folio, history: [] });
      expect(result.review).toEqual(['fee_amount_missing']);
      expect(result.notes.map((note) => note.key)).toEqual(['fee-folio']);
    });
  });

  it('reads an empty billing type as hourly with no estimate, for review', () => {
    const ctx = makeCtx();
    const result = mapFee(ctx, { billingType: '', value: 0 }, CARD);
    expect(result.fee).toEqual({ arrangement: 'hourly', history: [] });
    expect(result.review).toEqual(['fee_type_missing']);
    expect(result.notes).toEqual([]);
    expect(warned(ctx)).toEqual({ MIG_W_FEE_TYPE_MISSING: [CARD] });
    expect(feeSchema().parse(result.fee)).toEqual(result.fee);
  });

  it('reads a missing billing type as missing, and ignores the value', () => {
    const ctx = makeCtx();
    const result = mapFee(ctx, { value: 500 }, CARD);
    expect(result.fee).toEqual({ arrangement: 'hourly', history: [] });
    expect(result.review).toEqual(['fee_type_missing']);
    expect(warned(ctx)).toEqual({ MIG_W_FEE_TYPE_MISSING: [CARD] });
  });

  it('reads a billing type the legacy app never had as unknown', () => {
    const ctx = makeCtx();
    const result = mapFee(ctx, { billingType: 'retainer', value: 900 }, CARD);
    expect(result.fee).toEqual({ arrangement: 'hourly', history: [] });
    expect(result.review).toEqual(['fee_type_missing']);
    expect(warned(ctx)).toEqual({ MIG_W_FEE_TYPE_UNKNOWN: [CARD] });
  });

  it('gives no amount for value 0, and flags a fixed fee without one', () => {
    const ctx = makeCtx();
    const fixed = mapFee(ctx, { billingType: 'fixed', value: 0 }, CARD);
    expect(fixed.fee).toEqual({ arrangement: 'fixed', history: [] });
    expect(fixed.review).toEqual(['fee_amount_missing']);
    const hourly = mapFee(ctx, { billingType: 'hourly', value: 0 }, CARD);
    expect(hourly.fee).toEqual({ arrangement: 'hourly', history: [] });
    expect(hourly.review).toEqual([]);
    expect(warned(ctx)).toEqual({});
  });

  it('gives no amount for a negative or unreadable value', () => {
    expect(mapFee(makeCtx(), { billingType: 'hourly', value: -5 }, CARD).fee).toEqual({
      arrangement: 'hourly',
      history: [],
    });
    expect(mapFee(makeCtx(), { billingType: 'fixed', value: 'lots' }, CARD).review).toEqual(['fee_amount_missing']);
  });

  it('reads a value typed as text with a dollar sign and commas', () => {
    expect(mapFee(makeCtx(), { billingType: 'fixed', value: '$1,250.50' }, CARD).fee).toEqual({
      arrangement: 'fixed',
      amountCents: 125050,
      history: [],
    });
  });

  describe('disbursements', () => {
    it('keeps disbursements recorded on the fee for review, with a note naming the amount', () => {
      const ctx = makeCtx();
      const raw = { billingType: 'fixed', value: 2200, hasDisbursements: true, disbursements: 150 };
      const result = mapFee(ctx, raw, CARD);
      expect(result.fee).toEqual({ arrangement: 'fixed', amountCents: 220000, history: [] });
      expect(result.review).toEqual(['fee_disbursements']);
      expect(result.notes).toEqual([
        {
          key: 'fee-disbursements',
          text:
            '**Disbursements (imported)**\n\nThe legacy fee recorded disbursements of $150.00. ' +
            'Add them as disbursements here if they are still to be billed.',
        },
      ]);
      expect(warned(ctx)).toEqual({ MIG_W_FEE_DISBURSEMENTS: [CARD] });
      expect(result.legacy).toEqual({ fee: raw });
    });

    it('notes disbursements without an amount when only the flag is set', () => {
      const ctx = makeCtx();
      const result = mapFee(ctx, { billingType: 'hourly', hasDisbursements: true, disbursements: 0 }, CARD);
      expect(result.review).toEqual(['fee_disbursements']);
      expect(result.notes).toEqual([
        {
          key: 'fee-disbursements',
          text:
            '**Disbursements (imported)**\n\nThe legacy fee recorded disbursements. ' +
            'Add them as disbursements here if they are still to be billed.',
        },
      ]);
      expect(warned(ctx)).toEqual({ MIG_W_FEE_DISBURSEMENTS: [CARD] });
    });

    it('flags an amount of disbursements even without the flag', () => {
      const ctx = makeCtx();
      const result = mapFee(ctx, { billingType: 'hourly', disbursements: 1234.5 }, CARD);
      expect(result.review).toEqual(['fee_disbursements']);
      expect(result.notes[0]?.text).toContain('disbursements of $1,234.50.');
      expect(warned(ctx)).toEqual({ MIG_W_FEE_DISBURSEMENTS: [CARD] });
    });

    it('ignores no disbursements', () => {
      const ctx = makeCtx();
      const result = mapFee(ctx, { billingType: 'hourly', hasDisbursements: false, disbursements: 0 }, CARD);
      expect(result.review).toEqual([]);
      expect(result.notes).toEqual([]);
      expect(warned(ctx)).toEqual({});
    });

    it('puts the folio note before the disbursements note, and both review codes in order', () => {
      const ctx = withFolio('fixed');
      const result = mapFee(ctx, { billingType: 'folio', value: 0, hasDisbursements: true }, CARD);
      expect(result.review).toEqual(['fee_amount_missing', 'fee_disbursements']);
      expect(result.notes.map((note) => note.key)).toEqual(['fee-folio', 'fee-disbursements']);
      expect(warned(ctx)).toEqual({ MIG_W_FEE_FOLIO: [CARD], MIG_W_FEE_DISBURSEMENTS: [CARD] });
    });
  });

  describe('billed fees', () => {
    it('reads the old realisedFees as the billed amount', () => {
      const raw = { billingType: 'nowin', value: 25000, realisedFees: 1000 };
      expect(mapFee(makeCtx(), raw, CARD).legacy).toEqual({ fee: raw, billedFeesCents: 100000 });
    });

    it('reads billedFees, keeping the rest of the raw fee', () => {
      const raw = { billingType: 'hourly', value: 5500.5, billedFees: 1200, splitFees: true, ownershipPercentage: 50 };
      expect(mapFee(makeCtx(), raw, CARD).legacy).toEqual({ fee: raw, billedFeesCents: 120000 });
    });

    it('prefers billedFees over realisedFees, and falls back when billedFees is null', () => {
      expect(
        mapFee(makeCtx(), { billingType: 'hourly', billedFees: 10, realisedFees: 20 }, CARD).legacy?.[
          'billedFeesCents'
        ],
      ).toBe(1000);
      expect(
        mapFee(makeCtx(), { billingType: 'hourly', billedFees: null, realisedFees: 20 }, CARD).legacy?.[
          'billedFeesCents'
        ],
      ).toBe(2000);
    });

    it('keeps a billed amount of 0, and leaves out one that is not a number', () => {
      expect(mapFee(makeCtx(), { billingType: 'hourly', billedFees: 0 }, CARD).legacy).toEqual({
        fee: { billingType: 'hourly', billedFees: 0 },
        billedFeesCents: 0,
      });
      expect(mapFee(makeCtx(), { billingType: 'hourly', billedFees: 'n/a' }, CARD).legacy).toEqual({
        fee: { billingType: 'hourly', billedFees: 'n/a' },
      });
    });
  });

  it.each([null, undefined, 'fixed', 42, ['fixed']])('maps a missing fee (%j) to hourly for review', (raw) => {
    const ctx = makeCtx();
    const result = mapFee(ctx, raw, CARD);
    expect(result).toEqual({ fee: { arrangement: 'hourly', history: [] }, review: ['fee_type_missing'], notes: [] });
    expect(result).not.toHaveProperty('legacy');
    expect(warned(ctx)).toEqual({ MIG_W_FEE_TYPE_MISSING: [CARD] });
  });
});

describe('mapLegacyBilling', () => {
  const billed = {
    id: 'b0000002',
    status: 'billed',
    billingText: null,
    billingTotal: 2200,
    applyTrust: true,
    postType: 'post',
    paymentTerms: null,
    billingDate: '2025-03-31',
    notes: null,
  };

  it('keeps the raw fields, the billing date and the total in cents', () => {
    const ctx = makeCtx();
    expect(mapLegacyBilling(ctx, billed, CARD)).toEqual({ ...billed, billingTotalCents: 220000 });
    expect(warned(ctx)).toEqual({});
  });

  it('keeps a billing date with spaces around it, trimmed', () => {
    expect(mapLegacyBilling(makeCtx(), { status: 'pending', billingDate: ' 2025-04-01 ' }, CARD)).toEqual({
      status: 'pending',
      billingDate: '2025-04-01',
    });
  });

  it.each(['2025-02-30', '01/04/2025', '2025-04-01T00:00:00.000Z'])(
    'drops a billing date that is not a real day (%s)',
    (billingDate) => {
      const ctx = makeCtx();
      const result = mapLegacyBilling(ctx, { ...billed, billingDate }, CARD);
      expect(result).not.toHaveProperty('billingDate');
      expect(result).toMatchObject({ status: 'billed', billingTotalCents: 220000 });
      expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD] });
    },
  );

  it.each([null, ''])('drops an empty billing date (%j) quietly', (billingDate) => {
    const ctx = makeCtx();
    expect(mapLegacyBilling(ctx, { status: 'pending', billingDate }, CARD)).toEqual({ status: 'pending' });
    expect(warned(ctx)).toEqual({});
  });

  it('leaves out the total when it is not a number', () => {
    expect(mapLegacyBilling(makeCtx(), { status: 'pending', billingTotal: null }, CARD)).toEqual({
      status: 'pending',
      billingTotal: null,
    });
  });

  it('reads a total with cents exactly', () => {
    expect(mapLegacyBilling(makeCtx(), { billingTotal: 1999.99 }, CARD)).toEqual({
      billingTotal: 1999.99,
      billingTotalCents: 199999,
    });
  });

  it.each([null, undefined, 'billed', [billed]])('is absent without a billable object (%j)', (raw) => {
    expect(mapLegacyBilling(makeCtx(), raw, CARD)).toBeUndefined();
  });

  it('passes the matter schema as legacyBilling', () => {
    const result = mapLegacyBilling(makeCtx(), billed, CARD);
    expect(domain.MatterSchema.shape.legacyBilling.parse(result)).toEqual(result);
  });
});
