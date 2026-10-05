import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { resolveSecurity, type OrgSecurity } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { PAGE_LOAD } from '../../core/orgs/org-service';
import { FakeTenancyPort } from '../../core/orgs/testing';

/** Settings → Security (SEC-04), against the in-memory Firestore and fake callables. A fictional practice only. */

const ORG = 'org-harbour-vine';
const claims = (role: 'owner' | 'admin' | 'lawyer') => ({ orgId: ORG, role, orgName: 'Harbour & Vine Legal' });
const NOW = Date.now();
const OWNER = testSession({ claims: claims('owner'), authTime: NOW });
const LAWYER = testSession({ uid: 'u-sam', claims: claims('lawyer'), authTime: NOW });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};

function signIn(uid: string, at: number, extra: Record<string, unknown> = {}) {
  return {
    at: new Date(at),
    authTime: Math.floor(at / 1000),
    provider: 'password',
    device: 'Mac',
    browser: 'Safari',
    secondFactor: false,
    expireAt: new Date(at + 90 * 86_400_000),
    ...meta,
    createdBy: uid,
    ...extra,
  };
}

async function open(session: AuthSession, policy: Partial<OrgSecurity> = {}, validAfter: Date | null = null) {
  const port = new FakeAuthPort(session);
  const firestore = new InMemoryFirestore();
  const tenancy = new FakeTenancyPort();
  tenancy.security_ = {
    policy: resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60, ...policy }),
    validAfter,
  };
  const load = vi.fn();
  for (const [uid, role, name] of [
    ['user-jordan', 'owner', 'Jordan Price'],
    ['u-sam', 'lawyer', 'Sam Lee'],
    ['u-alex', 'admin', 'Alex Moore'],
  ] as const) {
    firestore.set(`orgs/${ORG}/members/${uid}`, {
      displayName: name,
      email: `${uid}@example.test`,
      role,
      status: 'active',
      ...meta,
    });
  }
  firestore.set(`users/${session.uid}/signIns/now`, signIn(session.uid, session.authTime));
  firestore.set(`users/${session.uid}/signIns/phone`, signIn(session.uid, NOW - 3_600_000, { device: 'iPhone' }));
  firestore.set(
    `users/${session.uid}/signIns/old`,
    signIn(session.uid, NOW - 30 * 86_400_000, { device: 'Windows PC', browser: 'Edge' }),
  );
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: tenancy },
      { provide: PAGE_LOAD, useValue: load },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle();
  };
  await router.navigateByUrl('/settings/security');
  await stable();
  const button = (text: string, root: ParentNode = document.body) => {
    const found = [...root.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim().startsWith(text));
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  const select = (name: string) => el.querySelector<HTMLSelectElement>(`mt-select[name="${name}"] select`);
  return {
    port,
    tenancy,
    load,
    router,
    el,
    stable,
    select,
    text: (root: Element | null = el) => root?.textContent?.replace(/\s+/g, ' ') ?? '',
    dialog: () => document.body.querySelector<HTMLElement>('.mt-dialog'),
    async choose(name: string, optionText: string) {
      const found = select(name);
      const option = [...(found?.options ?? [])].find((o) => o.textContent?.trim() === optionText);
      if (!found || !option) throw new Error(`No option "${optionText}" in ${name}`);
      found.value = option.value;
      found.dispatchEvent(new Event('change'));
      await stable();
    },
    async click(text: string, root?: ParentNode) {
      button(text, root).click();
      await stable();
    },
    callsTo: (name: string) => port.calls.filter((c) => c.name === name).map((c) => c.data as Record<string, unknown>),
  };
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('.mt-modal-root')) node.remove();
});

