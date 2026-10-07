import type { FirebaseApp } from 'firebase/app';
import { ReCaptchaEnterpriseProvider } from 'firebase/app-check';

/** The two provider methods App Check calls, which its published types mark internal. */
interface ProviderInternals {
  initialize(app: FirebaseApp): void;
  getToken(isLimitedUse?: boolean): Promise<unknown>;
}

const recaptcha = ReCaptchaEnterpriseProvider.prototype as unknown as ProviderInternals;

/**
 * App Check's reCAPTCHA Enterprise provider, loading reCAPTCHA only when App Check needs a new
 * token (MOB-02b, ADR-056). The SDK's own provider loads and runs reCAPTCHA as App Check starts,
 * even when the token App Check saved last time is still valid. That's most start-ups, since tokens
 * last 12 hours and App Check renews them after about 6, and on a phone reCAPTCHA was the largest
 * single cost of opening Today. Tokens, their checks and their renewal are unchanged: App Check
 * calls `getToken` exactly when the SDK's provider would have run reCAPTCHA.
 */
export class OnDemandReCaptchaEnterpriseProvider extends ReCaptchaEnterpriseProvider {
  private appToStart?: FirebaseApp;
  private started = false;

  /** Called by `initializeAppCheck`: keeps the app instead of loading reCAPTCHA. */
  initialize(app: FirebaseApp): void {
    this.appToStart = app;
  }

  /** Called by App Check when it has no valid token: loads reCAPTCHA the first time, then asks it. */
  getToken(isLimitedUse?: boolean): Promise<unknown> {
    if (!this.started && this.appToStart) {
      this.started = true;
      recaptcha.initialize.call(this, this.appToStart);
    }
    return recaptcha.getToken.call(this, isLimitedUse);
  }
}
