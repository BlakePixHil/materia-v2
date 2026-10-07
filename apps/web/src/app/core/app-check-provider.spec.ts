import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

import { OnDemandReCaptchaEnterpriseProvider } from './app-check-provider';

type Internals = Record<'initialize' | 'getToken', (...args: unknown[]) => unknown>;
const sdk = ReCaptchaEnterpriseProvider.prototype as unknown as Internals;

const recaptchaScripts = () => document.querySelectorAll('script[src*="recaptcha"]').length;

describe('OnDemandReCaptchaEnterpriseProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('relies on the two provider methods the App Check SDK calls', () => {
    // If an SDK upgrade renames them, App Check would skip this provider's versions: fail here instead.
    expect(typeof sdk.initialize).toBe('function');
    expect(typeof sdk.getToken).toBe('function');
    expect(new OnDemandReCaptchaEnterpriseProvider('site-key')).toBeInstanceOf(ReCaptchaEnterpriseProvider);
  });

  it('starts reCAPTCHA on the first token App Check asks for, not as App Check starts', async () => {
    const start = vi.spyOn(sdk, 'initialize').mockImplementation(() => undefined);
    const token = vi.spyOn(sdk, 'getToken').mockResolvedValue({ token: 't', expireTimeMillis: 1 });
    const provider = new OnDemandReCaptchaEnterpriseProvider('site-key') as unknown as Internals;
    const app = { name: 'test' };

    provider.initialize(app);
    expect(start).not.toHaveBeenCalled();

    await expect(provider.getToken()).resolves.toEqual({ token: 't', expireTimeMillis: 1 });
    await provider.getToken(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(app);
    expect(token.mock.calls).toEqual([[undefined], [true]]);
  });

  describe('with App Check', () => {
    let app: FirebaseApp;
    beforeEach(() => {
      app = initializeApp({ apiKey: 'x', appId: '1:1:web:1', projectId: 'demo-materia' }, `app-check-${Date.now()}`);
    });
    afterEach(async () => {
      document.querySelectorAll('script[src*="recaptcha"]').forEach((script) => script.remove());
      await deleteApp(app);
    });

    it('loads no reCAPTCHA script when App Check starts, where the SDK’s provider does', () => {
      initializeAppCheck(app, { provider: new OnDemandReCaptchaEnterpriseProvider('site-key') });
      expect(recaptchaScripts()).toBe(0);

      const other = initializeApp(app.options, `${app.name}-sdk`);
      initializeAppCheck(other, { provider: new ReCaptchaEnterpriseProvider('site-key') });
      expect(recaptchaScripts()).toBe(1);
      void deleteApp(other);
    });

    it('loads reCAPTCHA as soon as App Check wants a token it hasn’t saved', async () => {
      initializeAppCheck(app, {
        provider: new OnDemandReCaptchaEnterpriseProvider('site-key'),
        isTokenAutoRefreshEnabled: true,
      });
      await vi.waitFor(() => expect(recaptchaScripts()).toBe(1));
    });
  });
});
