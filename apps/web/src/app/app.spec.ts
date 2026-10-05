import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, type Route, Router, TitleStrategy } from '@angular/router';

import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { App } from './app';
import { appRoutes } from './app.routes';
import type { AuthSession } from './core/auth/auth-port';
import { provideFakeAuth, testSession } from './core/auth/testing';
import { GlobalErrorHandler } from './core/error-handler';
import { provideTestFlags } from './core/flags/testing';
import { MateriaTitleStrategy } from './core/title-strategy';
import { matterDoc, ORG } from './features/matter-detail/testing';

async function setup(
  url: string,
  session: AuthSession | null = testSession(),
  orgFlags: Record<string, unknown> = {},
  firestore?: InMemoryFirestore,
) {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: TitleStrategy, useClass: MateriaTitleStrategy },
      { provide: ErrorHandler, useClass: GlobalErrorHandler },
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      ...provideFakeAuth(session).providers,
      ...provideTestFlags({}, { 'org-harbour-vine': orgFlags }),
      ...(firestore ? [provideInMemoryFirestore(firestore)] : []),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const crumbs = () => [...el.querySelectorAll('.mt-crumbs li')].map((li) => li.textContent?.trim());
  return { fixture, router, el, title: () => TestBed.inject(Title).getTitle(), crumbs };
}

/** A fictional matter stored under its number, for the matter routes. */
function withMatter(): InMemoryFirestore {
  const firestore = new InMemoryFirestore();
  firestore.set(`orgs/${ORG}/matters/M-2026-0142`, matterDoc());
  return firestore;
}

function walk(routes: Route[], visit: (route: Route) => void): void {
  for (const route of routes) {
    visit(route);
    walk(route.children ?? [], visit);
  }
}

