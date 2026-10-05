import { clamavScanUrl } from './params';

describe('clamavScanUrl', () => {
  it('is empty until the environment sets it, so uploads stay quarantined', () => {
    expect(clamavScanUrl({})).toBe('');
    expect(clamavScanUrl({ CLAMAV_SCAN_URL: ' https://scan.example.run.app ' })).toBe('https://scan.example.run.app');
  });
});
