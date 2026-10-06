import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import {
  claimsLookStale,
  forgetInvite,
  IS_ONLINE,
  OfflineError,
  OrgService,
  ORG_SWITCH_CLEANUP,
  PAGE_LOAD,
  pendingInvite,
  rememberInvite,
} from '../../core/orgs/org-service';
import { FakeTenancyPort } from '../../core/orgs/testing';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_ORG = testSession({ claims: {} });
const OWNER = testSession({ claims: { orgId: 'org-harbour-vine', role: 'owner', orgName: 'Harbour & Vine Legal' } });

interface Options {
  configure?: (port: FakeAuthPort, tenancy: FakeTenancyPort, firestore: InMemoryFirestore) => void;
  online?: boolean;
}

async function open(url: string, session: AuthSession | null, options: Options = {}) {
  const port = new FakeAuthPort(session);
  const tenancy = new FakeTenancyPort();
  const firestore = new InMemoryFirestore();
  options.configure?.(port, tenancy, firestore);
  const loads: string[] = [];
  const cleanups: string[] = [];
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: tenancy },
      provideInMemoryFirestore(firestore),
      { provide: PAGE_LOAD, useValue: (u: string) => loads.push(u) },
      { provide: IS_ONLINE, useValue: () => options.online ?? true },
      { provide: ORG_SWITCH_CLEANUP, useValue: [() => void cleanups.push('listeners')] },
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  const orgs = TestBed.inject(OrgService);
  await router.navigateByUrl(url);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle();
  };
  await stable();
  const input = (label: string) => {
    const host = [...el.querySelectorAll('mt-text-field, mt-select')].find((f) =>
      f.querySelector('label, .mt-label')?.textContent?.trim().startsWith(label),
    );
    const control = host?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
    if (!control) throw new Error(`No field "${label}"`);
    return control;
  };
  const type = async (label: string, value: string) => {
    const control = input(label) as HTMLInputElement;
    control.value = value;
    control.dispatchEvent(new Event('input'));
    await stable();
  };
  const choose = async (label: string, optionText: string) => {
    const select = input(label) as HTMLSelectElement;
    const option = [...select.options].find((o) => o.textContent?.trim() === optionText);
    if (!option) throw new Error(`No option "${optionText}"`);
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
    await stable();
  };
  const button = (text: string) => {
    const found = [...el.querySelectorAll<HTMLElement>('button, a')].find((b) =>
      b.textContent?.trim().startsWith(text),
    );
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  const click = async (text: string) => {
    button(text).click();
    await stable();
  };
  const submit = async () => {
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await stable();
  };
  return {
    port,
    tenancy,
    firestore,
    orgs,
    router,
    el,
    loads,
    cleanups,
    type,
    choose,
    click,
    submit,
    stable,
    text: () => el.textContent?.replace(/\s+/g, ' ') ?? '',
  };
}

afterEach(() => forgetInvite());

