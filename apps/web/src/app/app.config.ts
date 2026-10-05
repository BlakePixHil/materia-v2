import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  Injector,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, TitleStrategy } from '@angular/router';

import {
  ACCESS_REVOKED_HANDLER,
  FIREBASE_SETUP,
  FirestoreClient,
  firestoreTenancyPort,
  ListenerRegistry,
  TENANCY_PORT,
} from '@materia/data-access';
import { ThemeService } from '@materia/ui';

import { appRoutes } from './app.routes';
import { accessRevokedHandler, SessionWatcher } from './core/auth/session-watcher';
import { CALLABLES } from './core/data/callables';
import { ERROR_REPORTER, GlobalErrorHandler } from './core/error-handler';
import { clientErrorReporter } from './core/observability/client-error-reporter';
import { startPerformanceMonitoring } from './core/observability/perf';
import { OrgService } from './core/orgs/org-service';
import { MateriaTitleStrategy } from './core/title-strategy';
import { environment } from '../environments/environment';
import { RELEASE } from '../environments/version';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Zoneless change detection (ADR-002). Do not add zone.js or libraries that depend on it.
    provideZonelessChangeDetection(),
    provideRouter(appRoutes),
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
    // The data layer (FND-19): the full Firestore SDK loads lazily, on the first signed-in read.
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
    // Follows users/{uid} and refreshes the token when the claims change (FND-17).
    provideAppInitializer(() => {
      inject(OrgService);
    }),
    // Signs this tab out too when another tab signs out (FND-19).
    provideAppInitializer(() => {
      inject(SessionWatcher);
    }),
  ],
};
