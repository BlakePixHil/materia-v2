import { TestBed } from '@angular/core/testing';

import { DialogService, ToastService } from '@materia/ui';

import { INSTALL_COPY, InstallPrompt, isIos, isStandalone } from './install-prompt';

/** Chrome's `beforeinstallprompt`, answered with `outcome`. */
function promptEvent(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

function setup() {
  TestBed.configureTestingModule({});
  const open = vi
    .spyOn(TestBed.inject(DialogService), 'open')
    .mockReturnValue({ result: Promise.resolve(undefined) } as ReturnType<DialogService['open']>);
  const show = vi.spyOn(TestBed.inject(ToastService), 'show');
  return { install: TestBed.inject(InstallPrompt), open, show };
}

const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('InstallPrompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('offers nothing until the browser says the app can be installed', () => {
    const { install } = setup();
    expect(install.available()).toBe(false);
  });

  it('holds the browser’s prompt (no banner) and shows it when asked', async () => {
    const { install } = setup();
    const event = promptEvent('accepted');
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(install.available()).toBe(true);

    await expect(install.install()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledOnce();
    // A prompt is good for one showing.
    expect(install.available()).toBe(false);
  });

  it('reports a dismissed prompt', async () => {
    const { install } = setup();
    window.dispatchEvent(promptEvent('dismissed'));
    await expect(install.install()).resolves.toBe('dismissed');
  });

  it('stops offering once installed, and says where to find it', () => {
    const { install, show } = setup();
    window.dispatchEvent(promptEvent('accepted'));
    window.dispatchEvent(new Event('appinstalled'));
    expect(install.available()).toBe(false);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: INSTALL_COPY.installed, tone: 'success' }));
  });

  it('opens the Add to Home Screen steps on iOS', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(SAFARI_IPHONE);
    const { install, open } = setup();
    expect(install.ios).toBe(true);
    expect(install.available()).toBe(true);
    await expect(install.install()).resolves.toBe('instructions');
    expect(open).toHaveBeenCalledWith(expect.anything(), { data: { sheet: expect.any(Boolean) } });
  });

  it('has nothing to do without a prompt elsewhere', async () => {
    const { install, open } = setup();
    await expect(install.install()).resolves.toBe('unavailable');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('isIos', () => {
  it('knows iPhones, and iPads that say they are a Mac', () => {
    expect(isIos({ userAgent: SAFARI_IPHONE, maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: CHROME_MAC, maxTouchPoints: 5, platform: 'MacIntel' })).toBe(true);
    expect(isIos({ userAgent: CHROME_MAC, maxTouchPoints: 0, platform: 'MacIntel' })).toBe(false);
  });
});

describe('isStandalone', () => {
  it('is true in the installed app', () => {
    const view = { matchMedia: () => ({ matches: true }), navigator: {} } as unknown as Window;
    expect(isStandalone(view)).toBe(true);
    const safari = { matchMedia: () => ({ matches: false }), navigator: { standalone: true } } as unknown as Window;
    expect(isStandalone(safari)).toBe(true);
    expect(isStandalone(null)).toBe(false);
  });
});