describe('onboarding', () => {
  it('creates the practice, refreshes the claims and opens Today', async () => {
    const page = await open('/onboarding', NO_ORG, {
      configure: (port) => {
        port.callResults['orgs-createOrg'] = { orgId: 'org-new' };
        port.refreshClaims = async () =>
          port.emit(testSession({ claims: { orgId: 'org-new', role: 'owner', orgName: 'Fictional Legal' } }));
      },
    });
    expect(page.text()).toContain('Set up your practice');
    await page.type('Practice name', 'Fictional Legal');
    await page.type('ABN', '123');
    await page.submit();
    expect(page.text()).toContain('An ABN is 11 digits.');
    expect(page.port.calls).toEqual([]);
    await page.type('ABN', '00 000 000 001');
    await page.choose('Primary jurisdiction', 'New South Wales');
    await page.choose('Time zone', 'Sydney');
    await page.submit();
    expect(page.port.calls[0]).toMatchObject({
      name: 'orgs-createOrg',
      data: {
        name: 'Fictional Legal',
        abn: '00 000 000 001',
        primaryJurisdiction: 'NSW',
        timezone: 'Australia/Sydney',
      },
    });
    expect((page.port.calls[0]?.data as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.router.url).toBe('/today');
    expect(TestBed.inject(OrgContext).orgId()).toBe('org-new');
  });

  it('shows server errors as copy', async () => {
    const page = await open('/onboarding', NO_ORG, {
      configure: (port) => {
        port.call = async () => {
          throw { details: { code: 'EMAIL_NOT_VERIFIED' } };
        };
      },
    });
    await page.type('Practice name', 'Fictional Legal');
    await page.submit();
    expect(page.text()).toContain('Confirm your email first');
  });

  it('offers a waiting invite', async () => {
    rememberInvite('/invite/inv-1?token=abc');
    const page = await open('/onboarding', NO_ORG);
    expect(page.text()).toContain('You have an invitation waiting');
  });
});

describe('invite page', () => {
  const URL = '/invite/inv-1?token=tok-123';

  it('signed out: sign in or create an account, and the link is remembered', async () => {
    const page = await open(URL, null);
    expect(page.text()).toContain('Sign in, or create an account');
    const signIn = page.el.querySelector<HTMLAnchorElement>('a[href^="/auth/sign-in"]');
    expect(decodeURIComponent(signIn?.getAttribute('href') ?? '')).toContain('returnUrl=/invite/inv-1?token=tok-123');
    expect(pendingInvite()).toBe('/invite/inv-1?token=tok-123');
  });

  it('unverified: confirm the email first', async () => {
    const page = await open(URL, testSession({ claims: {}, emailVerified: false }));
    expect(page.text()).toContain('Confirm your email first');
  });

  it('accepts, refreshes the claims and opens Today', async () => {
    const page = await open(URL, NO_ORG, {
      configure: (port) => {
        port.callResults['orgs-acceptInvite'] = { orgId: 'org-harbour-vine', orgName: 'Harbour & Vine Legal' };
        port.refreshClaims = async () => port.emit(testSession());
      },
    });
    await page.click('Accept invitation');
    expect(page.port.calls[0]).toMatchObject({
      name: 'orgs-acceptInvite',
      data: { inviteId: 'inv-1', token: 'tok-123' },
    });
    expect(page.router.url).toBe('/today');
    expect(pendingInvite()).toBeNull();
  });

  it('an expired invite says to ask for a new one', async () => {
    const page = await open(URL, NO_ORG, {
      configure: (port) => {
        port.call = async () => {
          throw { details: { code: 'INVITE_EXPIRED' } };
        };
      },
    });
    await page.click('Accept invitation');
    expect(page.text()).toContain('This invite has expired. Ask for a new invite.');
    expect(page.el.querySelector('button.mt-btn[data-variant="primary"]')).toBeNull();
  });

  it('a link without a token is incomplete', async () => {
    const page = await open('/invite/inv-1', NO_ORG);
    expect(page.text()).toContain('This invite link is incomplete');
  });
});

describe('team page', () => {
  const members = [
    {
      uid: 'user-jordan',
      displayName: 'Jordan Price',
      email: 'jordan@example.test',
      initials: 'JP',
      role: 'owner',
      status: 'active',
      colour: '',
    },
    {
      uid: 'u-sam-1',
      displayName: 'Sam Lee',
      email: 'sam.one@example.test',
      initials: 'SL',
      role: 'paralegal',
      status: 'active',
      colour: '',
    },
    {
      uid: 'u-sam-2',
      displayName: 'Sam Lee',
      email: 'sam.two@example.test',
      initials: 'SL',
      role: 'readonly',
      status: 'suspended',
      colour: '',
    },
  ] as const;
  const ORG_MEMBERS = 'orgs/org-harbour-vine/members';
  const seedMembers = (firestore: InMemoryFirestore) => {
    for (const { uid, ...member } of members) firestore.set(`${ORG_MEMBERS}/${uid}`, member);
    firestore.set(`${ORG_MEMBERS}/u-gone`, { displayName: 'Gone Fictional', role: 'lawyer', status: 'removed' });
  };

  it('lists members with their emails (same names stay distinguishable) and pending invites', async () => {
    const page = await open('/settings/team', OWNER, {
      configure: (_port, tenancy, firestore) => {
        seedMembers(firestore);
        tenancy.invites_ = [
          { id: 'inv-9', email: 'new@example.test', role: 'lawyer', expiresAt: new Date(Date.now() + 86_400_000) },
        ];
      },
    });
    expect(page.text()).toContain('Jordan Price (you)');
    expect(page.text()).toContain('sam.one@example.test · Paralegal');
    expect(page.text()).toContain('sam.two@example.test · Read-only · Suspended');
    expect(page.text()).toContain('new@example.test');
    expect(page.text()).not.toContain('Gone Fictional');
  });

  it('follows member changes live, without a reload', async () => {
    const page = await open('/settings/team', OWNER, { configure: (_p, _t, firestore) => seedMembers(firestore) });
    const sam: Record<string, unknown> = { ...members[1] };
    delete sam['uid'];
    page.firestore.set(`${ORG_MEMBERS}/u-sam-1`, { ...sam, role: 'admin' });
    page.firestore.set(`${ORG_MEMBERS}/u-new`, { displayName: 'Bea Fictional', role: 'lawyer', status: 'active' });
    await page.stable();
    expect(page.text()).toContain('sam.one@example.test · Admin');
    expect(page.text()).toContain('Bea Fictional');
  });

  it('shows the loading, empty, error and offline states', async () => {
    const loading = await open('/settings/team', OWNER, {
      configure: (_p, _t, firestore) => {
        firestore.stalled = true;
      },
    });
    expect(loading.text()).toContain('Loading members…');
    TestBed.resetTestingModule();

    const empty = await open('/settings/team', OWNER);
    expect(empty.text()).toContain('No members yet.');
    TestBed.resetTestingModule();

    const failing = await open('/settings/team', OWNER, {
      configure: (_p, _t, firestore) => {
        seedMembers(firestore);
        firestore.failNext({ code: 'unavailable' }, 'members');
      },
    });
    expect(failing.text()).toContain('This service is temporarily unavailable');
    await failing.click('Try again');
    expect(failing.text()).toContain('Jordan Price (you)');
    TestBed.resetTestingModule();

    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const offline = await open('/settings/team', OWNER, {
        configure: (_p, _t, firestore) => {
          seedMembers(firestore);
          firestore.offline = true;
        },
      });
      expect(offline.text()).toContain('You’re offline. This is the team as it was when you were last connected.');
      expect(offline.text()).toContain('Jordan Price (you)');
    } finally {
      onLine.mockRestore();
    }
  });

  it('pages through members and offers new ones above the first page', async () => {
    const page = await open('/settings/team', OWNER, {
      configure: (_p, _t, firestore) => {
        for (let i = 10; i < 40; i++) {
          firestore.set(`${ORG_MEMBERS}/u${i}`, { displayName: `Member ${i}`, role: 'lawyer', status: 'active' });
        }
      },
    });
    expect(page.el.querySelectorAll('mt-settings-row').length).toBe(25);
    await page.click('Show more members');
    expect(page.el.querySelectorAll('mt-settings-row').length).toBe(30);
    page.firestore.set(`${ORG_MEMBERS}/u-a`, { displayName: 'Aaron Fictional', role: 'lawyer', status: 'active' });
    await page.stable();
    expect(page.text()).not.toContain('Aaron Fictional');
    await page.click('1 new member');
    expect(page.text()).toContain('Aaron Fictional');
  });

  it('invites, changes a role, removes after confirming, resends and revokes', async () => {
    const page = await open('/settings/team', OWNER, {
      configure: (port, tenancy, firestore) => {
        seedMembers(firestore);
        tenancy.invites_ = [{ id: 'inv-9', email: 'new@example.test', role: 'lawyer', expiresAt: new Date(0) }];
        port.callResults['orgs-inviteMember'] = { inviteId: 'inv-10', emailed: true };
      },
    });
    expect(page.text()).toContain('Expired');
    await page.type('Email', 'person@example.test');
    await page.choose('Role', 'Admin');
    await page.submit();
    expect(page.port.calls.at(-1)).toMatchObject({
      name: 'orgs-inviteMember',
      data: { email: 'person@example.test', role: 'admin' },
    });

    await page.choose('Role for Sam Lee', 'Lawyer');
    expect(page.port.calls.at(-1)).toMatchObject({ name: 'orgs-changeRole', data: { uid: 'u-sam-1', role: 'lawyer' } });

    await page.click('Remove');
    expect(page.port.calls.at(-1)?.name).toBe('orgs-changeRole');
    await page.click('Confirm removal');
    expect(page.port.calls.at(-1)).toMatchObject({ name: 'orgs-removeMember', data: { uid: 'u-sam-1' } });

    await page.click('Resend');
    expect(page.port.calls.at(-1)).toMatchObject({ name: 'orgs-resendInvite', data: { inviteId: 'inv-9' } });
    await page.click('Revoke');
    expect(page.port.calls.at(-1)).toMatchObject({ name: 'orgs-revokeInvite', data: { inviteId: 'inv-9' } });
  });

  it('shows the last-owner error', async () => {
    const page = await open('/settings/team', OWNER, {
      configure: (port, _tenancy, firestore) => {
        seedMembers(firestore);
        port.call = async () => {
          throw { details: { code: 'LAST_OWNER' } };
        };
      },
    });
    await page.click('Remove');
    await page.click('Confirm removal');
    expect(page.text()).toContain('A practice needs at least one owner');
  });

  it('is read-only for roles without members.manage', async () => {
    const page = await open('/settings/team', testSession(), {
      configure: (_port, _tenancy, firestore) => seedMembers(firestore),
    });
    expect(page.text()).not.toContain('Invite someone');
    expect(page.el.querySelector('mt-select')).toBeNull();
    expect(page.text()).toContain('Owner');
    expect(page.text()).not.toContain('Suspend…');
    expect(page.text()).not.toContain('Reinstate');
    expect(page.text()).not.toContain('Transfer ownership');
  });

  describe('suspending, reinstating and transferring ownership (FND-17)', () => {
    const ADMIN = testSession({
      uid: 'u-admin',
      claims: { orgId: 'org-harbour-vine', role: 'admin', orgName: 'Harbour & Vine Legal' },
    });
    const row = (page: { el: HTMLElement }, email: string) =>
      page.el.querySelector<HTMLElement>(`[data-member="${email}"]`) ?? undefined;
    const buttonIn = (root: ParentNode | undefined | null, text: string) => {
      const found = [...(root ?? document.body).querySelectorAll<HTMLElement>('button')].find((b) =>
        b.textContent?.trim().startsWith(text),
      );
      if (!found) throw new Error(`No button "${text}"`);
      return found;
    };
    const dialog = () => document.body.querySelector<HTMLElement>('.mt-dialog');
    const bodyText = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
    const clickIn = async (
      page: { stable: () => Promise<void> },
      root: ParentNode | undefined | null,
      text: string,
    ) => {
      buttonIn(root, text).click();
      await page.stable();
    };

    afterEach(() => {
      for (const node of document.body.querySelectorAll('.mt-modal-root')) node.remove();
    });

    it('suspends a member only after the confirmation, which explains what happens', async () => {
      const page = await open('/settings/team', OWNER, { configure: (_p, _t, firestore) => seedMembers(firestore) });
      const sam = row(page, 'sam.one@example.test');
      expect(buttonIn(sam, 'Suspend…').getAttribute('aria-label')).toBe('Suspend Sam Lee');

      await clickIn(page, sam, 'Suspend…');
      expect(dialog()?.textContent).toContain('Suspend Sam Lee?');
      expect(dialog()?.textContent).toContain('loses access to the practice straight away');
      await clickIn(page, dialog(), 'Cancel');
      expect(page.port.calls.some((c) => c.name === 'orgs-suspendMember')).toBe(false);

      await clickIn(page, sam, 'Suspend…');
      await clickIn(page, dialog(), 'Suspend member');
      expect(page.port.calls.at(-1)).toMatchObject({
        name: 'orgs-suspendMember',
        data: { uid: 'u-sam-1', suspended: true, requestId: expect.any(String) },
      });
      expect(bodyText()).toContain('Sam Lee suspended');
    });

    it('reinstates a suspended member, who has no suspend or transfer actions', async () => {
      const page = await open('/settings/team', OWNER, { configure: (_p, _t, firestore) => seedMembers(firestore) });
      const suspended = row(page, 'sam.two@example.test');
      expect(suspended?.textContent).not.toContain('Suspend…');
      expect(suspended?.textContent).not.toContain('Transfer ownership');

      await clickIn(page, suspended, 'Reinstate');
      expect(page.port.calls.at(-1)).toMatchObject({
        name: 'orgs-suspendMember',
        data: { uid: 'u-sam-2', suspended: false },
      });
      expect(bodyText()).toContain('Sam Lee reinstated');
    });

    it('transfers ownership to an active member after the confirmation, and refreshes the claims', async () => {
      const page = await open('/settings/team', OWNER, { configure: (_p, _t, firestore) => seedMembers(firestore) });
      // Not to themselves, to someone suspended, or to someone who is an owner already.
      expect(row(page, 'jordan@example.test')?.textContent).not.toContain('Transfer ownership');
      const sam = row(page, 'sam.one@example.test');
      expect(buttonIn(sam, 'Transfer ownership…').getAttribute('aria-label')).toBe('Transfer ownership to Sam Lee');
      const refresh = vi.spyOn(page.port, 'refreshClaims');

      await clickIn(page, sam, 'Transfer ownership…');
      expect(dialog()?.textContent).toContain('Make Sam Lee the owner?');
      expect(dialog()?.textContent).toContain('You become an admin');
      await clickIn(page, dialog(), 'Transfer ownership');
      expect(page.port.calls.at(-1)).toMatchObject({ name: 'orgs-transferOwnership', data: { toUid: 'u-sam-1' } });
      expect(refresh).toHaveBeenCalled();
      expect(bodyText()).toContain('Sam Lee is now the owner');
    });

    it('asks the person to confirm it’s them first when their sign-in is old', async () => {
      const stale = testSession({ ...OWNER, authTime: Date.now() - 10 * 60_000 });
      const page = await open('/settings/team', stale, { configure: (_p, _t, firestore) => seedMembers(firestore) });
      await clickIn(page, row(page, 'sam.one@example.test'), 'Suspend…');
      await clickIn(page, dialog(), 'Suspend member');
      await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm it’s you'));
      expect(dialog()?.textContent).toContain('Suspending someone needs a fresh sign-in.');
      expect(page.port.calls.some((c) => c.name === 'orgs-suspendMember')).toBe(false);

      const password = dialog()?.querySelector<HTMLInputElement>('input[type="password"]');
      if (!password) throw new Error('No password field');
      password.value = 'password';
      password.dispatchEvent(new Event('input'));
      await page.stable();
      await clickIn(page, dialog(), 'Confirm');
      await vi.waitFor(() =>
        expect(page.port.calls.at(-1)).toMatchObject({ name: 'orgs-suspendMember', data: { uid: 'u-sam-1' } }),
      );
      expect(bodyText()).toContain('Sam Lee suspended');
    });

    it('shows the error copy and no toast when the change fails', async () => {
      const page = await open('/settings/team', OWNER, {
        configure: (port, _tenancy, firestore) => {
          seedMembers(firestore);
          port.call = async () => {
            throw { details: { code: 'LAST_OWNER' } };
          };
        },
      });
      await clickIn(page, row(page, 'sam.one@example.test'), 'Suspend…');
      await clickIn(page, dialog(), 'Suspend member');
      expect(page.text()).toContain('A practice needs at least one owner');
      expect(bodyText()).not.toContain('Sam Lee suspended');
    });

    it('lets admins suspend people below owner, but not owners, and never transfer ownership', async () => {
      const page = await open('/settings/team', ADMIN, { configure: (_p, _t, firestore) => seedMembers(firestore) });
      expect(row(page, 'jordan@example.test')?.textContent).not.toContain('Suspend…');
      expect(row(page, 'sam.one@example.test')?.textContent).toContain('Suspend…');
      expect(row(page, 'sam.two@example.test')?.textContent).toContain('Reinstate');
      expect(page.text()).not.toContain('Transfer ownership');
    });
  });
});

