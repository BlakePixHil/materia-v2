import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { AVATAR_STORE } from './avatar-store';
import { NotificationMatrix } from './notification-matrix';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';
import { START_PAGE_STORAGE_KEY } from '../../core/profile/start-page';
import { PUSH_PLATFORM } from '../../core/push/push-platform';
import { fakePushPlatform, type FakePushPlatform } from '../../core/push/testing';

/**
 * Profile and preferences (CORE-20) against the in-memory Firestore: the notification matrix with
 * its locked rows, preferences that save and apply at once (and when another tab changes them),
 * the profile form, and the start page. A fictional practice and people only.
 */

const ORG = 'org-harbour-vine';
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
const userDoc = (prefs: Record<string, unknown> = {}) => ({
  email: 'lawyer@harbourvine.example',
  displayName: 'Jordan Price',
  firstName: 'Jordan',
  lastName: 'Price',
  orgIds: [ORG],
  activeOrgId: ORG,
  prefs: {
    theme: 'system',
    density: 'comfortable',
    shortcuts: true,
    notifications: DEFAULT_NOTIFICATION_PREFS,
    ...prefs,
  },
  ...meta,
});

describe('NotificationMatrix', () => {
  async function render(prefs: NotificationPrefs) {
    const fixture = TestBed.createComponent(NotificationMatrix);
    fixture.componentRef.setInput('prefs', prefs);
    const emitted: NotificationPrefs[] = [];
    fixture.componentInstance.changed.subscribe((next) => emitted.push(next));
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const box = (kind: string, channel: number) =>
      el.querySelectorAll<HTMLInputElement>(`tr[data-kind="${kind}"] input`)[channel] as HTMLInputElement;
    return { el, emitted, box };
  }

  it('shows each kind’s defaults, with deadline escalation email and in-app locked on', async () => {
    const { el, box } = await render(DEFAULT_NOTIFICATION_PREFS);
    expect(el.querySelectorAll('tbody tr').length).toBeGreaterThan(10);
    expect([box('mention', 0).checked, box('mention', 1).checked, box('mention', 2).checked]).toEqual([
      true,
      true,
      false,
    ]);
    for (const channel of [0, 1]) {
      expect(box('deadline_escalation', channel).checked).toBe(true);
      expect(box('deadline_escalation', channel).disabled).toBe(true);
    }
    // Push is off for everything until the person turns it on.
    expect(box('deadline_escalation', 2).disabled).toBe(true);
    expect(box('deadline_escalation', 1).getAttribute('aria-label')).toBe('Deadline escalations Email (always on)');
  });

  it('emits the new preferences when a cell changes', async () => {
    const { emitted, box } = await render(DEFAULT_NOTIFICATION_PREFS);
    box('mention', 1).checked = false;
    box('mention', 1).dispatchEvent(new Event('change'));
    expect(emitted.at(-1)?.kinds).toEqual({ mention: { email: false } });
  });

  it('disables a channel switched off for everything, except locked cells', async () => {
    const { box } = await render({ ...DEFAULT_NOTIFICATION_PREFS, email: false });
    expect(box('mention', 1).disabled).toBe(true);
    expect(box('mention', 1).checked).toBe(false);
    expect(box('deadline_escalation', 1).checked).toBe(true);
  });
});

