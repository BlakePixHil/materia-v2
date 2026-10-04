import { Route } from '@angular/router';

import { authGuard, mfaGuard, orgScopedGuard, signedOutGuard, unverifiedGuard } from './core/auth/guards';
import { flagGuard } from './core/flags/flag';
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
          path: '__dev/flags',
          title: 'Feature flags',
          loadComponent: () => import('./dev/flags-page').then((m) => m.FlagsDevPage),
        },
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
  {
    path: '',
    pathMatch: 'full',
    title: 'Matters',
    loadComponent: () => import('./features/matters/matters-page').then((m) => m.MattersPage),
  },
  planned('new', 'New matter', {
    ticket: 'CORE-05',
    icon: 'matters',
    description: 'Matter intake: the client, the deceased or testator, conflicts and costs disclosure.',
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
  // Behind the litigation flag until LIT-01 ships (FND-23).
  planned(
    'disputes',
    'Disputes',
    { ticket: 'LIT-02', icon: 'scale', description: 'Contested estates and family provision claims.' },
    { canActivate: [flagGuard('litigation.enabled')] },
  ),
  {
    path: 'contacts',
    title: 'Contacts',
    loadComponent: () => import('./features/contacts/contacts-page').then((m) => m.ContactsPage),
  },
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
      {
        path: 'team',
        title: 'Team',
        data: { crumb: 'Team' },
        loadComponent: () => import('./pages/orgs/team').then((m) => m.TeamPage),
      },
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
      {
        path: 'sign-in',
        title: 'Sign in',
        canActivate: [signedOutGuard],
        loadComponent: () => import('./pages/auth/sign-in').then((m) => m.SignInPage),
      },
      {
        path: 'sign-up',
        title: 'Create your account',
        canActivate: [signedOutGuard],
        loadComponent: () => import('./pages/auth/sign-up').then((m) => m.SignUpPage),
      },
      {
        path: 'verify-email',
        title: 'Confirm your email',
        canActivate: [unverifiedGuard],
        loadComponent: () => import('./pages/auth/verify-email').then((m) => m.VerifyEmailPage),
      },
      {
        path: 'forgot-password',
        title: 'Reset your password',
        loadComponent: () => import('./pages/auth/forgot-password').then((m) => m.ForgotPasswordPage),
      },
      // Email action links: verify email, reset password (any device, signed in or not).
      {
        path: 'action',
        title: 'Materia',
        loadComponent: () => import('./pages/auth/action').then((m) => m.AuthActionPage),
      },
      {
        path: 'mfa',
        title: 'Enter your code',
        loadComponent: () => import('./pages/auth/mfa-challenge').then((m) => m.MfaChallengePage),
      },
      {
        path: 'mfa/enrol',
        title: 'Set up two-step sign-in',
        canActivate: [authGuard],
        loadComponent: () => import('./pages/auth/mfa-enrol').then((m) => m.MfaEnrolPage),
      },
      {
        path: 'recover',
        title: 'Use a recovery code',
        loadComponent: () => import('./pages/auth/recover').then((m) => m.RecoverPage),
      },
      { path: '**', redirectTo: 'sign-in' },
    ],
  },
  {
    path: 'onboarding',
    loadComponent: minimalLayout,
    // Signed in and verified, with MFA where required. MIG-08 adds the import step.
    canActivate: [mfaGuard],
    children: [
      {
        path: '',
        title: 'Set up your practice',
        loadComponent: () => import('./pages/orgs/onboarding').then((m) => m.OnboardingPage),
      },
      { path: '**', redirectTo: '' },
    ],
  },
  // Invite links (FND-17): works signed out too; the page asks the person to sign in first.
  {
    path: 'invite/:id',
    loadComponent: minimalLayout,
    children: [
      {
        path: '',
        title: 'Join your practice',
        loadComponent: () => import('./pages/orgs/invite').then((m) => m.InvitePage),
      },
    ],
  },
  // The shell needs a signed-in, verified person with an active org (and MFA where required).
  {
    path: '',
    canMatch: [orgScopedGuard],
    loadComponent: () => import('./shell/app-shell').then((m) => m.AppShellComponent),
    children: shellRoutes,
  },
  { path: '**', title: 'Page not found', loadComponent: () => import('./pages/not-found').then((m) => m.NotFoundPage) },
];
