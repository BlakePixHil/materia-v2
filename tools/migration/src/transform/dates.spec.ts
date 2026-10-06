import type { MappingProfile } from '../profile.ts';
import {
  createdAndUpdated,
  dueDate,
  fyStartYear,
  instantOr,
  legacyDateOnly,
  optionalInstant,
  readInstant,
} from './dates.ts';
import { loadSpecProfile, SPEC_AS_OF, specContext, warned } from './spec-helpers.ts';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadSpecProfile();
});

const CARD = 'workflows/wf1/cards/Card0000000000000001';
const iso = (date: Date | undefined) => date?.toISOString();

describe('readInstant', () => {
  it('reads ISO instants in UTC and with an offset', () => {
    expect(iso(readInstant('2025-03-13T13:00:00.000Z'))).toBe('2025-03-13T13:00:00.000Z');
    expect(iso(readInstant('2025-03-14T00:00:00+11:00'))).toBe('2025-03-13T13:00:00.000Z');
    expect(iso(readInstant('2025-03-13T13:00Z'))).toBe('2025-03-13T13:00:00.000Z');
    expect(iso(readInstant('2025-03-13T13:00:05Z'))).toBe('2025-03-13T13:00:05.000Z');
    expect(iso(readInstant('  2025-03-13T13:00:00.000Z\n'))).toBe('2025-03-13T13:00:00.000Z');
  });

  it('reads Firestore Timestamps the export tagged', () => {
    expect(iso(readInstant({ $timestamp: '2024-06-01T00:00:00.000Z' }))).toBe('2024-06-01T00:00:00.000Z');
  });

  it('trims nanosecond and microsecond fractions to milliseconds', () => {
    expect(iso(readInstant('2026-10-06T21:00:00.123456Z'))).toBe('2026-10-06T21:00:00.123Z');
    expect(iso(readInstant({ $timestamp: '2026-10-06T21:00:00.123456789Z' }))).toBe('2026-10-06T21:00:00.123Z');
    expect(iso(readInstant('2026-10-06T21:00:00.5Z'))).toBe('2026-10-06T21:00:00.500Z');
  });

  it('rejects impossible days that Date would roll over', () => {
    expect(readInstant('2025-02-30T00:00:00.000Z')).toBeUndefined();
    expect(readInstant('2025-02-29T00:00:00.000Z')).toBeUndefined();
    expect(readInstant('2025-13-01T00:00:00.000Z')).toBeUndefined();
    expect(iso(readInstant('2024-02-29T00:00:00.000Z'))).toBe('2024-02-29T00:00:00.000Z');
  });

  it('rejects impossible times', () => {
    expect(readInstant('2025-03-13T25:00:00.000Z')).toBeUndefined();
    expect(readInstant('2025-03-13T12:61:00.000Z')).toBeUndefined();
  });

  it('rejects anything that is not an ISO instant', () => {
    for (const value of [
      undefined,
      null,
      '',
      '   ',
      'yesterday',
      '2025-03-13',
      '13/03/2025',
      '2025-03-13 13:00:00',
      '2025-03-13T13:00:00',
      'Thu Mar 13 2025 13:00:00 GMT+1100',
      1741870800000,
      true,
      [],
      ['2025-03-13T13:00:00.000Z'],
      {},
      { $timestamp: 1741870800000 },
      { $timestamp: 'not a date' },
      { seconds: 1741870800, nanoseconds: 0 },
      new Date('2025-03-13T13:00:00.000Z'),
    ]) {
      expect(readInstant(value)).toBeUndefined();
    }
  });
});

describe('instantOr', () => {
  it('reads a real instant without a warning', () => {
    const ctx = specContext(profile);
    expect(iso(instantOr(ctx, '2024-06-01T00:00:00.000Z', CARD))).toBe('2024-06-01T00:00:00.000Z');
    expect(warned(ctx)).toEqual({});
  });

  it('falls back to the export time with MIG_W_DATE_INVALID', () => {
    const ctx = specContext(profile);
    expect(instantOr(ctx, 'garbage', CARD)).toBe(SPEC_AS_OF);
    expect(instantOr(ctx, undefined, `${CARD}#comment/1`)).toBe(SPEC_AS_OF);
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD, `${CARD}#comment/1`] });
  });
});