async function open(
  url: string,
  seed: (firestore: InMemoryFirestore) => void = () => undefined,
  role: 'lawyer' | 'owner' = 'lawyer',
  push: FakePushPlatform = fakePushPlatform({ supportIs: 'unsupported' }),
) {
  const auth = new FakeAuthPort(role === 'lawyer' ? SESSION : testSession({ claims: { ...SESSION.claims, role } }));
  const firestore = new InMemoryFirestore();
  firestore.set(`orgs/${ORG}`, { name: 'Harbour & Vine Legal', timezone: 'Australia/Melbourne', ...meta });
  firestore.set(`orgs/${ORG}/members/${UID}`, {
    role,
    status: 'active',
    displayName: 'Jordan Price',
    initials: 'JP',
    title: 'Associate',
    colour: '#346CFC',
    defaultRateCents: 0,
    rates: [],
    budgets: {},
    ...meta,
  });
  firestore.set(`users/${UID}`, userDoc());
  seed(firestore);
  const uploads: Blob[] = [];
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: auth },
      { provide: TENANCY_PORT, useValue: new FakeTenancyPort() },
      { provide: PUSH_PLATFORM, useValue: push },
      {
        provide: AVATAR_STORE,
        useValue: {
          upload: async (_uid: string, png: Blob) => (uploads.push(png), 'https://example.test/avatar.png'),
          remove: async () => undefined,
        },
      },
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
  await router.navigateByUrl(url);
  await stable();
  const field = (label: string) => {
    const host = [...el.querySelectorAll('mt-text-field, mt-select')].find((f) =>
      f.querySelector('label, .mt-label')?.textContent?.trim().startsWith(label),
    );
    const found = host?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
    if (!found) throw new Error(`No field "${label}"`);
    return found;
  };
  const button = (text: string) => {
    // The page's own controls first: the shell's nav has a "Matters" link too.
    const page = el.querySelector('.settings-page') ?? el;
    const found = [...page.querySelectorAll<HTMLElement>('button, a')].find((b) => b.textContent?.trim() === text);
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  return {
    auth,
    push,
    firestore,
    router,
    el,
    stable,
    uploads,
    field,
    text: () => el.textContent?.replace(/\s+/g, ' ') ?? '',
    user: () => firestore.get(`users/${UID}`) as Record<string, unknown> & { prefs: Record<string, unknown> },
    async click(text: string) {
      button(text).click();
      await stable();
    },
    async type(label: string, value: string) {
      const input = field(label) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await stable();
    },
    async choose(label: string, optionText: string) {
      const select = field(label) as HTMLSelectElement;
      const option = [...select.options].find((o) => o.textContent?.trim() === optionText);
      if (!option) throw new Error(`No option "${optionText}"`);
      select.value = option.value;
      select.dispatchEvent(new Event('change'));
      await stable();
    },
  };
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('.mt-modal-root')) node.remove();
  try {
    localStorage.clear();
  } catch {
    // Storage blocked in this runner: nothing to clear.
  }
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});

