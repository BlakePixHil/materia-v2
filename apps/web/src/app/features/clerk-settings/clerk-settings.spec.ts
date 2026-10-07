import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { CLERK_DISCLOSURE_VERSION, clerkMeteringPeriod, type ClerkKeyStatus } from '@materia/domain';
import { makeMigrationEnrichment } from '@materia/test-utils';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { recentPeriods } from './clerk-usage';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/**
 * Settings → Clerk and AI (AI-13) against the in-memory Firestore, with `clerk-updateSettings`
 * faked by writing the org document as the callable would. A fictional practice only.
 */

const ORG = 'org-harbour-vine';
const ADMIN = testSession({ claims: { orgId: ORG, role: 'admin', orgName: 'Harbour & Vine Legal' } });
const LAWYER = testSession({ claims: { orgId: ORG, role: 'lawyer', orgName: 'Harbour & Vine Legal' } });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};
const KEY_STATUS: ClerkKeyStatus = { set: true, status: 'valid', last4: '4321', model: 'claude-sonnet-5-5' };

/** Applies `clerk-updateSettings` to the in-memory org, as the callable does. */
class ClerkPort extends FakeAuthPort {
  constructor(
    session: AuthSession,
    private readonly firestore: InMemoryFirestore,
  ) {
    super(session);
    this.callResults['clerk-getApiKeyStatus'] = KEY_STATUS;
  }

  override async call<T>(name: string, data: unknown): Promise<T> {
    if (name !== 'clerk-updateSettings') return super.call<T>(name, data);
    this.calls.push({ name, data });
    const input = data as Record<string, unknown>;
    const org = this.firestore.get(`orgs/${ORG}`) ?? {};
    const settings = (org['settings'] as { clerk?: Record<string, unknown> } | undefined) ?? {};
    const clerk = { ...(settings.clerk ?? {}) };
    if (input['enabled'] !== undefined) clerk['enabled'] = input['enabled'];
    if (input['features']) clerk['features'] = { ...(clerk['features'] as object), ...(input['features'] as object) };
    for (const field of ['monthlyBudgetCents', 'perUserDailyRequests', 'ocrDailyPages']) {
      if (input[field] !== undefined) clerk[field] = input[field];
    }
    const kept = Object.fromEntries(Object.entries(clerk).filter(([, value]) => value !== null));
    if (input['acknowledgeVersion'])
      Object.assign(kept, {
        ackVersion: input['acknowledgeVersion'],
        acknowledgedBy: 'user-priya',
        acknowledgedAt: new Date('2026-10-05T01:00:00Z'),
      });
    this.firestore.set(`orgs/${ORG}`, { ...org, settings: { ...settings, clerk: kept } });
    return { changed: Object.keys(input) } as T;
  }
}

async function open(
  url: string,
  session: AuthSession,
  clerk: Record<string, unknown> = {},
  seed: (firestore: InMemoryFirestore) => void = () => undefined,
) {
  const firestore = new InMemoryFirestore();
  firestore.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    timezone: 'Australia/Melbourne',
    settings: { clerk },
    ...meta,
  });
  firestore.set(`orgs/${ORG}/members/user-priya`, {
    role: 'admin',
    status: 'active',
    displayName: 'Priya Fictional',
    ...meta,
  });
  seed(firestore);
  const port = new ClerkPort(session, firestore);
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
  const page = () => el.querySelector('mt-clerk-settings-page, mt-clerk-guide-page') ?? el;
  const button = (text: string, root: ParentNode = document.body) => {
    const found = [...root.querySelectorAll<HTMLElement>('button, a')].find((b) =>
      b.textContent?.trim().startsWith(text),
    );
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  const field = (label: string) => {
    const host = [...el.querySelectorAll('mt-text-field')].find((f) =>
      f.querySelector('label, .mt-label')?.textContent?.trim().startsWith(label),
    );
    const input = host?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error(`No field "${label}"`);
    return input;
  };
  return {
    port,
    firestore,
    router,
    el,
    stable,
    page,
    button,
    text: (root: Element | null = page()) => root?.textContent?.replace(/\s+/g, ' ') ?? '',
    clerk: () =>
      ((firestore.get(`orgs/${ORG}`)?.['settings'] as { clerk?: Record<string, unknown> } | undefined)?.clerk ??
        {}) as Record<string, unknown>,
    toggle: (selector: string) => el.querySelector<HTMLElement>(`${selector} [role="switch"], ${selector} button`),
    async click(text: string, root?: ParentNode) {
      button(text, root).click();
      await stable();
    },
    async flip(selector: string) {
      const control = el.querySelector<HTMLElement>(`${selector} [role="switch"]`);
      if (!control) throw new Error(`No switch in ${selector}`);
      control.click();
      await stable();
    },
    async type(label: string, value: string) {
      const input = field(label);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await stable();
    },
    calls: (name: string) =>
      port.calls
        .filter((c) => c.name === name)
        .map((c) =>
          Object.fromEntries(Object.entries(c.data as Record<string, unknown>).filter(([key]) => key !== 'requestId')),
        ),
  };
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('.mt-modal-root')) node.remove();
});

