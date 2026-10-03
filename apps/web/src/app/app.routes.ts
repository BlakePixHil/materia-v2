import { Route } from '@angular/router';

// Every feature is lazily loaded (ADR-002). FND-12 adds the app shell and feature routes.
export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'health' },
  {
    path: 'health',
    title: 'Health · Materia',
    loadComponent: () => import('./health/health').then((m) => m.HealthPage),
  },
];