describe('app routes', () => {
  it('opens Today in the shell from the root path', async () => {
    const { router, el, title, crumbs } = await setup('/', testSession(), {}, new InMemoryFirestore());
    expect(router.url).toBe('/today');
    expect(title()).toBe('Today · Materia');
    // The Today screen (CORE-14) greets the person by name.
    expect(el.querySelector('h1')?.textContent?.trim()).toMatch(/^Good (morning|afternoon|evening), Jordan$/);
    expect(el.textContent).toContain('Needs attention');
    expect(el.textContent).toContain('Your week is clear');
    expect(crumbs()).toEqual(['Today']);
    const nav = [...el.querySelectorAll('aside nav a')].map((a) => a.textContent?.trim());
    // Disputes is behind the litigation flag (off by default).
    expect(nav).toEqual([
      'Today',
      'Inbox',
      'My tasks',
      'Matters',
      'Deadlines',
      'Contacts',
      'Safe custody',
      'Time & billing',
      'Insights',
      'Settings',
    ]);
    expect(el.querySelector('a[aria-current="page"]')?.textContent).toContain('Today');
  });

  it('keeps the health page outside the shell', async () => {
    const { el, title } = await setup('/health');
    expect(el.querySelector('[data-testid="health-status"]')?.textContent).toBe('OK');
    expect(el.querySelector('.mt-sidebar')).toBeNull();
    expect(title()).toBe('Health · Materia');
  });

  it.each([
    ['/inbox', 'Inbox', 'CORE-22'],
    ['/billing', 'Time & billing', 'BILL-03'],
    ['/insights', 'Insights', 'INS-02'],
    ['/settings/firm/people', 'Settings', 'CORE-21'],
  ])('%s is a placeholder for its ticket', async (url, heading, ticket) => {
    const { el, title } = await setup(url);
    expect(el.querySelector('h1')?.textContent).toContain(heading);
    expect(el.textContent).toContain(`Coming in ${ticket}`);
    expect(title()).toBe(`${heading} · Materia`);
  });

  it('/deadlines is the Deadlines screen (CORE-10)', async () => {
    const { el, title } = await setup('/deadlines');
    expect(el.querySelector('h1')?.textContent).toContain('Deadlines');
    expect(el.querySelector('mt-deadlines-page')).not.toBeNull();
    expect(el.textContent).not.toContain('Coming in CORE-10');
    expect(title()).toBe('Deadlines · Materia');
  });

  it('/matters/new is the new matter intake (CORE-05)', async () => {
    const { el, title } = await setup('/matters/new');
    expect(el.querySelector('h1')?.textContent).toContain('New matter');
    expect(el.textContent).not.toContain('Coming in CORE-05');
    expect(title()).toBe('New matter · Materia');
  });

  it('shows Disputes only while the litigation flag is on for the org', async () => {
    const off = await setup('/disputes');
    expect(off.router.url).toBe('/today');
    TestBed.resetTestingModule();
    const on = await setup('/disputes', testSession(), { 'litigation.enabled': true });
    expect(on.router.url).toBe('/disputes');
    expect(on.el.textContent).toContain('Coming in LIT-02');
    expect([...on.el.querySelectorAll('aside nav a')].map((a) => a.textContent?.trim())).toContain('Disputes');
  });

  it('titles a matter as "Matter · <number> · Materia" with breadcrumbs', async () => {
    const { router, title, crumbs, el } = await setup('/matters/M-2026-0142', testSession(), {}, withMatter());
    expect(router.url).toBe('/matters/M-2026-0142/overview');
    expect(title()).toBe('Matter · M-2026-0142 · Materia');
    expect(crumbs()).toEqual(['Matters', 'M-2026-0142', 'Overview']);
    expect(el.querySelector('.mt-crumbs a')?.getAttribute('href')).toBe('/matters');
    expect(el.querySelector('[mtTabNav] a[aria-current="page"]')?.textContent?.trim()).toBe('Overview');
  });

  it('adds the tab to the title on other matter tabs', async () => {
    const { title, crumbs, el } = await setup('/matters/M-2026-0142/documents', testSession(), {}, withMatter());
    expect(title()).toBe('Matter · M-2026-0142 · Documents · Materia');
    expect(crumbs()).toEqual(['Matters', 'M-2026-0142', 'Documents']);
    // The Documents tab itself (CORE-12), no longer a placeholder.
    expect(el.querySelector('mt-matter-documents h2')?.textContent?.trim()).toBe('Documents');
  });

  it('redirects an unknown matter tab to the overview', async () => {
    const { router, title } = await setup('/matters/M-2026-0142/bogus/deeper');
    expect(router.url).toBe('/matters/M-2026-0142/overview');
    expect(title()).toBe('Matter · M-2026-0142 · Materia');
  });

  it('shows 404 inside the shell for an unknown path', async () => {
    const { el, title } = await setup('/no-such-page');
    expect(title()).toBe('Page not found · Materia');
    expect(el.textContent).toContain("We couldn't find that page");
    expect(el.querySelector('.mt-sidebar')).not.toBeNull();
  });

  it('has a no-access page', async () => {
    const { el, title } = await setup('/no-access');
    expect(title()).toBe('No access · Materia');
    expect(el.textContent).toContain("You don't have access to this page");
  });

  it('uses the minimal layout for sign-in and onboarding', async () => {
    const auth = await setup('/auth/anything', null);
    expect(auth.router.url).toBe('/auth/sign-in');
    expect(auth.title()).toBe('Sign in · Materia');
    expect(auth.el.querySelector('.mt-minimal')).not.toBeNull();
    expect(auth.el.querySelector('.mt-sidebar')).toBeNull();
    TestBed.resetTestingModule();
    const onboarding = await setup('/onboarding', testSession({ claims: {} }));
    expect(onboarding.el.textContent).toContain('Set up your practice');
  });

  it('sends signed-out people to sign in, keeping where they were going', async () => {
    const { router } = await setup('/matters', null);
    expect(router.url).toBe('/auth/sign-in?returnUrl=%2Fmatters');
  });

  it('sends unverified password accounts to verify their email', async () => {
    const { router } = await setup('/today', testSession({ emailVerified: false }));
    expect(router.url).toBe('/auth/verify-email');
  });

  it('lets unverified Google accounts through (the provider verified them)', async () => {
    const { router } = await setup('/today', testSession({ emailVerified: false, providerIds: ['google.com'] }));
    expect(router.url).toBe('/today');
  });

  it('sends people without an org to onboarding', async () => {
    const { router, el } = await setup('/today', testSession({ claims: {} }));
    expect(router.url).toBe('/onboarding');
    expect(el.textContent).toContain('Create practice');
  });

  it('keeps signed-in people away from sign-in', async () => {
    const { router } = await setup('/auth/sign-in');
    expect(router.url).toBe('/today');
  });

  it('lazy-loads every page', () => {
    walk(appRoutes, (route) => {
      expect(route.component).toBeUndefined();
    });
  });
});
