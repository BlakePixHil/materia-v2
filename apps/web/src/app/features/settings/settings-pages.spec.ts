import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { cents } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { dayBoundary } from './audit-log-page';
import { dollarsText, parseDollars } from './money';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';
import { emptyIntakeState, feesWithDefault } from '../intake/intake-state';

/**
 * Settings (CORE-21): Practice, Billing and rates, the team's rates and budgets, and the audit log,
 * against the in-memory Firestore and fake callables. A fictional practice only.
 */

const ORG = 'org-harbour-vine';
const OWNER = testSession({ claims: { orgId: ORG, role: 'owner', orgName: 'Harbour & Vine Legal' } });
const ADMIN = testSession({ claims: { orgId: ORG, role: 'admin', orgName: 'Harbour & Vine Legal' } });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};

const orgDoc = {
  name: 'Harbour & Vine Legal',
  practiceType: 'wills_estates',
  jurisdictions: ['VIC', 'NSW'],
  primaryJurisdiction: 'VIC',
  timezone: 'Australia/Melbourne',
  holidayLocality: 'VIC_GREATER_GEELONG',
  retentionYears: 7,
  billing: {
    unitMinutes: 6,
    rounding: 'up',
    gstRegistered: true,
    defaultRateCents: 45000,
    invoicePrefix: 'HV-',
    paymentTermsDays: 14,
  },
  matterNumberFormat: 'M-{YYYY}-{seq:4}',
  fy: { startMonth: 7 },
  plan: 'trial',
  security: { mfaRequired: false, sessionIdleMinutes: 60 },
  ...meta,
};

/** Fake callables that answer per call, in order (an Error is thrown). */
class ScriptedAuthPort extends FakeAuthPort {
  readonly script: Record<string, unknown[]> = {};
  override async call<T>(name: string, data: unknown): Promise<T> {
    const queue = this.script[name];
    if (queue?.length) {
      this.calls.push({ name, data });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next as T;
    }
    return super.call<T>(name, data);
  }
}

async function open(url: string, session: AuthSession, seed: (firestore: InMemoryFirestore) => void = () => undefined) {
  const port = new ScriptedAuthPort(session);
  const firestore = new InMemoryFirestore();
  firestore.set(`orgs/${ORG}`, orgDoc);
  seed(firestore);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: new FakeTenancyPort() },
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
  const control = (label: string) => {
    const host = [...document.body.querySelectorAll('mt-text-field, mt-select')].find((f) =>
      f.querySelector('label, .mt-label')?.textContent?.trim().startsWith(label),
    );
    const found = host?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
    if (!found) throw new Error(`No field "${label}"`);
    return found;
  };
  const button = (text: string, root: ParentNode = document.body) => {
    const found = [...root.querySelectorAll<HTMLElement>('button, a')].find((b) =>
      b.textContent?.trim().startsWith(text),
    );
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  return {
    port,
    firestore,
    router,
    el,
    stable,
    text: (root: Element | null = el) => root?.textContent?.replace(/\s+/g, ' ') ?? '',
    dialog: () => document.body.querySelector<HTMLElement>('.mt-dialog'),
    async type(label: string, value: string) {
      const input = control(label) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await stable();
    },
    async choose(label: string, optionText: string) {
      const select = control(label) as HTMLSelectElement;
      const option = [...select.options].find((o) => o.textContent?.trim() === optionText);
      if (!option) throw new Error(`No option "${optionText}"`);
      select.value = option.value;
      select.dispatchEvent(new Event('change'));
      await stable();
    },
    async click(text: string, root?: ParentNode) {
      button(text, root).click();
      await stable();
    },
    button,
    callsTo: (name: string) => port.calls.filter((c) => c.name === name).map((c) => c.data as Record<string, unknown>),
  };
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('.mt-modal-root')) node.remove();
});

