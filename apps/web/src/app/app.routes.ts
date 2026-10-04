import { Route } from '@angular/router';

import { orgScopedGuard } from './core/auth/auth-state';
import { MATTER_TABS } from './pages/matter-tabs';
import type { PlaceholderData } from './pages/placeholder';

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
          title: 'Deadline lab',
          loadComponent: () => import('./dev/deadline-lab').then((m) => m.DeadlineLabPage),
        },
      ]
    : [];

const placeholder = () => import('./pages/placeholder').then((m) => m.PlaceholderPage);

/** A not-yet-built page: its title, heading and the ticket that builds it. */
function planned(
  path: string,
  title: string,
  data: Omit<PlaceholderData, 'heading'>,
  extra: Partial<Route> = {},
): Route {
  return { path, title, loadComponent: placeholder, data: { placeholder: { heading: title, ...data } }, ...extra };
}

const matterRoutes: Route[] = [
  planned('', 'Matters', {
    ticket: 'CORE-03',
    icon: 'matters',
    description: 'Every matter, with filters, saved views and the matter table.',
  }),
  {
    path: ':id',
    title: 'Matter',
    data: { matterRoute: true },
    loadComponent: () => import('./pages/matter-layout').then((m) => m.MatterLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      ...MATTER_TABS.map((tab): Route => ({
        path: tab.path,
        // The overview is the matter itself (`Matter · M-2026-0142 · Materia`); other tabs add their name.
        ...(tab.path === 'overview' ? {} : { title: tab.label }),
        loadComponent: placeholder,
        data: {
          crumb: tab.label,
          embedded: true,
          placeholder: { heading: tab.label, ticket: tab.ticket } satisfies PlaceholderData,
        },
      })),
      // Deep links to a tab that doesn't exist land on the overview.
      { path: '**', redirectTo: 'overview' },
    ],
  },
];

/** The shell's pages (FND-12). Every feature is lazily loaded (ADR-002). */
const shellRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'today' },
  planned('today', 'Today', {
    ticket: 'CORE-14',
    icon: 'today',
    description: "Your day: what's due, what changed and what Clerk suggests.",
  }),
  planned('inbox', 'Inbox', {
    ticket: 'CORE-22',
    icon: 'inbox',
    description: 'Mentions, assignments and replies that need you.',
  }),
  { path: 'matters', data: { crumb: 'Matters' }, children: matterRoutes },
  planned('deadlines', 'Deadlines', {
    ticket: 'CORE-10',
    icon: 'calendar',
    description: 'Every computed deadline across your matters, by due date.',
  }),
  planned('disputes', 'Disputes', {
    ticket: 'LIT-02',
    icon: 'scale',
    description: 'Contested estates and family provision claims.',
  }),
  planned('contacts', 'Contacts', {
    ticket: 'CORE-01',
    icon: 'contacts',
    description: 'Clients, beneficiaries, executors and other parties.',
  }),
  planned('billing', 'Time & billing', {
    ticket: 'BILL-03',
    icon: 'billing',
    description: 'Time entries, invoices and trust.',
  }),
  planned('insights', 'Insights', {
    ticket: 'INS-02',
    icon: 'insights',
    description: 'Workload, realisation and deadline health.',
  }),
  {
    path: 'settings',
    data: { crumb: 'Settings' },
    children: [
      planned('**', 'Settings', {
        ticket: 'CORE-21',
        icon: 'settings',
        description: 'Firm, people, billing rates and integrations.',
      }),
    ],
  },
  {
    path: 'no-access',
    title: 'No access',
    loadComponent: () => import('./pages/no-access').then((m) => m.NoAccessPage),
  },
  { path: '**', title: 'Page not found', loadComponent: () => import('./pages/not-found').then((m) => m.NotFoundPage) },
];

const minimalLayout = () => import('./pages/minimal-layout').then((m) => m.MinimalLayout);

export const appRoutes: Route[] = [
  {
    path: 'health',
    title: 'Health',
    loadComponent: () => import('./health/health').then((m) => m.HealthPage),
  },
  ...devRoutes,
  {
    path: 'auth',
    loadComponent: minimalLayout,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'sign-in' },
      planned('sign-in', 'Sign in', {
        ticket: 'FND-16',
        description: 'Sign in with your firm email, Google or Microsoft.',
      }),
      { path: '**', redirectTo: 'sign-in' },
    ],
  },
  {
    path: 'onboarding',
    loadComponent: minimalLayout,
    children: [
      planned('**', 'Set up your firm', {
        ticket: 'FND-17',
        description: 'Create your firm, invite your team and import matters.',
      }),
    ],
  },
  // The shell needs a signed-in person with an active org (stub AuthState until FND-16).
  {
    path: '',
    canMatch: [orgScopedGuard],
    loadComponent: () => import('./shell/app-shell').then((m) => m.AppShellComponent),
    children: shellRoutes,
  },
  { path: '**', title: 'Page not found', loadComponent: () => import('./pages/not-found').then((m) => m.NotFoundPage) },
];
