import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  Injector,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, TitleStrategy, withPreloading } from '@angular/router';
import { provideInteractionsConfig } from 'ng-primitives/interactions';

import {
  ACCESS_REVOKED_HANDLER,
  countReads,
  createReadCounter,
  exposeReadCounter,
  FIREBASE_SETUP,
  FIRESTORE_SDK_LOADER,
  FirestoreClient,
  firestoreTenancyPort,
  ListenerRegistry,
  loadFirestoreSdk,
  TENANCY_PORT,
} from '@materia/data-access';
import { ThemeService } from '@materia/ui';

import { appRoutes } from './app.routes';
import { IdleTimeout } from './core/auth/idle-timeout';
import { SessionPolicy } from './core/auth/session-policy';
import { accessRevokedHandler, SessionWatcher } from './core/auth/session-watcher';
import { CALLABLES } from './core/data/callables';
import { ERROR_REPORTER, GlobalErrorHandler } from './core/error-handler';
import { FeatureFlagService } from './core/flags/feature-flags';
import { clientErrorReporter } from './core/observability/client-error-reporter';
import { startPerformanceMonitoring } from './core/observability/perf';
import { OrgService } from './core/orgs/org-service';
import { providePwa } from './core/pwa/pwa';
import { DelayedPreloading, prefetchPagesDuringGuards } from './core/routing/preloading';
import { MateriaTitleStrategy } from './core/title-strategy';
import { environment } from '../environments/environment';
import { RELEASE } from '../environments/version';
import { anyScansWaiting } from './features/scan/scan-db';

async function resumeScans(injector: Injector): Promise<void> {
  if (!(await anyScansWaiting())) return;
  const { ScanQueue } = await import('./features/scan/scan-queue');
  injector.get(ScanQueue);
}

/**
 * Set by the build (`define` in apps/web/project.json): true in development and e2e builds, false
 * in deployed ones, where the bundler drops the reads counter below.
 */
declare const MATERIA_READS_COUNTER: boolean | undefined;

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // When nothing can hover (a phone) ng-primitives skips hover tracking, which gives every button a
    // ResizeObserver and a style read as it renders: on a phone's Today that was ~30 ms of start-up.
    ...(globalThis.matchMedia?.('(any-hover: none)').matches ? provideInteractionsConfig({ hover: false }) : []),
    // Zoneless change detection (ADR-002). Do not add zone.js or libraries that depend on it.
    provideZonelessChangeDetection(),
    // Once a page is up, the other pages download in the background (one at a time), so opening
    // them later doesn't wait for their chunks.
    provideRouter(appRoutes, withPreloading(DelayedPreloading)),
    // A navigation's pages download while its guards wait for Auth and the org's policy.
    provideAppInitializer(prefetchPagesDuringGuards),
    // `Matter · M-2026-0142 · Materia` (FND-12).
    { provide: TitleStrategy, useClass: MateriaTitleStrategy },
    // A toast and a report for unexpected errors (FND-12).
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    // Unexpected errors go, scrubbed and batched, to system-logClientError (FND-21). The sender
    // (and the scrubber) load on the first error.
    {
      provide: ERROR_REPORTER,
      useFactory: () => {
        const injector = inject(Injector);
        return clientErrorReporter({
          version: `${RELEASE.version}+${RELEASE.sha}`,
          send: async (input) =>
            (await import('./core/observability/send-client-errors')).sendClientErrors(injector.get(CALLABLES), input),
        });
      },
    },
    // Performance Monitoring (FND-21): page load, Web Vitals and custom traces, in deployed builds
    // only, loaded once the app is idle.
    provideAppInitializer(() => {
      if (!environment.useEmulators) setTimeout(() => startPerformanceMonitoring(), 3000);
    }),
    // Starts following the theme preference and prefers-color-scheme (FND-07).
    provideAppInitializer(() => {
      inject(ThemeService);
    }),
    // The installable app (MOB-01): service worker, updates, install prompt, browser bar colour.
    providePwa(),
    // The data layer (FND-19): the full Firestore SDK loads lazily, on the first signed-in read.
    // Its download starts now, while Auth restores the session, instead of after it; Firestore
    // itself still starts on the first read.
    provideAppInitializer(() => {
      inject(FIRESTORE_SDK_LOADER)().catch(() => undefined);
    }),
    // SEC-07: development and e2e builds count Firestore reads per screen (`window.__materiaReads`,
    // read by apps/web-e2e/src/perf); deployed builds load the SDK as it is. The test stays inline:
    // behind a module constant the minifier kept the counter in once the providers above changed.
    ...(typeof MATERIA_READS_COUNTER !== 'undefined' && MATERIA_READS_COUNTER
      ? [
          {
            provide: FIRESTORE_SDK_LOADER,
            useFactory: () => {
              const counter = exposeReadCounter(createReadCounter());
              let counted: ReturnType<typeof loadFirestoreSdk> | undefined;
              return () => (counted ??= loadFirestoreSdk().then((sdk) => countReads(sdk, counter)));
            },
          },
        ]
      : []),
    {
      provide: FIREBASE_SETUP,
      useValue: {
        app: () => import('./core/firebase-app').then((m) => m.firebaseApp()),
        useEmulators: environment.useEmulators,
      },
    },
    // Tenancy reads (FND-17): a live users/{uid} listener, tracked by the listener registry.
    {
      provide: TENANCY_PORT,
      useFactory: () => firestoreTenancyPort(inject(FirestoreClient), inject(ListenerRegistry)),
    },
    // A live read refused after a role change goes to "no access" (FND-19).
    { provide: ACCESS_REVOKED_HANDLER, useFactory: accessRevokedHandler },
    // Feature flags (FND-23) start loading now, so flagged navigation and tabs are in place when
    // the shell draws instead of appearing after it.
    provideAppInitializer(() => {
      inject(FeatureFlagService);
    }),
    // Follows users/{uid} and refreshes the token when the claims change (FND-17).
    provideAppInitializer(() => {
      inject(OrgService);
    }),
    // Signs this tab out too when another tab signs out (FND-19).
    provideAppInitializer(() => {
      inject(SessionWatcher);
    }),
    // The org's security policy (SEC-04): MFA after the grace period, session length, remote
    // sign-out, and the inactivity sign-out across tabs.
    provideAppInitializer(() => {
      inject(SessionPolicy);
      inject(IdleTimeout);
    }),
    // Scans saved on this device without a connection (MOB-05) upload when it's back, after a
    // reload too. The queue loads only when a scan is waiting.
    provideAppInitializer(() => {
      const injector = inject(Injector);
      setTimeout(() => void resumeScans(injector).catch(() => undefined), 5000);
    }),
  ],
};
