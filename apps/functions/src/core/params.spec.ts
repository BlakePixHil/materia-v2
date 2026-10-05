import { clamavScanUrl, previewServiceUrl } from './params';

describe('clamavScanUrl', () => {
  it('is empty until the environment sets it, so uploads stay quarantined', () => {
    expect(clamavScanUrl({})).toBe('');
    expect(clamavScanUrl({ CLAMAV_SCAN_URL: ' https://scan.example.run.app ' })).toBe('https://scan.example.run.app');
  });
});

describe('previewServiceUrl', () => {
  it('is empty until the environment sets it, so Office and HEIC files have no preview', () => {
    expect(previewServiceUrl({})).toBe('');
    expect(previewServiceUrl({ PREVIEW_SERVICE_URL: 'https://preview.example.run.app\n' })).toBe(
      'https://preview.example.run.app',
    );
  });
});
