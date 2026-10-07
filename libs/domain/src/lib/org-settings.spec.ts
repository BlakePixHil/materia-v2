import {
  abnProblem,
  BillingSettingsInput,
  formatAbn,
  isValidAbn,
  matterNumberFormatWarning,
  PracticeSettingsInput,
  timeZoneOptions,
  UpdateOrgSettingsInput,
} from './org-settings';
import { FeeDefaultSchema } from './schemas/tenancy';
import { dateOnly, fyLabel, fyStartYear } from './values/date-only';

const practice = {
  name: 'Fictional Bayside Legal',
  abn: '',
  primaryJurisdiction: 'VIC',
  jurisdictions: ['VIC', 'NSW'],
  timezone: 'Australia/Melbourne',
  holidayLocality: 'VIC_GREATER_GEELONG',
  retentionYears: 7,
} as const;

describe('ABN checksum', () => {
  it.each(['51 824 753 556', '53004085616', '33 102 417 032'])('accepts %s', (abn) => {
    expect(isValidAbn(abn)).toBe(true);
    expect(abnProblem(abn)).toBeNull();
  });

  it.each(['51 824 753 557', '12345678901', '00000000000'])('rejects %s', (abn) => {
    expect(isValidAbn(abn)).toBe(false);
    expect(abnProblem(abn)).toMatch(/valid ABN/);
  });

  it('wants 11 digits, and allows none', () => {
    expect(isValidAbn('5182475355')).toBe(false);
    expect(abnProblem('5182 475')).toBe('An ABN is 11 digits.');
    expect(abnProblem('  ')).toBeNull();
  });

  it('formats as the ATO does', () => {
    expect(formatAbn('51824753556')).toBe('51 824 753 556');
    expect(formatAbn('518')).toBe('518');
  });
});

describe('financial years', () => {
  it('starts in July: FY2026–27 is fyStartYear 2026', () => {
    expect(fyStartYear(dateOnly('2026-07-01'))).toBe(2026);
    expect(fyStartYear(dateOnly('2027-06-30'))).toBe(2026);
    expect(fyStartYear(dateOnly('2026-06-30'))).toBe(2025);
    expect(fyLabel(2026)).toBe('FY2026–27');
    expect(fyLabel(2099)).toBe('FY2099–00');
  });

  it('handles a calendar financial year', () => {
    expect(fyStartYear(dateOnly('2026-01-01'), 1)).toBe(2026);
    expect(fyLabel(2026, 1)).toBe('FY2026');
  });
});

describe('matter number format warnings', () => {
  it('warns when numbers could repeat across years', () => {
    expect(matterNumberFormatWarning('{TYPE}-{seq:4}')).toMatch(/restarts each year/);
    expect(matterNumberFormatWarning('M-{YYYY}-{seq:4}')).toBeNull();
    expect(matterNumberFormatWarning('{YY}/{seq}')).toBeNull();
  });

  it('leaves invalid formats to the format check', () => {
    expect(matterNumberFormatWarning('no tokens')).toBeNull();
  });
});

describe('settings inputs', () => {
  it('accepts a practice and strips the ABN’s spaces', () => {
    const parsed = PracticeSettingsInput.parse({ ...practice, abn: '51 824 753 556' });
    expect(parsed.abn).toBe('51824753556');
  });

  it('refuses a bad ABN, short retention, an unknown zone and a primary outside the list', () => {
    expect(PracticeSettingsInput.safeParse({ ...practice, abn: '51824753557' }).success).toBe(false);
    expect(PracticeSettingsInput.safeParse({ ...practice, retentionYears: 6 }).success).toBe(false);
    expect(PracticeSettingsInput.safeParse({ ...practice, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(PracticeSettingsInput.safeParse({ ...practice, jurisdictions: ['NSW'] }).success).toBe(false);
    expect(PracticeSettingsInput.safeParse({ ...practice, holidayLocality: 'VIC_SYDNEY' }).success).toBe(false);
  });

  it('checks billing fields', () => {
    const billing = {
      defaultRateCents: 45000,
      unitMinutes: 6,
      rounding: 'up',
      gstRegistered: true,
      invoicePrefix: 'INV-',
      paymentTermsDays: 14,
    };
    expect(BillingSettingsInput.safeParse(billing).success).toBe(true);
    expect(BillingSettingsInput.safeParse({ ...billing, invoicePrefix: 'INV 2026 LONG' }).success).toBe(false);
    expect(BillingSettingsInput.safeParse({ ...billing, defaultRateCents: 1.5 }).success).toBe(false);
    expect(BillingSettingsInput.safeParse({ ...billing, defaultRateCents: -100 }).success).toBe(false);
  });

  it('needs the amount a fee default’s arrangement implies', () => {
    expect(FeeDefaultSchema.safeParse({ arrangement: 'fixed' }).success).toBe(false);
    expect(FeeDefaultSchema.safeParse({ arrangement: 'fixed', amountCents: 330000 }).success).toBe(true);
    expect(FeeDefaultSchema.safeParse({ arrangement: 'capped', estimateCents: 100 }).success).toBe(false);
    expect(FeeDefaultSchema.safeParse({ arrangement: 'conditional' }).success).toBe(false);
  });

  it('takes any group, a valid number format, and a dry run', () => {
    const parsed = UpdateOrgSettingsInput.parse({
      requestId: '7f6c2a8e-3a1b-4c55-9b7e-2f1a7e1d9c01',
      matterNumberFormat: ' {TYPE}-{YY}-{seq:3} ',
      feeDefaults: { will: { arrangement: 'fixed', amountCents: 88000 } },
    });
    expect(parsed.matterNumberFormat).toBe('{TYPE}-{YY}-{seq:3}');
    expect(parsed.dryRun).toBe(false);
    expect(
      UpdateOrgSettingsInput.safeParse({
        requestId: '7f6c2a8e-3a1b-4c55-9b7e-2f1a7e1d9c01',
        matterNumberFormat: 'X-{n}',
      }).success,
    ).toBe(false);
  });

  it('lists Australian time zones first', () => {
    const zones = timeZoneOptions();
    expect(zones[0]).toMatch(/^Australia\//);
    expect(zones).toContain('Australia/Melbourne');
  });
});
