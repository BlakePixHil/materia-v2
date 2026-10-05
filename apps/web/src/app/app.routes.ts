import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, Route, Router } from '@angular/router';

import { AuthState } from './core/auth/auth-state';
import { authGuard, mfaGuard, orgScopedGuard, roleGuard, signedOutGuard, unverifiedGuard } from './core/auth/guards';
import { flagGuard } from './core/flags/flag';
import { readLayout } from './features/matters/matters-layout';
import { SETTINGS_ADMIN_ROLES } from './features/settings/settings-nav';
import { unsavedChangesGuard } from './features/settings/unsaved-changes';
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
        {
          path: '__dev/mail',
          title: 'Dev mail',
          loadComponent: () => import('./dev/mail-page').then((m) => m.MailDevPage),
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

/** The matter tabs built so far (CORE-06, CORE-08, CORE-10, CORE-12, CORE-13, CORE-16); the others show a placeholder. */
const MATTER_TAB_PAGES: Record<string, Route['loadComponent']> = {
  overview: () => import('./features/matter-detail/matter-overview').then((m) => m.MatterOverview),
  tasks: () => import('./features/matter-detail/matter-tasks').then((m) => m.MatterTasks),
  deadlines: () => import('./features/deadlines/matter-deadlines').then((m) => m.MatterDeadlines),
  documents: () => import('./features/documents/matter-documents').then((m) => m.MatterDocuments),
  parties: () => import('./features/matter-detail/matter-parties').then((m) => m.MatterParties),
  estate: () => import('./features/estate/matter-estate').then((m) => m.MatterEstate),
  notes: () => import('./features/notes/matter-notes').then((m) => m.MatterNotes),
  activity: () => import('./features/matter-detail/matter-activity').then((m) => m.MatterActivityTab),
};

const matterRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Matters',
    // Opens the board when that's the layout the Matters page was last left on (CORE-04).
    canActivate: [
      (route: ActivatedRouteSnapshot) =>
        readLayout() === 'board'
          ? inject(Router).createUrlTree(['/matters', 'board'], { queryParams: route.queryParams })
          : true,
    ],
    loadComponent: () => import('./features/matters/matters-page').then((m) => m.MattersPage),
  },
  // The Matters board (CORE-04): the same page, filters and views, as a kanban.
  {
    path: 'board',
    title: 'Matters board',
    data: { layout: 'board' },
    loadComponent: () => import('./features/matters/matters-page').then((m) => m.MattersPage),
  },
  // New matter intake (CORE-05).
  {
    path: 'new',
    title: 'New matter',
    data: { crumb: 'New matter' },
    loadComponent: () => import('./features/intake/intake-page').then((m) => m.IntakePage),
  },
  {
    path: ':id',
    title: 'Matter',
    data: { matterRoute: true },
    loadComponent: () => import('./pages/matter-layout').then((m) => m.MatterLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      // `/matters/:id/:tab` (CORE-06): tabs without a page in MATTER_TAB_PAGES are placeholders
      // until their tickets. Each tab reads only its own collections while it's shown.
      ...MATTER_TABS.map((tab): Route => ({
        path: tab.path,
        // The overview is the matter itself (`Matter · M-2026-0142 · Materia`); other tabs add their name.
        ...(tab.path === 'overview' ? {} : { title: tab.label }),
        loadComponent: MATTER_TAB_PAGES[tab.path] ?? placeholder,
        data: {
          crumb: tab.label,
          embedded: true,
          placeholder: { heading: tab.label, ticket: tab.ticket } satisfies PlaceholderData,
        },
      })),
      // The conflict check (CORE-02): from the Matters list (one lead selected) or the matter's header.
      {
        path: 'conflicts',
        title: 'Conflict check',
        data: { crumb: 'Conflict check' },
        loadComponent: () => import('./features/conflicts/matter-conflicts-page').then((m) => m.MatterConflictsPage),
      },
      // A document's preview and details (CORE-12); `?page=N` opens a PDF at a page.
      {
        path: 'documents/:docId',
        title: 'Document',
        data: { crumb: 'Document' },
        loadComponent: () => import('./features/documents/document-page').then((m) => m.DocumentPage),
      },
      // Deep links to a tab that doesn't exist land on the overview.
      { path: '**', redirectTo: 'overview' },
    ],
  },
];