describe('Settings → Practice', () => {
  it('loads the practice, checks the ABN, and confirms the reminders a time zone change moves', async () => {
    const page = await open('/settings/practice', OWNER);
    expect(page.text()).toContain('Practice');
    expect(
      page.button('Save').hasAttribute('disabled') || page.button('Save').getAttribute('aria-disabled') === 'true',
    ).toBe(true);

    await page.type('ABN', '51 824 753 557');
    expect(page.text()).toContain('This isn’t a valid ABN');
    await page.type('ABN', '51 824 753 556');
    expect(page.text()).not.toContain('This isn’t a valid ABN');

    await page.choose('Time zone', 'Australia/Perth');
    const impact = { remindersRescheduled: 312, jurisdictionInUse: [], gstChanged: false, changed: ['timezone'] };
    page.port.script['orgs-updateSettings'] = [
      { saved: false, impact },
      { saved: true, impact },
    ];
    await page.click('Save');
    expect(page.text(page.dialog())).toContain('312 deadline reminders will be rescheduled for the new time zone');
    await page.click('Save and reschedule', page.dialog() ?? undefined);
    const calls = page.callsTo('orgs-updateSettings');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ dryRun: true, practice: { timezone: 'Australia/Perth', abn: '51824753556' } });
    expect(calls[1]).toMatchObject({ practice: { timezone: 'Australia/Perth' } });
    expect(calls[1]).not.toHaveProperty('dryRun');
    expect(page.text(document.body)).toContain('Practice settings saved');
  });

  it('refuses removing a jurisdiction open matters use, listing them', async () => {
    const page = await open('/settings/practice', ADMIN);
    const nsw = [...page.el.querySelectorAll('mt-checkbox')].find((c) => c.textContent?.includes('NSW'));
    nsw?.querySelector<HTMLElement>('[role="checkbox"], input, button')?.click();
    await page.stable();
    page.port.script['orgs-updateSettings'] = [
      {
        saved: false,
        impact: {
          remindersRescheduled: 0,
          jurisdictionInUse: [
            { matterId: 'm-1', number: 'M-2026-0007', title: 'Estate of Fictional', jurisdiction: 'NSW' },
          ],
          gstChanged: false,
          changed: ['jurisdictions'],
        },
      },
    ];
    await page.click('Save');
    expect(page.text()).toContain('Open matters use NSW, so it can’t be removed yet');
    expect(page.text()).toContain('M-2026-0007');
    expect(page.callsTo('orgs-updateSettings')).toHaveLength(1);
  });
});

describe('Settings → Billing and rates', () => {
  it('warns about a mid-year GST change and saves billing with fee defaults', async () => {
    const page = await open('/settings/billing', OWNER);
    expect((page.el.querySelector('input[name="defaultRate"], mt-text-field input') as HTMLInputElement).value).toBe(
      '450.00',
    );
    page.el.querySelector<HTMLElement>('mt-switch button, mt-switch [role="switch"]')?.click();
    await page.stable();
    expect(page.text()).toContain('This applies to new invoices only');

    await page.choose('Will fee arrangement', 'Fixed fee');
    await page.click('Save');
    expect(page.text()).toContain('Enter the fixed fee');
    await page.type('Will fixed fee', '1,100');
    page.port.script['orgs-updateSettings'] = [
      { saved: true, impact: { remindersRescheduled: 0, jurisdictionInUse: [], gstChanged: true, changed: [] } },
    ];
    await page.click('Save');
    expect(page.callsTo('orgs-updateSettings')[0]).toMatchObject({
      billing: { gstRegistered: false, defaultRateCents: 45000, invoicePrefix: 'HV-' },
      feeDefaults: { will: { arrangement: 'fixed', amountCents: 110000 } },
    });
  });
});

describe('Settings → Team and roles', () => {
  it('shows MFA and activity to owners, and saves a member’s rate, budget and supervisor', async () => {
    const page = await open('/settings/team', OWNER, (firestore) => {
      firestore.set(`orgs/${ORG}/members/user-jordan`, {
        displayName: 'Jordan Price',
        email: 'jordan@example.test',
        role: 'owner',
        status: 'active',
        ...meta,
      });
      firestore.set(`orgs/${ORG}/members/u-sam`, {
        displayName: 'Sam Lee',
        email: 'sam@example.test',
        role: 'paralegal',
        status: 'active',
        defaultRateCents: 18000,
        rates: [],
        budgets: {},
        ...meta,
      });
    });
    page.port.script['orgs-memberSecurity'] = [
      { members: [{ uid: 'u-sam', mfaEnrolled: true, lastSignInAt: null, lastActiveAt: '2026-09-30T00:00:00Z' }] },
    ];
    // The security call runs once the members load; reload the page so it uses the script.
    await page.router.navigateByUrl('/settings/practice');
    await page.router.navigateByUrl('/settings/team');
    await page.stable();
    expect(page.text()).toContain('sam@example.test · Paralegal · MFA on · Last active 30 Sept 2026 · $180.00/h');

    await page.click('Rate and budget', page.el.querySelector('[data-member="sam@example.test"]') ?? undefined);
    const dialog = page.dialog();
    expect(page.text(dialog)).toContain('Fee budget FY');
    await page.type('Hourly rate', '200');
    await page.choose('Supervisor', 'Jordan Price');
    const budget = [...(dialog?.querySelectorAll('mt-text-field') ?? [])].find((f) =>
      f.textContent?.includes('Fee budget'),
    );
    const input = budget?.querySelector('input') as HTMLInputElement;
    input.value = '150000';
    input.dispatchEvent(new Event('input'));
    await page.stable();
    await page.click('Save', dialog ?? undefined);
    await page.stable();
    const sam = page.firestore.get(`orgs/${ORG}/members/u-sam`) as Record<string, unknown>;
    expect(sam['defaultRateCents']).toBe(20000);
    expect(sam['supervisorUid']).toBe('user-jordan');
    expect(Object.values(sam['budgets'] as Record<string, number>)).toEqual([15000000]);
    expect((sam['rates'] as { rateCents: number }[]).map((r) => r.rateCents)).toEqual([20000]);
  });

  it('explains each role’s permissions from the domain matrix', async () => {
    const page = await open('/settings/team', OWNER);
    expect(page.text()).toContain('What each role can do');
    expect(page.text()).toContain('Audit: view');
  });
});