describe('Settings → Clerk and AI', () => {
  it('holds Clerk off until an admin acknowledges the disclosure, then records who did', async () => {
    const page = await open('/settings/clerk', ADMIN);
    expect(page.text()).toContain('Clerk and AI');
    expect(page.text()).toContain('Clerk is off until an owner or admin reads this and acknowledges it.');
    expect(page.page().querySelector('details.disclosure')?.hasAttribute('open')).toBe(true);
    expect(page.text()).toContain('outside Australia');

    await page.click('I’ve read this, turn Clerk on');
    expect(page.calls('clerk-updateSettings')).toEqual([{ acknowledgeVersion: CLERK_DISCLOSURE_VERSION }]);
    expect(page.text()).toContain('Acknowledged by Priya Fictional');
    expect(page.text()).not.toContain('I’ve read this');
  });

  it('folds the long reading away once acknowledged: the disclosure, data and retention, cost breakdown', async () => {
    const page = await open('/settings/clerk', ADMIN, { ackVersion: CLERK_DISCLOSURE_VERSION });
    expect(page.page().querySelector('[data-acknowledged]')?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
      /^Acknowledged by .+\S\.$/,
    );
    for (const selector of ['details.disclosure', 'details[data-retention]', 'details[data-breakdown]'])
      expect(page.page().querySelector(selector)?.hasAttribute('open'), selector).toBe(false);
  });

  it('turns a feature and Clerk itself off at once', async () => {
    const page = await open('/settings/clerk', ADMIN, { ackVersion: CLERK_DISCLOSURE_VERSION });
    await page.flip('[data-feature="chat"]');
    expect(page.calls('clerk-updateSettings').at(-1)).toEqual({ features: { chat: false } });
    expect(page.clerk()['features']).toEqual({ chat: false });

    await page.flip('mt-settings-row:has([name="clerk-enabled"])');
    expect(page.calls('clerk-updateSettings').at(-1)).toEqual({ enabled: false });
  });

  it('saves the limits, and confirms a spend limit below this month’s spend', async () => {
    const period = clerkMeteringPeriod(new Date());
    const page = await open('/settings/clerk', ADMIN, { ackVersion: CLERK_DISCLOSURE_VERSION }, (firestore) =>
      firestore.set(`orgs/${ORG}/metrics/${period}`, {
        period,
        values: {
          calls: 12,
          tokens: 48_000,
          costMicros: 3_210_000,
          'feature.chat.calls': 12,
          'feature.chat.costMicros': 3_210_000,
          'user.user-priya.calls': 12,
          'user.user-priya.costMicros': 3_210_000,
          'suggestions.accepted': 3,
          'suggestions.dismissed': 1,
        },
      }),
    );
    expect(page.text()).toContain('US$3.21');
    expect(page.text()).toContain('75%');

    await page.type('Requests per person per day', 'lots');
    expect(page.text()).toContain('Enter a whole number');
    await page.type('Requests per person per day', '200');
    await page.type('Monthly spend limit', '2.50');
    await page.click('Save limits');
    const dialog = document.body.querySelector<HTMLElement>('.mt-dialog');
    expect(dialog?.textContent).toContain('Stop Clerk for the rest of the month?');
    await page.click('Set the limit', dialog ?? undefined);
    expect(page.calls('clerk-updateSettings').at(-1)).toEqual({
      monthlyBudgetCents: 250,
      perUserDailyRequests: 200,
      ocrDailyPages: null,
    });
    expect(page.clerk()).toMatchObject({ monthlyBudgetCents: 250, perUserDailyRequests: 200 });
    expect(page.el.querySelector('[data-budget-reached]')).not.toBeNull();

    // Clearing a limit sends null.
    await page.type('Monthly spend limit', '');
    await page.click('Save limits');
    expect(page.calls('clerk-updateSettings').at(-1)).toEqual({
      monthlyBudgetCents: null,
      perUserDailyRequests: 200,
      ocrDailyPages: null,
    });

    // The daily scanned-page limit: 0 stops reading scans; empty goes back to the default.
    await page.type('Scanned pages read per day', '-1');
    expect(page.text()).toContain('Enter a whole number from 0');
    await page.type('Scanned pages read per day', '0');
    await page.click('Save limits');
    expect(page.calls('clerk-updateSettings').at(-1)).toMatchObject({ ocrDailyPages: 0 });
    expect(page.clerk()).toMatchObject({ ocrDailyPages: 0 });
    await page.type('Scanned pages read per day', '');
    await page.click('Save limits');
    expect(page.calls('clerk-updateSettings').at(-1)).toMatchObject({ ocrDailyPages: null });
  });

  it('fills the limits from settings that arrive after the first snapshot, but keeps what someone typed', async () => {
    // After a reload the first snapshot can come from the offline cache, older than the server's.
    const page = await open('/settings/clerk', ADMIN, { ackVersion: CLERK_DISCLOSURE_VERSION });
    const field = (label: string) =>
      [...page.el.querySelectorAll('mt-text-field')].find((f) => f.textContent?.includes(label))?.querySelector('input')
        ?.value;
    expect(field('Monthly spend limit')).toBe('');

    const org = page.firestore.get(`orgs/${ORG}`) ?? {};
    const later = (clerk: Record<string, unknown>) =>
      page.firestore.set(`orgs/${ORG}`, {
        ...org,
        settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION, ...clerk } },
      });
    later({ monthlyBudgetCents: 25_000, perUserDailyRequests: 150, ocrDailyPages: 50 });
    await page.stable();
    expect(field('Monthly spend limit')).toBe('250.00');
    expect(field('Requests per person per day')).toBe('150');
    expect(field('Scanned pages read per day')).toBe('50');

    await page.type('Monthly spend limit', '300');
    later({ monthlyBudgetCents: 40_000, perUserDailyRequests: 150 });
    await page.stable();
    expect(field('Monthly spend limit')).toBe('300');
  });

  it('shows a lawyer what is on and the disclosure, read-only, with no key, limits or usage', async () => {
    const page = await open('/settings/clerk', LAWYER, {
      ackVersion: CLERK_DISCLOSURE_VERSION,
      features: { drafting: false },
    });
    expect(page.router.url).toBe('/settings/clerk');
    expect(page.text(page.page().querySelector('[data-feature="drafting"]'))).toContain('Off');
    expect(page.text(page.page().querySelector('[data-feature="chat"]'))).toContain('On');
    expect(page.page().querySelector('[role="switch"]')).toBeNull();
    expect(page.text()).not.toContain('Anthropic API key');
    expect(page.page().querySelector('mt-clerk-usage')).toBeNull();
    expect(page.calls('clerk-getApiKeyStatus')).toHaveLength(0);
  });
});

