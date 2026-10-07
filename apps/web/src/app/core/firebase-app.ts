import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck } from 'firebase/app-check';

import { OnDemandReCaptchaEnterpriseProvider } from './app-check-provider';
import { environment } from '../../environments/environment';

/**
 * The Firebase app, created once. Deployed builds also start App Check (FND-22): callables reject
 * calls without an App Check token. reCAPTCHA loads only when App Check needs a new token
 * (`OnDemandReCaptchaEnterpriseProvider`). The emulators have no App Check provider, so local and
 * e2e builds skip it. Import this lazily, like the rest of the Firebase SDK.
 */
export function firebaseApp(): FirebaseApp {
  if (getApps().length) return getApp();
  const app = initializeApp(environment.firebase);
  const siteKey = (environment as { appCheckSiteKey?: string }).appCheckSiteKey;
  if (siteKey && !environment.useEmulators)
    initializeAppCheck(app, {
      provider: new OnDemandReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  return app;
}
