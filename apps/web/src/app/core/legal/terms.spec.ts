import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT, type SessionSecurity } from '@materia/data-access';
import { resolveSecurity, TERMS_VERSION, type Role } from '@materia/domain';

import { acceptTermsGuard, termsGuard, termsReturnUrl, TermsState } from './terms';
import { AUTH_PORT, type AuthSession } from '../auth/auth-port';
import { FakeAuthPort, testSession } from '../auth/testing';
import { FakeTenancyPort } from '../orgs/testing';

/** The terms gate (SEC-01): owners accept the current terms; nobody else is ever stopped. Fictional data only. */

@Component({ selector: 'mt-test-page', template: 'page' })
class TestPage {}

const session = (role: Role) =>
  testSession({ claims: { orgId: 'org-harbour-vine', role, orgName: 'Harbour & Vine Legal' } });

function security(termsAcceptedVersion: string | null | undefined): SessionSecurity {
  return {
    policy: resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60 }),
    validAfter: null,
    ...(termsAcceptedVersion === undefined ? {} : { termsAcceptedVersion }),
  };
}

interface Setup {
  session?: AuthSession | null;
  /** What the org document reports; null when it can't be read. */
  security?: SessionSecurity | null;
}

async function setup(options: Setup = {}) {
  const auth = new FakeAuthPort(options.session === undefined ? session('owner') : options.session);
  const tenancy = new FakeTenancyPort();
  tenancy.security_ = options.security === undefined ? security(null) : options.security;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'accept-terms', canActivate: [acceptTermsGuard], component: TestPage },
        { path: 'auth/sign-in', component: TestPage },
        {
          path: '',
          canActivate: [termsGuard],
          children: [
            { path: '', pathMatch: 'full', component: TestPage },
            { path: 'today', component: TestPage },
            { path: 'matters/:id', component: TestPage },
          ],
        },
      ]),
      { provide: AUTH_PORT, useValue: auth },
      { provide: TENANCY_PORT, useValue: tenancy },
    ],
  });
  const router = TestBed.inject(Router);
  const terms = TestBed.inject(TermsState);
  const go = async (url: string) => {
    await router.navigateByUrl(url);
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    return router.url;
  };
  return { auth, tenancy, router, terms, go };
}

describe('termsReturnUrl', () => {
  it('keeps same-site paths and drops anything else', () => {
    expect(termsReturnUrl('/matters/m-1/overview')).toBe('/matters/m-1/overview');
    expect(termsReturnUrl('/today?view=week')).toBe('/today?view=week');
    for (const bad of [null, undefined, '', 'https://example.com', '//example.com', '/accept-terms?x=1'])
      expect(termsReturnUrl(bad)).toBeNull();
  });
});

describe('the terms gate (SEC-01)', () => {
  it('sends an owner whose practice hasn’t accepted the terms to accept them, keeping where they were going', async () => {
    const t = await setup();
    expect(await t.go('/matters/m-1')).toBe('/accept-terms?returnUrl=%2Fmatters%2Fm-1');
    expect(t.terms.needed()).toBe(true);
    expect(await t.go('/')).toBe('/accept-terms');
  });

  it('asks again when the terms have a new version', async () => {
    const t = await setup({ security: security('0.0') });
    expect(await t.go('/today')).toBe('/accept-terms?returnUrl=%2Ftoday');
  });

  it('lets an owner through once the practice has accepted the current version', async () => {
    const t = await setup({ security: security(TERMS_VERSION) });
    expect(await t.go('/today')).toBe('/today');
    expect(t.terms.needed()).toBe(false);
    // The acceptance page is only for while it's needed.
    expect(await t.go('/accept-terms?returnUrl=%2Fmatters%2Fm-1')).toBe('/matters/m-1');
    expect(await t.go('/accept-terms?returnUrl=https%3A%2F%2Fexample.com')).toBe('/');
  });

  it.each<Role>(['admin', 'lawyer', 'paralegal', 'readonly'])('never stops a member with the %s role', async (role) => {
    const t = await setup({ session: session(role) });
    expect(await t.go('/today')).toBe('/today');
    expect(t.terms.needed()).toBe(false);
    expect(await t.go('/accept-terms')).toBe('/');
  });

  it('doesn’t block on an org document it can’t read, or one that doesn’t report the terms', async () => {
    const unreadable = await setup({ security: null });
    expect(await unreadable.go('/today')).toBe('/today');
    TestBed.resetTestingModule();
    const unknown = await setup({ security: security(undefined) });
    expect(await unknown.go('/today')).toBe('/today');
  });

  it('leaves people without an org to the shell’s other guard', async () => {
    const t = await setup({ session: testSession({ claims: {} }) });
    expect(await t.go('/today')).toBe('/today');
  });

  it('counts an acceptance made in this tab at once, for this org only', async () => {
    const t = await setup();
    expect(await t.go('/today')).toBe('/accept-terms?returnUrl=%2Ftoday');
    t.terms.markAccepted(TERMS_VERSION);
    expect(t.terms.needed()).toBe(false);
    expect(await t.go('/today')).toBe('/today');
    // Another practice the person owns still needs its own acceptance.
    t.auth.emit(testSession({ claims: { orgId: 'org-other', role: 'owner', orgName: 'Fictional Other Legal' } }));
    TestBed.tick();
    expect(t.terms.needed()).toBe(true);
  });

  it('notices the org document catching up', async () => {
    const t = await setup();
    expect(await t.go('/today')).toBe('/accept-terms?returnUrl=%2Ftoday');
    t.tenancy.emitSecurity(security(TERMS_VERSION));
    TestBed.tick();
    expect(t.terms.needed()).toBe(false);
  });
});
