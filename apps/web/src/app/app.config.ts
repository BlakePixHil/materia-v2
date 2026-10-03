import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Zoneless change detection (ADR-002). Do not add zone.js or libraries that depend on it.
    provideZonelessChangeDetection(),
    provideRouter(appRoutes),
  ],
};