/** The shell's pages (FND-12). Every feature is lazily loaded (ADR-002). */
const shellRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'today' },
  // Today: what needs me, what's due this week, my tasks and recent matters (CORE-14).
  {
    path: 'today',
    title: 'Today',
    loadComponent: () => import('./features/today/today-page').then((m) => m.TodayPage),
  },
  // My tasks across matters, and personal tasks (CORE-08).
  {
    path: 'tasks',
    title: 'My tasks',
    data: { crumb: 'My tasks' },
    loadComponent: () => import('./features/tasks/tasks-page').then((m) => m.TasksPage),
  },
  // Every notification I get, with filters, keyboard triage and inline actions (CORE-22).
  {
    path: 'inbox',
    title: 'Inbox',
    loadComponent: () => import('./features/inbox/inbox-page').then((m) => m.InboxPage),
  },
  { path: 'matters', data: { crumb: 'Matters' }, children: matterRoutes },
  // Every upcoming deadline across the firm's matters, as a list or a month calendar (CORE-10).
  {
    path: 'deadlines',
    title: 'Deadlines',
    data: { crumb: 'Deadlines' },
    loadComponent: () => import('./features/deadlines/deadlines-page').then((m) => m.DeadlinesPage),
  },
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
  // The will safe custody register (CORE-17): original wills, where each is kept and its chain of custody.
  {
    path: 'safe-custody',
    data: { crumb: 'Safe custody' },
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Safe custody',
        loadComponent: () => import('./features/safe-custody/register-page').then((m) => m.SafeCustodyRegisterPage),
      },
      {
        path: 'stocktake',
        title: 'Stocktake',
        data: { crumb: 'Stocktake' },
        loadComponent: () => import('./features/safe-custody/stocktake-page').then((m) => m.SafeCustodyStocktakePage),
      },
      {
        path: ':id',
        title: 'Packet',
        data: { crumb: 'Packet' },
        loadComponent: () => import('./features/safe-custody/packet-page').then((m) => m.SafeCustodyPacketPage),
      },
    ],
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
  // Settings (CORE-21): a sidebar of pages. Everyone sees the team; owners and admins the rest.
  {
    path: 'settings',
    data: { crumb: 'Settings' },
    loadComponent: () => import('./features/settings/settings-layout').then((m) => m.SettingsLayout),
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: () => {
          const role = inject(AuthState).claims().role;
          return role === 'owner' || role === 'admin' ? 'practice' : 'team';
        },
      },
      {
        path: 'practice',
        title: 'Practice',
        data: { crumb: 'Practice' },
        canActivate: [roleGuard(SETTINGS_ADMIN_ROLES)],
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./features/settings/practice-page').then((m) => m.PracticeSettingsPage),
      },
      {
        path: 'team',
        title: 'Team and roles',
        data: { crumb: 'Team and roles' },
        loadComponent: () => import('./pages/orgs/team').then((m) => m.TeamPage),
      },
      {
        path: 'billing',
        title: 'Billing and rates',
        data: { crumb: 'Billing and rates' },
        canActivate: [roleGuard(SETTINGS_ADMIN_ROLES)],
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./features/settings/billing-page').then((m) => m.BillingSettingsPage),
      },
      // Matter numbering (CORE-21a): owners and admins (`org.settings`).
      {
        path: 'numbering',
        title: 'Matter numbering',
        data: { crumb: 'Matter numbering' },
        canActivate: [roleGuard(SETTINGS_ADMIN_ROLES)],
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./features/numbering/numbering-page').then((m) => m.NumberingPage),
      },
      // Matter templates (CORE-07): owners and admins (`org.settings`), while `templates.system` is on.
      {
        path: 'templates',
        data: { crumb: 'Templates' },
        canActivate: [flagGuard('templates.system'), roleGuard(SETTINGS_ADMIN_ROLES)],
        children: [
          {
            path: '',
            pathMatch: 'full',
            title: 'Matter templates',
            loadComponent: () => import('./features/templates/templates-page').then((m) => m.TemplatesPage),
          },
          {
            path: ':id',
            title: 'Edit template',
            data: { crumb: 'Edit' },
            loadComponent: () => import('./features/templates/template-editor-page').then((m) => m.TemplateEditorPage),
          },
        ],
      },
      // Clerk (AI-02a): the firm's own Anthropic key and model; owners and admins (`clerk.configure`).
      {
        path: 'clerk',
        title: 'Clerk',
        data: { crumb: 'Clerk' },
        canActivate: [roleGuard(['owner', 'admin'])],
        loadComponent: () => import('./features/clerk-settings/clerk-settings-page').then((m) => m.ClerkSettingsPage),
      },
      {
        path: 'audit',
        title: 'Audit log',
        data: { crumb: 'Audit log' },
        canActivate: [roleGuard(SETTINGS_ADMIN_ROLES)],
        loadComponent: () => import('./features/settings/audit-log-page').then((m) => m.AuditLogPage),
      },
      // Settings pages still to come (integrations INT-03, security SEC-04) land on the team page.
      { path: '**', redirectTo: 'team' },
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
