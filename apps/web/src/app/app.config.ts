import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { ThemeService } from '@materia/ui';

import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Zoneless change detection (ADR-002). Do not add zone.js or libraries that depend on it.
    provideZonelessChangeDetection(),
    provideRouter(appRoutes),
    // Starts following the theme preference and prefers-color-scheme (FND-07).
    provideAppInitializer(() => {
      inject(ThemeService);
    }),
  ],
};