describe('createdAndUpdated', () => {
  it('reads both dates when they are real and in order', () => {
    const ctx = specContext(profile);
    const result = createdAndUpdated(
      ctx,
      { createdOn: '2024-02-01T01:00:00.000Z', updatedOn: '2025-05-01T01:00:00.000Z' },
      CARD,
    );
    expect({ createdAt: iso(result.createdAt), updatedAt: iso(result.updatedAt) }).toEqual({
      createdAt: '2024-02-01T01:00:00.000Z',
      updatedAt: '2025-05-01T01:00:00.000Z',
    });
    expect(warned(ctx)).toEqual({});
  });

  it('keeps equal dates without a warning', () => {
    const ctx = specContext(profile);
    const result = createdAndUpdated(
      ctx,
      { createdOn: '2024-06-01T00:00:00.000Z', updatedOn: '2024-06-01T00:00:00.000Z' },
      CARD,
    );
    expect(iso(result.updatedAt)).toBe('2024-06-01T00:00:00.000Z');
    expect(warned(ctx)).toEqual({});
  });

  it('falls back to updatedOn when createdOn is invalid', () => {
    const ctx = specContext(profile);
    const result = createdAndUpdated(
      ctx,
      { createdOn: '2025-02-30T00:00:00.000Z', updatedOn: '2025-05-01T01:00:00.000Z' },
      CARD,
    );
    expect(iso(result.createdAt)).toBe('2025-05-01T01:00:00.000Z');
    expect(iso(result.updatedAt)).toBe('2025-05-01T01:00:00.000Z');
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD] });
  });

  it('uses the export time for both when neither date is real', () => {
    const ctx = specContext(profile);
    expect(createdAndUpdated(ctx, { createdOn: 'soon', updatedOn: 'later' }, CARD)).toEqual({
      createdAt: SPEC_AS_OF,
      updatedAt: SPEC_AS_OF,
    });
    expect(createdAndUpdated(ctx, {}, `${CARD}#2`)).toEqual({ createdAt: SPEC_AS_OF, updatedAt: SPEC_AS_OF });
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD, `${CARD}#2`] });
  });

  it('gives a missing or null updatedOn the created time, silently', () => {
    const ctx = specContext(profile);
    const missing = createdAndUpdated(ctx, { createdOn: '2024-02-01T01:00:00.000Z' }, CARD);
    expect(iso(missing.updatedAt)).toBe('2024-02-01T01:00:00.000Z');
    const empty = createdAndUpdated(ctx, { createdOn: '2024-02-01T01:00:00.000Z', updatedOn: null }, CARD);
    expect(iso(empty.updatedAt)).toBe('2024-02-01T01:00:00.000Z');
    expect(warned(ctx)).toEqual({});
  });

  it('reads an empty-string updatedOn as missing, silently when createdOn is good', () => {
    const ctx = specContext(profile);
    const result = createdAndUpdated(ctx, { createdOn: '2024-02-01T01:00:00.000Z', updatedOn: '' }, CARD);
    expect(iso(result.createdAt)).toBe('2024-02-01T01:00:00.000Z');
    expect(iso(result.updatedAt)).toBe('2024-02-01T01:00:00.000Z');
    expect(warned(ctx)).toEqual({});

    const bad = specContext(profile);
    expect(createdAndUpdated(bad, { createdOn: '', updatedOn: '' }, CARD)).toEqual({
      createdAt: SPEC_AS_OF,
      updatedAt: SPEC_AS_OF,
    });
    expect(warned(bad)).toEqual({ MIG_W_DATE_INVALID: [CARD] });
  });

  it('gives an invalid updatedOn the created time, with a warning', () => {
    const ctx = specContext(profile);
    const result = createdAndUpdated(ctx, { createdOn: '2024-02-01T01:00:00.000Z', updatedOn: 'garbage' }, CARD);
    expect(iso(result.updatedAt)).toBe('2024-02-01T01:00:00.000Z');
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD] });
  });

  it('reads a Timestamp-tagged updatedOn', () => {
    const ctx = specContext(profile);
    const result = createdAndUpdated(
      ctx,
      { createdOn: '2024-02-01T01:00:00.000Z', updatedOn: { $timestamp: '2025-05-01T01:00:00.123456Z' } },
      CARD,
    );
    expect(iso(result.updatedAt)).toBe('2025-05-01T01:00:00.123Z');
    expect(warned(ctx)).toEqual({});
  });

  it('never lets time run backwards: updated before created takes createdAt for both', () => {
    const ctx = specContext(profile);
    const result = createdAndUpdated(
      ctx,
      { createdOn: '2025-05-01T01:00:00.000Z', updatedOn: '2024-02-01T01:00:00.000Z' },
      CARD,
    );
    expect(iso(result.createdAt)).toBe('2025-05-01T01:00:00.000Z');
    expect(iso(result.updatedAt)).toBe('2025-05-01T01:00:00.000Z');
    expect(warned(ctx)).toEqual({ MIG_W_UPDATED_BEFORE_CREATED: [CARD] });
  });
});

