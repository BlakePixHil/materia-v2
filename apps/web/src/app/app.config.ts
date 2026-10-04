import {
  ApplicationConfig,
  ErrorHandler,
  inject,
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
import { GlobalErrorHandler } from './core/error-handler';
import { OrgService } from './core/orgs/org-service';
import { MateriaTitleStrategy } from './core/title-strategy';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Zoneless change detection (ADR-002). Do not add zone.js or libraries that depend on it.
    provideZonelessChangeDetection(),
    provideRouter(appRoutes),
    // `Matter · M-2026-0142 · Materia` (FND-12).
    { provide: TitleStrategy, useClass: MateriaTitleStrategy },
    // A toast and a report for unexpected errors (FND-12; FND-21 adds the reporter).
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    // Starts following the theme preference and prefers-color-scheme (FND-07).
    provideAppInitializer(() => {
      inject(ThemeService);
    }),
    // The data layer (FND-19): the full Firestore SDK loads lazily, on the first signed-in read.
    {
      provide: FIREBASE_SETUP,
      useValue: {
        app: () =>
          import('firebase/app').then((m) => (m.getApps().length ? m.getApp() : m.initializeApp(environment.firebase))),
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
