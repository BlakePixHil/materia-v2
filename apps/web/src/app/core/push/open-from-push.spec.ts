import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT, type UserTenancy } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { DEFAULT_NOTIFICATION_PREFS } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { pushTarget } from './open-from-push';
import { PUSH_PLATFORM } from './push-platform';
import { PUSH_OPEN_MESSAGE, listenForPushTaps } from './push-taps';
import { fakePushPlatform } from './testing';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT } from '../auth/auth-port';
import { FakeAuthPort, testSession } from '../auth/testing';
import { provideTestFlags } from '../flags/testing';
import { PAGE_LOAD } from '../orgs/org-service';
import { FakeTenancyPort } from '../orgs/testing';

/**
 * Where a tapped push lands (MOB-04): `/open?to=…&org=…`, against the in-memory Firestore. A
 * fictional practice and people only.
 */

const ORG = 'org-harbour-vine';
const OTHER = 'org-cove-street';
const UID = 'user-jordan';
const SESSION = testSession({ claims: { orgId: ORG, role: 'lawyer', orgName: 'Harbour & Vine Legal' } });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};
const TENANCY: UserTenancy = {
  claimsVersion: 1,
  activeOrgId: ORG,
  memberships: {
    [ORG]: { role: 'lawyer', name: 'Harbour & Vine Legal' },
    [OTHER]: { role: 'lawyer', name: 'Cove Street Lawyers' },
  },
};

async function open(url: string) {
  const firestore = new InMemoryFirestore();
  firestore.set(`orgs/${ORG}`, { name: 'Harbour & Vine Legal', timezone: 'Australia/Melbourne', ...meta });
  firestore.set(`orgs/${ORG}/members/${UID}`, {
    role: 'lawyer',
    status: 'active',
    displayName: 'Jordan Price',
    ...meta,
  });
  firestore.set(`users/${UID}`, {
    email: 'lawyer@harbourvine.example',
    displayName: 'Jordan Price',
    orgIds: [ORG, OTHER],
    activeOrgId: ORG,
    prefs: { theme: 'system', density: 'comfortable', notifications: DEFAULT_NOTIFICATION_PREFS },
    ...meta,
  });
  const auth = new FakeAuthPort(SESSION);
  const tenancy = new FakeTenancyPort();
  const loads: string[] = [];
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: auth },
      { provide: TENANCY_PORT, useValue: tenancy },
      { provide: PAGE_LOAD, useValue: (to: string) => loads.push(to) },
      { provide: PUSH_PLATFORM, useValue: fakePushPlatform({ supportIs: 'unsupported' }) },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle();
  };
  void router.navigateByUrl(url);
  await stable();
  tenancy.emit(TENANCY);
  await stable();
  await settle(20);
  await stable();
  const dialogButton = (text: string) => {
    const found = [...document.body.querySelectorAll<HTMLElement>('.mt-modal-root button')].find(
      (b) => b.textContent?.trim() === text,
    );
    if (!found) throw new Error(`No dialog button "${text}"`);
    return found;
  };
  return {
    auth,
    loads,
    router,
    stable,
    body: () => document.body.textContent?.replace(/\s+/g, ' ') ?? '',
    async press(text: string) {
      dialogButton(text).click();
      await stable();
      await settle(20);
      await stable();
    },
  };
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('.mt-modal-root, .mt-toaster')) node.remove();
});

describe('pushTarget', () => {
  it('keeps app paths and sends anything else to Today', () => {
    expect(pushTarget('/matters/m-1/deadlines')).toBe('/matters/m-1/deadlines');
    for (const bad of [null, '', 'matters/m-1', '//evil.example', '/\\evil.example', 'https://evil.example/']) {
      expect(pushTarget(bad)).toBe('/today');
    }
  });
});

describe('/open', () => {
  it('opens a link in the active org straight away', async () => {
    const page = await open(`/open?to=${encodeURIComponent('/settings/preferences')}&org=${ORG}`);
    expect(page.router.url).toBe('/settings/preferences');
    expect(page.auth.calls.some((call) => call.name === 'orgs-switchActiveOrg')).toBe(false);
  });

  it('opens Today for a link that isn’t an app path', async () => {
    const page = await open(`/open?to=${encodeURIComponent('https://evil.example/')}`);
    expect(page.router.url).toBe('/today');
  });

  it('asks before switching to the push’s org, then reloads at its link', async () => {
    const page = await open(`/open?to=${encodeURIComponent('/matters/m-1/deadlines')}&org=${OTHER}`);
    expect(page.body()).toContain('Switch to Cove Street Lawyers?');
    expect(page.body()).toContain('You’re working in Harbour & Vine Legal.');
    await page.press('Switch to Cove Street Lawyers');
    expect(page.auth.calls).toContainEqual({
      name: 'orgs-switchActiveOrg',
      data: expect.objectContaining({ orgId: OTHER }),
    });
    expect(page.loads).toEqual(['/matters/m-1/deadlines']);
  });

  it('stays in the active org on Today when the person says no', async () => {
    const page = await open(`/open?to=${encodeURIComponent('/matters/m-1')}&org=${OTHER}`);
    await page.press('Stay here');
    expect(page.router.url).toBe('/today');
    expect(page.loads).toEqual([]);
  });

  it('goes to Today, with a note, for a practice the person has left', async () => {
    const page = await open(`/open?to=${encodeURIComponent('/matters/m-1')}&org=org-long-gone`);
    expect(page.router.url).toBe('/today');
    expect(page.body()).toContain('That notification is from a practice you’re no longer part of');
  });
});

describe('listenForPushTaps', () => {
  it('opens /open links the service worker posts, and nothing else', () => {
    const target = new EventTarget();
    const opened: string[] = [];
    listenForPushTaps({ navigateByUrl: async (url) => (opened.push(String(url)), true) }, {
      navigator: { serviceWorker: target },
    } as unknown as Window);
    const post = (data: unknown) => target.dispatchEvent(new MessageEvent('message', { data }));
    post({ type: PUSH_OPEN_MESSAGE, url: '/open?to=%2Fmatters%2Fm-1' });
    post({ type: PUSH_OPEN_MESSAGE, url: 'https://evil.example/' });
    post({ type: 'something-else', url: '/open?to=%2Ftoday' });
    post(null);
    expect(opened).toEqual(['/open?to=%2Fmatters%2Fm-1']);
  });
});