describe('optionalInstant', () => {
  it('is undefined for an empty value, without a warning', () => {
    const ctx = specContext(profile);
    expect(optionalInstant(ctx, undefined, CARD)).toBeUndefined();
    expect(optionalInstant(ctx, null, CARD)).toBeUndefined();
    expect(optionalInstant(ctx, '', CARD)).toBeUndefined();
    expect(warned(ctx)).toEqual({});
  });

  it('reads a real instant', () => {
    const ctx = specContext(profile);
    expect(iso(optionalInstant(ctx, '2025-04-01T03:30:00.000Z', CARD))).toBe('2025-04-01T03:30:00.000Z');
    expect(iso(optionalInstant(ctx, { $timestamp: '2025-04-01T03:30:00Z' }, CARD))).toBe('2025-04-01T03:30:00.000Z');
    expect(warned(ctx)).toEqual({});
  });

  it('is undefined for an invalid value, with a warning', () => {
    const ctx = specContext(profile);
    expect(optionalInstant(ctx, '2025-02-30T00:00:00.000Z', CARD)).toBeUndefined();
    expect(optionalInstant(ctx, 42, `${CARD}#2`)).toBeUndefined();
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD, `${CARD}#2`] });
  });
});

describe('dueDate', () => {
  const due = (value: unknown) => {
    const ctx = specContext(profile);
    return { date: dueDate(ctx, value, CARD), warnings: warned(ctx) };
  };

  it('reads the stored UTC instant of local midnight as the Melbourne day', () => {
    expect(due('2025-03-13T13:00:00.000Z')).toEqual({ date: '2025-03-14', warnings: {} });
  });

  it('reads UTC midnight as the same day (11 am in Melbourne)', () => {
    expect(due('2025-03-13T00:00:00.000Z')).toEqual({ date: '2025-03-13', warnings: {} });
  });

  it('follows daylight saving: AEDT midnight before the April change, AEST after', () => {
    // Daylight saving ends at 3 am on Sunday 6 April 2025: midnight that day is still +11.
    expect(due('2025-04-05T13:00:00.000Z').date).toBe('2025-04-06');
    expect(due('2025-04-06T14:00:00.000Z').date).toBe('2025-04-07');
  });

  it('follows daylight saving: AEST midnight before the October change, AEDT after', () => {
    // Daylight saving starts at 2 am on Sunday 5 October 2025: midnight that day is still +10.
    expect(due('2025-10-04T14:00:00.000Z').date).toBe('2025-10-05');
    expect(due('2025-10-05T13:00:00.000Z').date).toBe('2025-10-06');
  });

  it('reads the day in the context time zone', () => {
    const ctx = specContext(profile, { timeZone: 'Australia/Perth' });
    expect(dueDate(ctx, '2025-03-13T13:00:00.000Z', CARD)).toBe('2025-03-13');
    expect(dueDate(ctx, '2025-03-13T16:00:00.000Z', CARD)).toBe('2025-03-14');
  });

  it('keeps a plain YYYY-MM-DD as it is', () => {
    expect(due('2025-03-14')).toEqual({ date: '2025-03-14', warnings: {} });
    expect(due(' 2025-03-14 ')).toEqual({ date: '2025-03-14', warnings: {} });
  });

  it('reads a Timestamp-tagged due date, nanoseconds and all', () => {
    expect(due({ $timestamp: '2025-03-13T13:00:00.000000000Z' })).toEqual({ date: '2025-03-14', warnings: {} });
  });

  it('is undefined for an empty value, without a warning', () => {
    expect(due(undefined)).toEqual({ date: undefined, warnings: {} });
    expect(due(null)).toEqual({ date: undefined, warnings: {} });
    expect(due('')).toEqual({ date: undefined, warnings: {} });
  });

  it('drops an invalid date with MIG_W_DATE_INVALID rather than invent a deadline', () => {
    for (const value of [
      'next Tuesday',
      '2025-02-30',
      '2025-02-30T13:00:00.000Z',
      '14/03/2025',
      42,
      true,
      { $timestamp: 'garbage' },
      {},
    ]) {
      expect(due(value)).toEqual({ date: undefined, warnings: { MIG_W_DATE_INVALID: [CARD] } });
    }
  });
});