describe('Settings → Audit log', () => {
  const entry = {
    id: 'a-1',
    at: '2026-10-05T01:00:00.000Z',
    actor: { uid: 'user-jordan' },
    action: 'org.settings_updated',
    entity: { path: `orgs/${ORG}/members/user-jordan`, collection: 'members', id: 'user-jordan' },
    summary: 'Settings changed: timezone',
    source: 'callable',
    data: { changed: ['timezone'] },
  };

  it('lists entries, filters them, opens the details and exports after re-authentication', async () => {
    const page = await open('/settings/audit', OWNER);
    page.port.script['audit-query'] = [{ entries: [entry], nextCursor: null }];
    await page.choose('Action', 'Settings changed');
    expect(page.callsTo('audit-query').at(-1)).toMatchObject({ action: 'org.settings_updated', limit: 50 });
    expect(page.text()).toContain('Settings changed: timezone');

    page.el.querySelector<HTMLElement>('mt-table tbody tr, mt-table [role="row"]:not(:first-child)')?.click();
    await page.stable();
    expect(page.text(page.dialog())).toContain(`orgs/${ORG}/members/user-jordan`);
    await page.click('Close', page.dialog() ?? undefined);

    const reauth = Object.assign(new Error('Sign in again'), {
      code: 'functions/unauthenticated',
      details: { code: 'REAUTH_REQUIRED' },
    });
    page.port.script['audit-exportCsv'] = [reauth, { csv: 'at,actor\r\n', rows: 1, truncated: false }];
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fictional');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    try {
      await page.click('Export CSV');
      // The callable client asks (SEC-04); its dialog loads lazily.
      await vi.waitFor(() => expect(page.text(page.dialog())).toContain('Confirm it’s you'));
      await page.stable();
      await page.type('Password', 'password');
      await page.click('Confirm', page.dialog() ?? undefined);
      await page.stable();
      expect(page.callsTo('audit-exportCsv')).toHaveLength(2);
      expect(created).toHaveBeenCalled();
      expect(page.text(document.body)).toContain('Exported 1 entry');
    } finally {
      created.mockRestore();
      revoked.mockRestore();
    }
  });

  it('keeps export for owners', async () => {
    const page = await open('/settings/audit', ADMIN);
    expect(page.text()).toContain('Audit log');
    expect(page.text()).not.toContain('Export CSV');
  });
});

describe('settings helpers', () => {
  it('reads typed dollars and days', () => {
    expect(parseDollars('$1,250.5')).toBe(125050);
    expect(parseDollars('')).toBeNull();
    expect(parseDollars('abc')).toBeUndefined();
    expect(parseDollars('-5')).toBeUndefined();
    expect(dollarsText(45000)).toBe('450.00');
    expect(dollarsText(undefined)).toBe('');
    expect(dayBoundary('', false)).toBeUndefined();
    expect(dayBoundary('31/02/2026', false)).toBeNull();
    expect(dayBoundary('5/10/2026', false)).toBe(new Date(2026, 9, 5).toISOString());
  });

  it('prefills intake fees from the type’s default until they are edited', () => {
    const empty = emptyIntakeState().fees;
    const will = { arrangement: 'fixed' as const, amountCents: cents(110000) };
    const filled = feesWithDefault(empty, will);
    expect(filled).toMatchObject({ arrangement: 'fixed', amount: '1100.00' });
    // Switching type replaces an untouched default; an edited one stays.
    expect(feesWithDefault(filled, undefined, will)).toEqual(empty);
    const edited = { ...filled, amount: '900' };
    expect(feesWithDefault(edited, { arrangement: 'hourly' }, will)).toBe(edited);
  });
});
