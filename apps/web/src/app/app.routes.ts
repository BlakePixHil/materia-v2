import { Route } from '@angular/router';

declare const ngDevMode: unknown;

/**
 * Tools for development builds only. The Angular CLI sets `ngDevMode` to false in production
 * builds, so these routes and their chunks are dropped from production bundles.
 */
const devRoutes: Route[] =
  typeof ngDevMode === 'undefined' || ngDevMode
    ? [
        {
          path: '__dev/deadlines',
          title: 'Deadline lab · Materia',
          loadComponent: () => import('./dev/deadline-lab').then((m) => m.DeadlineLabPage),
        },
      ]
    : [];

// Every feature is lazily loaded (ADR-002). FND-12 adds the app shell and feature routes.
export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'health' },
  {
    path: 'health',
    title: 'Health · Materia',
    loadComponent: () => import('./health/health').then((m) => m.HealthPage),
  },
  ...devRoutes,
];