describe('Settings → Clerk and AI: migrated files (MIG-09)', () => {
  const ACK = { ackVersion: CLERK_DISCLOSURE_VERSION };
  const seedRun =
    (over: Parameters<typeof makeMigrationEnrichment>[0] = {}) =>
    (firestore: InMemoryFirestore) =>
      firestore.set(`orgs/${ORG}/migrationEnrichments/run-1`, {
        ...makeMigrationEnrichment({ runId: 'run-1', ...over }),
        ...meta,
      });
  const card = (page: Awaited<ReturnType<typeof open>>) => page.page().querySelector('mt-migration-enrichment-card');

  it('shows the estimate and approves it with the allowance typed', async () => {
    const page = await open('/settings/clerk', ADMIN, ACK, seedRun());
    expect(page.text()).toContain('Migrated files');
    expect(page.text(card(page))).toContain(
      'Clerk can read 1 document (about 12 pages, 2 of them scanned) and 1 estate matter: about',
    );
    expect(page.text(card(page))).toContain('Nothing changes until a person accepts a suggestion.');

    await page.type('Allowance', '25');
    await page.click('Approve', card(page) ?? undefined);
    expect(page.calls('migration-decideEnrichment')).toEqual([
      { runId: 'run-1', decision: 'approve', allowanceCents: 2_500 },
    ]);
  });

  it('declines for now, and refuses an allowance out of range', async () => {
    const page = await open('/settings/clerk', ADMIN, ACK, seedRun());
    await page.type('Allowance', '0.5');
    expect(page.text(card(page))).toContain('Enter from');
    expect(page.button('Approve', card(page) ?? undefined).hasAttribute('disabled')).toBe(true);

    await page.click('Not now', card(page) ?? undefined);
    expect(page.calls('migration-decideEnrichment')).toEqual([{ runId: 'run-1', decision: 'decline' }]);
  });

  it('says why it paused and offers to resume with more than it spent', async () => {
    const page = await open(
      '/settings/clerk',
      ADMIN,
      ACK,
      seedRun({ status: 'paused', pausedFor: 'allowance', allowanceCents: 500, spentMicros: 5_100_000 }),
    );
    expect(page.text(card(page))).toContain('Clerk stopped reading. It used the allowance you approved.');
    await page.click('Resume', card(page) ?? undefined);
    expect(page.calls('migration-decideEnrichment')).toEqual([
      { runId: 'run-1', decision: 'approve', allowanceCents: 1_000 },
    ]);
  });

  it('shows progress while it reads, and what is waiting once done', async () => {
    const running = await open(
      '/settings/clerk',
      ADMIN,
      ACK,
      seedRun({
        status: 'running',
        allowanceCents: 2_500,
        spentMicros: 1_200_000,
        documents: ['m-1/d-1', 'm-1/d-2'],
        progress: { read: 1, skipped: 0, failed: 0, mattersRead: 0, events: 0 },
      }),
    );
    expect(running.text(card(running))).toContain('1 of 2 documents read');
    expect(running.text(card(running))).toContain('About US$1.20 of the US$25.00 allowance spent.');
    TestBed.resetTestingModule();

    const done = await open(
      '/settings/clerk',
      ADMIN,
      ACK,
      seedRun({
        status: 'done',
        progress: { read: 2, skipped: 0, failed: 0, mattersRead: 1, events: 3 },
        suggestionsWaiting: 4,
        unreadable: 1,
      }),
    );
    expect(done.text(card(done))).toContain(
      'Clerk read 2 documents and found 3 key dates. 4 suggestions are waiting for review. 1 document couldn’t be read and is listed for migration review.',
    );
    expect(done.button('Review the suggestions', card(done) ?? undefined).getAttribute('href')).toBe('/inbox');
  });

  it('is for owners and admins only, and leaves a cancelled run out', async () => {
    const lawyer = await open('/settings/clerk', LAWYER, ACK, seedRun());
    expect(lawyer.text()).not.toContain('Migrated files');
    TestBed.resetTestingModule();
    const cancelled = await open('/settings/clerk', ADMIN, ACK, seedRun({ status: 'cancelled' }));
    expect(cancelled.text()).not.toContain('Migrated files');
  });
});

describe('How Clerk works', () => {
  it('explains the seven rules', async () => {
    const page = await open('/help/clerk', LAWYER);
    expect(page.text()).toContain('How Clerk works');
    expect(page.page().querySelectorAll('.rules li')).toHaveLength(7);
    expect(page.text()).toContain('It suggests; you decide');
  });
});

describe('recentPeriods', () => {
  it('counts back across a year', () => {
    expect(recentPeriods('clerk-2026-02', 3)).toEqual(['clerk-2026-02', 'clerk-2026-01', 'clerk-2025-12']);
  });
});
