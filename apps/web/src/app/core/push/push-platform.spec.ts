import { deviceLabel, devicePlatform } from './push-platform';

/** What Settings → Devices calls a browser (MOB-04), from real user agents. */

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  // iPadOS asks for desktop sites, so it says it's a Mac; touch gives it away.
  safariIpad:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};

const nav = (userAgent: string, touch = 0) => ({
  userAgent,
  maxTouchPoints: touch,
  platform: userAgent.includes('Macintosh') ? 'MacIntel' : 'Linux armv8l',
});

describe('deviceLabel', () => {
  it.each([
    [UA.chromeMac, 0, 'Chrome on macOS'],
    [UA.safariMac, 0, 'Safari on macOS'],
    [UA.edgeWindows, 0, 'Edge on Windows'],
    [UA.firefoxLinux, 0, 'Firefox on Linux'],
    [UA.chromeAndroid, 5, 'Chrome on Android'],
    [UA.samsungAndroid, 5, 'Samsung Internet on Android'],
    [UA.safariIphone, 5, 'Safari on iPhone'],
    [UA.safariIpad, 5, 'Safari on iPad'],
  ])('%s', (userAgent, touch, label) => {
    expect(deviceLabel(nav(userAgent, touch), false)).toBe(label);
  });

  it('names the installed app by the phone it runs on', () => {
    expect(deviceLabel(nav(UA.safariIphone, 5), true)).toBe('Materia app on iPhone');
    expect(deviceLabel(nav(UA.chromeAndroid, 5), true)).toBe('Materia app on Android');
  });
});

describe('devicePlatform', () => {
  it('is ios for iPhones and iPads, android for Android, web for the rest', () => {
    expect(devicePlatform(nav(UA.safariIphone, 5))).toBe('ios');
    expect(devicePlatform(nav(UA.safariIpad, 5))).toBe('ios');
    expect(devicePlatform(nav(UA.chromeAndroid, 5))).toBe('android');
    expect(devicePlatform(nav(UA.chromeMac))).toBe('web');
  });
});