describe('Settings → Preferences', () => {
  it('saves the theme, density and start page at once, and applies them', async () => {
    const page = await open('/settings/preferences');
    expect(page.text()).toContain('Preferences');
    await page.click('Dark');
    expect(page.user().prefs['theme']).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await page.click('Compact');
    expect(page.user().prefs['density']).toBe('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    await page.click('Matters');
    expect(page.user().prefs['startPage']).toBe('matters');
    expect(localStorage.getItem(START_PAGE_STORAGE_KEY)).toBe('matters');
    // Nothing else in the preferences was lost.
    expect(page.user().prefs['notifications']).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('keeps both of two quick changes, made before the first one has saved', async () => {
    const page = await open('/settings/preferences');
    // The real SDK tells listeners about a local write a moment later; this store does it at once.
    const store = page.firestore as unknown as { notify(path: string): void };
    const notify = store.notify.bind(store);
    vi.spyOn(store, 'notify').mockImplementation((path) => setTimeout(() => notify(path)));
    // No settling in between: the second change comes before the profile listener has the first.
    [...page.el.querySelectorAll<HTMLElement>('.settings-page button')]
      .find((b) => b.textContent?.trim() === 'Dark')
      ?.click();
    const quiet = page.field('Quiet from') as HTMLSelectElement;
    quiet.value = [...quiet.options].find((o) => o.textContent?.trim() === '9:30 pm')?.value ?? '';
    quiet.dispatchEvent(new Event('change'));
    await page.stable();
    expect(page.user().prefs['theme']).toBe('dark');
    expect((page.user().prefs['notifications'] as NotificationPrefs).quietHours).toEqual({
      start: '21:30',
      end: '07:00',
    });
  });

  it('applies a change made in another tab', async () => {
    const page = await open('/settings/preferences');
    page.firestore.set(`users/${UID}`, userDoc({ theme: 'dark', density: 'compact' }));
    await page.stable();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });

  it('sets quiet hours and the digest hour, and keeps a time zone choice', async () => {
    const page = await open('/settings/preferences');
    await page.choose('Quiet from', '9:30 pm');
    expect((page.user().prefs['notifications'] as NotificationPrefs).quietHours).toEqual({
      start: '21:30',
      end: '07:00',
    });
    await page.choose('Send the digest at', '6:00 am');
    expect((page.user().prefs['notifications'] as NotificationPrefs).digestHour).toBe(6);
    await page.choose('Time zone', 'Australia/Perth');
    expect(page.user().prefs['timezone']).toBe('Australia/Perth');
    await page.choose('Time zone', 'The practice’s (Australia/Melbourne)');
    expect(page.user().prefs).not.toHaveProperty('timezone');
  });

  it('lets owners and admins opt in to the weekly practice report (INS-03)', async () => {
    const lawyer = await open('/settings/preferences');
    expect(lawyer.text()).not.toContain('Weekly practice report');
    TestBed.resetTestingModule();

    const page = await open('/settings/preferences', undefined, 'owner');
    expect(page.text()).toContain('Weekly practice report');
    const toggle = () =>
      page.el.querySelector<HTMLButtonElement>('mt-switch[name="weeklyReport"] button') as HTMLButtonElement;
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    toggle().click();
    await page.stable();
    expect(page.user().prefs['notifications']).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, weeklyReport: true });
    toggle().click();
    await page.stable();
    expect((page.user().prefs['notifications'] as NotificationPrefs).weeklyReport).toBe(false);
  });

  it('sets how many days before they’re due task reminders come (CORE-11)', async () => {
    const page = await open('/settings/preferences');
    const select = page.field('Remind me about tasks') as HTMLSelectElement;
    // The server's default until the person chooses.
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe('1 day before they’re due');
    const options = [...select.options].map((o) => o.textContent?.trim());
    expect(options).toContain('On the day they’re due');
    expect(options.at(-1)).toBe('14 days before they’re due');
    await page.choose('Remind me about tasks', '3 days before they’re due');
    expect((page.user().prefs['notifications'] as NotificationPrefs).taskReminderDays).toBe(3);
    await page.choose('Remind me about tasks', 'On the day they’re due');
    expect((page.user().prefs['notifications'] as NotificationPrefs).taskReminderDays).toBe(0);
    // The other notification preferences are kept.
    expect(page.user().prefs['notifications']).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, taskReminderDays: 0 });
  });

  it('lists devices and removes one from push notifications', async () => {
    const page = await open('/settings/preferences', (firestore) =>
      firestore.set(`users/${UID}/devices/d1`, {
        token: 'fcm-token-fictional',
        platform: 'android',
        label: 'Chrome on Android',
        lastSeenAt: new Date('2026-10-01T09:00:00Z'),
        ...meta,
      }),
    );
    expect(page.text()).toContain('Chrome on Android');
    expect(page.text()).toContain('This browser can’t get push notifications.');
    await page.click('Remove');
    expect(page.firestore.get(`users/${UID}/devices/d1`)).toBeUndefined();
    expect(page.text()).toContain('No devices get push notifications yet.');
  });

  it('turns push on for this device (MOB-04), sends it a test and turns it off', async () => {
    const page = await open('/settings/preferences', undefined, 'lawyer', fakePushPlatform());
    const row = () => page.el.querySelector('[data-this-device]') as HTMLElement;
    expect(row().getAttribute('data-push')).toBe('off');
    await page.click('Turn on');
    expect(page.push.prompts).toBe(1);
    expect(page.firestore.get(`users/${UID}/devices/device-this-1`)).toMatchObject({
      token: 'fake-fcm-token-1',
      platform: 'web',
      label: 'Chrome on macOS',
      createdBy: UID,
    });
    // Push itself goes on, with deadline reminders on it; escalations push by default.
    const prefs = page.user().prefs['notifications'] as NotificationPrefs;
    expect(prefs.push).toBe(true);
    expect(prefs.kinds?.['deadline_reminder']).toEqual({ push: true });
    expect(page.push.store.record).toMatchObject({ uid: UID, token: 'fake-fcm-token-1' });
    expect(row().getAttribute('data-push')).toBe('on');
    expect(page.text()).toContain('Chrome on macOS (this device)');

    await page.click('Send a test');
    expect(page.auth.calls).toContainEqual({
      name: 'notifications-testPush',
      data: expect.objectContaining({ deviceId: 'device-this-1' }),
    });
    expect(document.body.textContent).toContain('Test sent');

    await page.click('Turn off');
    expect(page.firestore.get(`users/${UID}/devices/device-this-1`)).toBeUndefined();
    expect(page.push.unsubscribed).toBe(1);
    expect(page.push.store.record).toBeNull();
    expect(row().getAttribute('data-push')).toBe('off');
  });

  it('keeps a person’s choice for deadline reminders when push goes on', async () => {
    const page = await open(
      '/settings/preferences',
      (firestore) =>
        firestore.set(
          `users/${UID}`,
          userDoc({ notifications: { ...DEFAULT_NOTIFICATION_PREFS, kinds: { deadline_reminder: { push: false } } } }),
        ),
      'lawyer',
      fakePushPlatform(),
    );
    await page.click('Turn on');
    const prefs = page.user().prefs['notifications'] as NotificationPrefs;
    expect(prefs.push).toBe(true);
    expect(prefs.kinds?.['deadline_reminder']).toEqual({ push: false });
  });

  it('says why push can’t go on: blocked, Safari on an iPhone, or the prompt dismissed', async () => {
    const blocked = await open(
      '/settings/preferences',
      undefined,
      'lawyer',
      fakePushPlatform({ permissionIs: 'denied' }),
    );
    expect(blocked.el.querySelector('[data-this-device]')?.getAttribute('data-push')).toBe('denied');
    expect(blocked.text()).toContain('Notifications are blocked for Materia in this browser.');
    expect(blocked.text()).not.toContain('Turn on');
    TestBed.resetTestingModule();

    const iphone = await open('/settings/preferences', undefined, 'lawyer', fakePushPlatform({ supportIs: 'install' }));
    expect(iphone.text()).toContain('push needs Materia on your Home Screen');
    expect(iphone.text()).toContain('How to install');
    TestBed.resetTestingModule();

    const dismissed = await open('/settings/preferences', undefined, 'lawyer', fakePushPlatform({ answer: 'default' }));
    await dismissed.click('Turn on');
    expect(dismissed.firestore.get(`users/${UID}/devices/device-this-1`)).toBeUndefined();
    expect(dismissed.el.querySelector('[data-this-device]')?.getAttribute('data-push')).toBe('off');
  });
});

