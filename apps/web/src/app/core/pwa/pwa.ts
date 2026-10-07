import {
  DOCUMENT,
  EnvironmentProviders,
  inject,
  isDevMode,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { Router } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { AppUpdates } from './app-updates';
import { InstallPrompt } from './install-prompt';
import { OfflineCache } from './offline-cache';
import { ThemeColor } from './theme-color';
import { listenForPushTaps } from '../push/push-taps';

/**
 * The installable app (MOB-01, ADR-020): the service worker (`sw.js`, which wraps Angular's
 * `ngsw-worker.js`) in deployed and e2e builds, not `ng serve`; its updates; the install prompt;
 * the browser bar's colour; and taps on push notifications while the app is open (MOB-04).
 */
export function providePwa(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideServiceWorker('sw.js', {
      enabled: !isDevMode(),
      // Once the first page has settled (at most 30 s), so installing doesn't compete with it.
      registrationStrategy: 'registerWhenStable:30000',
      // Update checks always ask the server for sw.js and the scripts it imports.
      updateViaCache: 'none',
    }),
    provideAppInitializer(() => {
      inject(AppUpdates).start();
      inject(OfflineCache).start();
      // Listens for the install prompt from the start: Chrome fires it once, early.
      inject(InstallPrompt);
      inject(ThemeColor);
      listenForPushTaps(inject(Router), inject(DOCUMENT).defaultView);
    }),
  ]);
}