describe('Settings → Security (SEC-04)', () => {
  it('lets owners change the policy, each change saving at once', async () => {
    const page = await open(OWNER, { mfaRequired: true, mfaEnforceAfter: new Date(NOW + 86_400_000) });
    expect(page.text()).toContain('Require multi-factor authentication');
    expect(page.text()).toContain('Always on');
    expect(page.select('sessionIdleMinutes')?.selectedOptions[0]?.textContent?.trim()).toBe('1 hour');

    await page.choose('sessionIdleMinutes', '15 minutes');
    expect(page.callsTo('security-updatePolicy').at(-1)).toMatchObject({
      mfaRequired: true,
      sessionIdleMinutes: 15,
      maxSessionDays: 14,
      mfaGraceHours: 24,
      requestId: expect.any(String),
    });
    await page.choose('mfaGraceHours', '1 week');
    expect(page.callsTo('security-updatePolicy').at(-1)).toMatchObject({ mfaGraceHours: 168 });
    expect(page.text(document.body)).toContain('Security settings saved');
  });

  it('shows the policy read-only to everyone else, and no one else’s sessions', async () => {
    const page = await open(LAWYER, { sessionIdleMinutes: 30 });
    expect(page.select('sessionIdleMinutes')).toBeNull();
    expect(page.el.querySelector('[data-value="sessionIdleMinutes"]')?.textContent?.trim()).toBe('30 minutes');
    expect(page.el.querySelector('[data-value="mfaRequired"]')?.textContent?.trim()).toBe('Optional');
    expect(page.text()).not.toContain('Someone else’s sessions');
  });

  it('lists my sign-ins, newest first, marking this device and expired ones', async () => {
    const page = await open(OWNER);
    const rows = [...page.el.querySelectorAll('mt-settings-row')].map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '');
    const sessions = rows.filter((r) => r.includes('Signed in'));
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toContain('Mac · Safari');
    expect(sessions[0]).toContain('This device');
    expect(sessions[1]).toContain('iPhone · Safari');
    expect(sessions[1]).not.toMatch(/This device|Expired|Signed out/);
    expect(sessions[2]).toContain('Windows PC · Edge');
    expect(sessions[2]).toContain('Expired');
  });

  it('signs me out everywhere else, then has me confirm it’s me and reloads', async () => {
    const page = await open(OWNER);
    page.port.callResults['security-revokeSessions'] = { uid: OWNER.uid, validAfter: new Date().toISOString() };
    await page.click('Sign out everywhere else');
    await page.click('Sign out everywhere else', page.dialog() ?? undefined);
    await vi.waitFor(() => expect(page.text(page.dialog())).toContain('Confirm it’s you'));
    expect(page.callsTo('security-revokeSessions')).toEqual([{ requestId: expect.any(String) }]);
    const password = page.dialog()?.querySelector<HTMLInputElement>('input[type="password"]');
    if (!password) throw new Error('No password field');
    password.value = 'password';
    password.dispatchEvent(new Event('input'));
    await page.stable();
    await page.click('Confirm', page.dialog() ?? undefined);
    await vi.waitFor(() => expect(page.load).toHaveBeenCalledWith('/settings/security'));
  });

  it('lets an admin sign another member out, but not the owner', async () => {
    const page = await open(testSession({ uid: 'u-alex', claims: claims('admin'), authTime: NOW }));
    const people = [...(page.select('member')?.options ?? [])].map((o) => o.textContent?.trim());
    expect(people).toContain('Sam Lee');
    expect(people).not.toContain('Jordan Price');
    expect(people).not.toContain('Alex Moore');
    await page.choose('member', 'Sam Lee');
    await page.click('Sign out', page.el.querySelector('mt-settings-section:last-of-type') ?? undefined);
    expect(page.text(page.dialog())).toContain('Sign Sam Lee out everywhere?');
    await page.click('Sign out everywhere', page.dialog() ?? undefined);
    expect(page.callsTo('security-revokeSessions').at(-1)).toMatchObject({ uid: 'u-sam' });
    expect(page.text(document.body)).toContain('Sam Lee is signed out everywhere');
  });
});

describe('Signed out (SEC-04)', () => {
  it.each([
    ['idle', 'Signed out due to inactivity'],
    ['expired', 'sign in again'],
    ['revoked', 'signed out'],
    ['mfa', 'authenticator'],
  ])('explains a %s sign-out', async (reason, copy) => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes),
        { provide: AUTH_PORT, useValue: new FakeAuthPort(null) },
        { provide: TENANCY_PORT, useValue: new FakeTenancyPort() },
        provideInMemoryFirestore(new InMemoryFirestore()),
        ...provideTestFlags(),
      ],
    });
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl(`/auth/signed-out?reason=${reason}`);
    await fixture.whenStable();
    await settle();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text.toLowerCase()).toContain(copy.toLowerCase());
    expect(text).toContain('Sign in');
  });
});
