import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, TitleStrategy } from '@angular/router';

import { ThemeService } from '@materia/ui';

import { appRoutes } from './app.routes';
import { GlobalErrorHandler } from './core/error-handler';
import { MateriaTitleStrategy } from './core/title-strategy';

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
  ],
};
