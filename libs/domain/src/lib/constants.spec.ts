import { BILLING_UNIT_MINUTES, CURRENCY, DEFAULT_ORG_TIMEZONE } from './constants';

describe('domain constants', () => {
  it('defaults to Melbourne time, AUD and 6-minute units', () => {
    expect(DEFAULT_ORG_TIMEZONE).toBe('Australia/Melbourne');
    expect(CURRENCY).toBe('AUD');
    expect(BILLING_UNIT_MINUTES).toBe(6);
  });
});