describe('legacyDateOnly', () => {
  it('keeps a real YYYY-MM-DD', () => {
    const ctx = specContext(profile);
    expect(legacyDateOnly(ctx, '2025-06-30', CARD)).toBe('2025-06-30');
    expect(legacyDateOnly(ctx, ' 2024-02-29 ', CARD)).toBe('2024-02-29');
    expect(warned(ctx)).toEqual({});
  });

  it('is undefined for an empty value, without a warning', () => {
    const ctx = specContext(profile);
    expect(legacyDateOnly(ctx, undefined, CARD)).toBeUndefined();
    expect(legacyDateOnly(ctx, null, CARD)).toBeUndefined();
    expect(legacyDateOnly(ctx, '', CARD)).toBeUndefined();
    expect(warned(ctx)).toEqual({});
  });

  it('drops anything else with MIG_W_DATE_INVALID', () => {
    const ctx = specContext(profile);
    expect(legacyDateOnly(ctx, '2025-02-29', CARD)).toBeUndefined();
    expect(legacyDateOnly(ctx, '2025-06-30T00:00:00.000Z', `${CARD}#2`)).toBeUndefined();
    expect(legacyDateOnly(ctx, 20250630, `${CARD}#3`)).toBeUndefined();
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD, `${CARD}#2`, `${CARD}#3`] });
  });
});

describe('fyStartYear', () => {
  it('starts the financial year on 1 July in Melbourne, not in UTC', () => {
    // 11:30 pm on 30 June and 12:30 am on 1 July 2026 in Melbourne (AEST, +10) are both 30 June in UTC.
    const lastEvening = new Date('2026-06-30T13:30:00.000Z');
    const firstMorning = new Date('2026-06-30T14:30:00.000Z');
    expect(fyStartYear(lastEvening, 'Australia/Melbourne')).toBe(2025);
    expect(fyStartYear(firstMorning, 'Australia/Melbourne')).toBe(2026);
    expect(fyStartYear(firstMorning, 'UTC')).toBe(2025);
  });

  it('reads the year an instant falls in', () => {
    expect(fyStartYear(new Date('2026-08-01T00:00:00.000Z'), 'Australia/Melbourne')).toBe(2026);
    expect(fyStartYear(new Date('2027-06-29T00:00:00.000Z'), 'Australia/Melbourne')).toBe(2026);
    expect(fyStartYear(SPEC_AS_OF, 'Australia/Melbourne')).toBe(2026);
  });

  it('takes another start month', () => {
    expect(fyStartYear(new Date('2026-03-01T00:00:00.000Z'), 'Australia/Melbourne', 1)).toBe(2026);
    expect(fyStartYear(new Date('2026-03-01T00:00:00.000Z'), 'Australia/Melbourne', 4)).toBe(2025);
  });
});