describe('Settings → Profile', () => {
  it('saves names to the user and title, initials and colour to the member', async () => {
    const page = await open('/settings/profile');
    expect((page.field('Display name') as HTMLInputElement).value).toBe('Jordan Price');
    await page.type('Display name', 'Jordan Fictional-Price');
    await page.type('Title', 'Senior Associate');
    await page.type('Admission number', 'VIC 40123');
    await page.click('Save');
    expect(page.user()).toMatchObject({ displayName: 'Jordan Fictional-Price', firstName: 'Jordan' });
    expect(page.firestore.get(`orgs/${ORG}/members/${UID}`)).toMatchObject({
      displayName: 'Jordan Fictional-Price',
      title: 'Senior Associate',
      admissionNo: 'VIC 40123',
      initials: 'JF',
    });
    expect(page.text()).toContain('Profile saved');
  });

  it('won’t save without a display name', async () => {
    const page = await open('/settings/profile');
    await page.type('Display name', ' ');
    expect(page.text()).toContain('Enter the name colleagues see.');
  });
});

describe('the start page', () => {
  it('opens Matters when that’s the saved start page', async () => {
    localStorage.setItem(START_PAGE_STORAGE_KEY, 'matters');
    const page = await open('/');
    expect(page.router.url).toMatch(/^\/matters/);
  });

  it('opens Today otherwise', async () => {
    const page = await open('/');
    expect(page.router.url).toBe('/today');
  });
});
