import fc from 'fast-check';

import { DomainValueError } from './errors';
import { deterministicId, ID_LENGTH, IdSchema, isId, newId } from './ids';
import { formatHm, formatUnits, minutes, MinutesSchema, toUnits } from './minutes';
import { addCents, cents, CentsSchema, formatCents, fromDollars, gstOf, percentOf, type Cents } from './money';

describe('Cents', () => {
  it('parses dollars exactly by string', () => {
    expect(addCents(fromDollars('0.1'), fromDollars('0.2'))).toBe(30);
    expect(fromDollars('1234.56')).toBe(123456);
    expect(fromDollars('5')).toBe(500);
    expect(fromDollars(0.07)).toBe(7);
    expect(fromDollars('-12.30')).toBe(-1230);
    expect(fromDollars('1.005')).toBe(101);
    expect(fromDollars('-1.005')).toBe(-101);
    expect(fromDollars('0.004')).toBe(0);
    expect(Object.is(fromDollars('-0.004'), 0)).toBe(true);
  });

  it('rejects malformed amounts', () => {
    for (const bad of ['$10', '1,000.00', '1e3', '', 'abc', '.5'])
      expect(() => fromDollars(bad)).toThrow(DomainValueError);
    expect(() => cents(1.5)).toThrow(DomainValueError);
    expect(CentsSchema.safeParse(10.5).success).toBe(false);
  });

  it.each([
    [1, 0],
    [5, 1],
    [4, 0],
    [15, 2],
    [100000, 10000],
    [-5, -1],
    [-15, -2],
    [-1, 0],
  ])('gstOf(%i) = %i (half-up per line, symmetric for credits)', (exGst, gst) => {
    expect(gstOf(exGst as Cents)).toBe(gst);
  });

  it('computes percentages and formats AUD', () => {
    expect(percentOf(10000 as Cents, 80)).toBe(8000);
    expect(percentOf(333 as Cents, 50)).toBe(167);
    expect(formatCents(123456 as Cents)).toBe('$1,234.56');
    expect(formatCents(-100 as Cents)).toBe('-$1.00');
  });

  it('money addition is associative and commutative (integers, no float drift)', () => {
    const amount = fc.integer({ min: -1e12, max: 1e12 }).map((n) => n as Cents);
    fc.assert(
      fc.property(amount, amount, amount, (a, b, c) => {
        expect(addCents(addCents(a, b), c)).toBe(addCents(a, addCents(b, c)));
        expect(addCents(a, b)).toBe(addCents(b, a));
      }),
    );
  });
});

describe('Minutes', () => {
  it.each([
    [0, 'up', 0],
    [1, 'up', 1],
    [6, 'up', 1],
    [7, 'up', 2],
    [0, 'nearest', 0],
    [1, 'nearest', 1],
    [8, 'nearest', 1],
    [9, 'nearest', 2],
    [15, 'nearest', 3],
  ] as const)('toUnits(%i, 6, %s) = %i', (duration, mode, units) => {
    expect(toUnits(duration, 6, mode)).toBe(units);
  });

  it('formats units and durations', () => {
    expect(formatUnits(15)).toBe('1.5');
    expect(formatUnits(3)).toBe('0.3');
    expect(formatUnits(1, 15)).toBe('0.25');
    expect(formatHm(65)).toBe('1h 05m');
    expect(formatHm(45)).toBe('45m');
    expect(formatHm(0)).toBe('0m');
  });

  it('rejects negative or fractional minutes and bad units', () => {
    expect(() => minutes(-1)).toThrow(DomainValueError);
    expect(() => toUnits(1.5)).toThrow(DomainValueError);
    expect(() => toUnits(10, 0)).toThrow(DomainValueError);
    expect(MinutesSchema.safeParse(-5).success).toBe(false);
  });

  it('rounding up never bills less than the time recorded', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (m) => {
        expect(toUnits(m)).toBeGreaterThanOrEqual(m / 6);
        expect(toUnits(m) * 6 - m).toBeLessThan(6);
      }),
    );
  });
});

describe('ids', () => {
  it('generates 20-character base62 ids', () => {
    const ids = new Set(Array.from({ length: 500 }, newId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isId(id)).toBe(true);
    expect(IdSchema.safeParse('short').success).toBe(false);
  });

  it('derives stable, namespaced ids', () => {
    const a = deterministicId('matter', 'legacy/abc');
    expect(a).toHaveLength(ID_LENGTH);
    expect(isId(a)).toBe(true);
    expect(deterministicId('matter', 'legacy/abc')).toBe(a);
    expect(deterministicId('task', 'legacy/abc')).not.toBe(a);
    expect(deterministicId('matter', 'legacy/abd')).not.toBe(a);
    expect(() => deterministicId('', 'x')).toThrow(DomainValueError);
  });
});
