import type { MappingProfile } from '../profile.ts';
import { loadSpecProfile, specContext, warned } from './spec-helpers.ts';
import { centsOf, cleanText, priorityOf, splitName } from './values.ts';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadSpecProfile();
});

const CARD = 'workflows/wf1/cards/Card0000000000000001';
const inCents = () => specContext(profile, { profile: { ...profile, fees: { ...profile.fees, unit: 'cents' } } });

describe('priorityOf', () => {
  it('maps 0 to 3 to none, high, medium and low', () => {
    const ctx = specContext(profile);
    expect([0, 1, 2, 3].map((value) => priorityOf(ctx, value, CARD))).toEqual(['none', 'high', 'medium', 'low']);
    expect(warned(ctx)).toEqual({});
  });

  it('reads a missing priority as none, silently', () => {
    const ctx = specContext(profile);
    expect(priorityOf(ctx, undefined, CARD)).toBe('none');
    expect(priorityOf(ctx, null, CARD)).toBe('none');
    expect(priorityOf(ctx, '', CARD)).toBe('none');
    expect(warned(ctx)).toEqual({});
  });

  it('reads anything else as none with MIG_W_PRIORITY_UNKNOWN', () => {
    for (const value of [7, -1, 1.5, Number.NaN, '1', 'high', true, {}]) {
      const ctx = specContext(profile);
      expect(priorityOf(ctx, value, CARD)).toBe('none');
      expect(warned(ctx)).toEqual({ MIG_W_PRIORITY_UNKNOWN: [CARD] });
    }
  });
});

describe('centsOf', () => {
  it('reads dollars as integer cents exactly', () => {
    const ctx = specContext(profile);
    expect(centsOf(ctx, 5500.5)).toBe(550050);
    expect(centsOf(ctx, 3300)).toBe(330000);
    expect(centsOf(ctx, 0.1)).toBe(10);
    expect(centsOf(ctx, 0.29)).toBe(29);
    expect(centsOf(ctx, 1.15)).toBe(115);
    expect(centsOf(ctx, 0)).toBe(0);
    expect(centsOf(ctx, -12.5)).toBe(-1250);
  });

  it('rounds a third decimal place half away from zero', () => {
    const ctx = specContext(profile);
    expect(centsOf(ctx, 1.005)).toBe(101);
    expect(centsOf(ctx, 12.344)).toBe(1234);
    expect(centsOf(ctx, -1.005)).toBe(-101);
  });

  it('reads amounts typed as text, with a dollar sign, commas and spaces', () => {
    const ctx = specContext(profile);
    expect(centsOf(ctx, '$1,200.50')).toBe(120050);
    expect(centsOf(ctx, ' 5500.5 ')).toBe(550050);
    expect(centsOf(ctx, '$ 1 200')).toBe(120000);
    expect(centsOf(ctx, '-$45.10')).toBe(-4510);
  });

  it('is undefined for anything that is not a finite amount', () => {
    const ctx = specContext(profile);
    for (const value of [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '',
      '   ',
      'about $500',
      'Infinity',
      true,
      {},
      [5],
    ]) {
      expect(centsOf(ctx, value)).toBeUndefined();
    }
  });

  it('is undefined for amounts too large to be safe integer cents', () => {
    const ctx = specContext(profile);
    expect(centsOf(ctx, 1e21)).toBeUndefined();
    expect(centsOf(ctx, 1e20)).toBeUndefined();
    expect(centsOf(ctx, '100000000000000000000')).toBeUndefined();
    expect(centsOf(ctx, 1e17)).toBeUndefined();
  });

  it('reads amounts as cents when the profile says so, rounding to whole cents', () => {
    const ctx = inCents();
    expect(centsOf(ctx, 550050)).toBe(550050);
    expect(centsOf(ctx, 12.6)).toBe(13);
    expect(centsOf(ctx, '1,200')).toBe(1200);
    expect(centsOf(ctx, Number.NaN)).toBeUndefined();
    expect(centsOf(ctx, undefined)).toBeUndefined();
  });

  it('is undefined for huge amounts in cents too', () => {
    expect(centsOf(inCents(), 1e21)).toBeUndefined();
    expect(centsOf(inCents(), Number.MAX_SAFE_INTEGER + 2)).toBeUndefined();
    expect(centsOf(inCents(), Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('splitName', () => {
  it('splits the last word off as the family name', () => {
    expect(splitName('Jane Mary Smith')).toEqual({ givenNames: 'Jane Mary', familyName: 'Smith' });
    expect(splitName('Jordan Ellis')).toEqual({ givenNames: 'Jordan', familyName: 'Ellis' });
  });

  it('reads a single word as a family name', () => {
    expect(splitName('Morgan')).toEqual({ familyName: 'Morgan' });
  });

  it('tidies whitespace', () => {
    expect(splitName('  Sam \t  Q.\n Example  ')).toEqual({ givenNames: 'Sam Q.', familyName: 'Example' });
  });

  it('is empty for an empty name', () => {
    expect(splitName('')).toEqual({});
    expect(splitName('   ')).toEqual({});
  });
});

describe('cleanText', () => {
  it('trims and collapses runs of whitespace', () => {
    expect(cleanText('  Fictional   Accounting\n\tPty  Ltd ')).toBe('Fictional Accounting Pty Ltd');
    expect(cleanText('Estates')).toBe('Estates');
  });

  it('is empty for anything that is not text', () => {
    expect(cleanText(undefined)).toBe('');
    expect(cleanText(null)).toBe('');
    expect(cleanText(42)).toBe('');
    expect(cleanText({ name: 'x' })).toBe('');
  });
});