describe('org switcher and claims', () => {
  const tenancy = (claimsVersion: number, activeOrgId = 'org-harbour-vine') => ({
    claimsVersion,
    activeOrgId,
    memberships: {
      'org-harbour-vine': { role: 'lawyer' as const, name: 'Harbour & Vine Legal' },
      'org-bay': { role: 'owner' as const, name: 'Bayside Fictional Partners' },
    },
  });

  it('lists every membership and switches with clean-up and a fresh page', async () => {
    const page = await open('/today', testSession());
    page.tenancy.emit(tenancy(1));
    await page.stable();
    expect(page.orgs.orgs().map((o) => [o.name, o.active])).toEqual([
      ['Bayside Fictional Partners', false],
      ['Harbour & Vine Legal', true],
    ]);
    page.el.querySelector<HTMLButtonElement>('button[aria-label="Switch organisation"]')?.click();
    await page.stable();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) =>
      i.textContent?.includes('Bayside'),
    );
    item?.click();
    await page.stable();
    expect(page.port.calls.at(-1)).toMatchObject({ name: 'orgs-switchActiveOrg', data: { orgId: 'org-bay' } });
    expect(page.cleanups).toEqual(['listeners']);
    expect(page.loads).toEqual(['/today']);
  });

  it('blocks a switch while offline', async () => {
    const page = await open('/today', testSession(), { online: false });
    await expect(page.orgs.switchOrg('org-bay')).rejects.toBeInstanceOf(OfflineError);
    expect(page.port.calls).toEqual([]);
  });

  it('refreshes the token when claimsVersion changes, or when the first snapshot disagrees with the token', async () => {
    let refreshes = 0;
    const page = await open('/today', testSession(), {
      configure: (port) => {
        port.refreshClaims = async () => void refreshes++;
      },
    });
    expect(page.tenancy.watching).toBe('user-jordan');
    page.tenancy.emit(tenancy(1));
    expect(refreshes).toBe(0);
    page.tenancy.emit(tenancy(1));
    expect(refreshes).toBe(0);
    page.tenancy.emit(tenancy(2));
    expect(refreshes).toBe(1);
  });

  it('claimsLookStale compares the active org and role', () => {
    const t = tenancy(1);
    expect(claimsLookStale(t, { orgId: 'org-harbour-vine', role: 'lawyer' })).toBe(false);
    expect(claimsLookStale(t, { orgId: 'org-harbour-vine', role: 'admin' })).toBe(true);
    expect(claimsLookStale(t, { orgId: 'org-bay', role: 'owner' })).toBe(true);
    expect(claimsLookStale({ ...t, activeOrgId: null }, {})).toBe(false);
  });
});
