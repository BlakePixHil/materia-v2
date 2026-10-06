import { CONSENT_BROWSER } from './integrations-page';
import { ADMIN, cleanUpOverlays, LAWYER, meta, openMatter, ORG } from '../matter-detail/testing';

/**
 * Settings → Integrations (BILL-09): connecting the practice's Xero organisation, choosing where
 * invoices go in it, and sending what isn't there yet. A fictional practice and fictional Xero
 * organisations only.
 */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const XERO_ON = { 'integrations.xero': true };
const STATUS = `orgs/${ORG}/integrationStatus/xero`;
const DEMO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONSENT = 'https://login.xero.example.test/identity/connect/authorize?state=fictional';

const TENANTS = [
  { tenantId: DEMO, tenantName: 'Harbour & Vine Legal (demo)' },
  { tenantId: OTHER, tenantName: 'Harbour & Vine Holdings (demo)' },
];
const ACCOUNTS = [
  { code: '200', name: 'Professional fees', class: 'REVENUE' },
  { code: '260', name: 'Disbursements recovered', class: 'REVENUE' },
];
const OTHER_ACCOUNTS = [{ code: '410', name: 'Consulting', class: 'REVENUE' }];

function practice(xero: Seed | null = null, status: Seed | null = null) {
  return (fs: Page['firestore']) => {
    fs.set(`orgs/${ORG}`, {
      name: 'Harbour & Vine Legal',
      timezone: 'Australia/Melbourne',
      ...(xero ? { xero } : {}),
    });
    if (status) {
      fs.set(STATUS, {
        provider: 'xero',
        level: 'org',
        uid: null,
        scopes: ['accounting.transactions'],
        ...meta,
        ...status,
      });
    }
  };
}

const connected = (data: Seed = {}): Seed => ({
  status: 'connected',
  account: { tenantName: 'Harbour & Vine Legal (demo)' },
  connectedAt: new Date('2026-10-02T00:00:00Z'),
  ...data,
});

/** The xero-* and integrations-* callables as the server answers them. */
function server() {
  return {
    'integrations-start': () => ({ url: CONSENT }),
    'integrations-disconnect': (_data: Seed, fs: Page['firestore']) => {
      fs.set(STATUS, { ...fs.get(STATUS), status: 'disconnected', reason: 'disconnected' });
      return { disconnected: true, revoked: true };
    },
    'xero-options': (data: Seed) =>
      data['tenantId'] === OTHER
        ? { tenants: TENANTS, tenantId: OTHER, accounts: OTHER_ACCOUNTS }
        : { tenants: TENANTS, tenantId: DEMO, accounts: ACCOUNTS },
    'xero-saveSettings': (data: Seed, fs: Page['firestore']) => {
      const settings = data['settings'] as Seed;
      const tenant = TENANTS.find((t) => t.tenantId === settings['tenantId']);
      fs.set(`orgs/${ORG}`, { ...fs.get(`orgs/${ORG}`), xero: { ...settings, tenantName: tenant?.tenantName } });
      return { saved: true, unsent: 3 };
    },
    'xero-send': () => ({ queued: 3 }),
  };
}

async function open(options: Parameters<typeof openMatter>[1] = {}) {
  const assigned: string[] = [];
  const page = await openMatter('/settings/integrations', {
    session: ADMIN,
    flags: XERO_ON,
    ...options,
    callables: { ...server(), ...options.callables },
    providers: [
      {
        provide: CONSENT_BROWSER,
        useValue: { origin: () => 'http://localhost:4200', assign: (url: string) => assigned.push(url) },
      },
    ],
  });
  for (let i = 0; i < 3; i++) await page.stable(5);
  return { ...page, assigned };
}

/** A callable's calls without their generated request ids. */
const callsOf = (page: Page, name: string) =>
  page.calls(name).map((data) => Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'requestId')));

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Settings → Integrations', () => {
  it('is in the sidebar for owners and admins while the flag is on', async () => {
    const page = await openMatter('/settings/practice', { session: ADMIN, flags: XERO_ON, configure: practice() });
    expect(page.buttons('Integrations').length).toBeGreaterThan(0);
  });

  it('is not in the sidebar, and not reachable, while the flag is off', async () => {
    const page = await openMatter('/settings/practice', { session: ADMIN, configure: practice() });
    expect(page.buttons('Integrations')).toHaveLength(0);
    await page.router.navigateByUrl('/settings/integrations');
    await page.stable();
    expect(page.router.url).toBe('/today');
  });

  it('is not offered to lawyers, and its route turns them away', async () => {
    const page = await openMatter('/settings/team', { session: LAWYER, flags: XERO_ON, configure: practice() });
    expect(page.buttons('Integrations')).toHaveLength(0);
    await page.router.navigateByUrl('/settings/integrations');
    await page.stable();
    expect(page.router.url).not.toBe('/settings/integrations');
    expect(page.calls('xero-options')).toHaveLength(0);
  });

  it('explains Xero and connects it: integrations-start, then Xero’s consent page', async () => {
    const page = await open({ configure: practice() });
    expect(page.text(page.body.querySelector('h1'))).toBe('Integrations');
    expect(page.text(byTestId('xero'))).toContain(
      'Send issued invoices and credit notes to Xero, and bring payments made in Xero back.',
    );
    // Not connected: no badge, and nothing to read from Xero yet.
    expect(byTestId('xero-card')?.querySelector('mt-badge')).toBeNull();
    expect(page.calls('xero-options')).toHaveLength(0);
    expect(byTestId('xero-payments-checked')).toBeNull();

    await page.click('Connect Xero');
    expect(callsOf(page, 'integrations-start')).toEqual([
      { provider: 'xero', returnTo: '/settings/integrations', origin: 'http://localhost:4200' },
    ]);
    expect(page.assigned).toEqual([CONSENT]);
  });

  it('asks for reconnecting when Xero refused the connection, through the same flow', async () => {
    const refused = connected({ status: 'reconnect_required', reconnectRequiredAt: new Date('2026-10-03T01:00:00Z') });
    const page = await open({ configure: practice(null, refused) });
    const card = byTestId('xero-card');
    expect(card?.querySelector('mt-badge')?.textContent?.trim()).toBe('Reconnect needed');
    expect(page.text(card)).toContain(
      'Xero refused Materia’s saved sign-in on 3 Oct 2026. Sending to Xero and bringing payments back are paused until someone reconnects; nothing is lost.',
    );
    expect(page.text(card)).not.toContain('Connected as');
    expect(page.calls('xero-options')).toHaveLength(0);
    await page.click('Reconnect Xero');
    expect(callsOf(page, 'integrations-start')).toEqual([expect.objectContaining({ provider: 'xero' })]);
    expect(page.assigned).toEqual([CONSENT]);
  });

  it('shows the connection and fills the organisation and accounts from Xero', async () => {
    const checked = new Date('2026-10-04T02:15:00Z');
    const page = await open({ configure: practice(null, connected({ sync: { paymentsCheckedAt: checked } })) });
    expect(byTestId('xero-card')?.querySelector('mt-badge')?.textContent?.trim()).toBe('Connected');
    expect(page.text(byTestId('xero-card'))).toContain('Connected as Harbour & Vine Legal (demo) on 2 Oct 2026.');
    expect(page.text(byTestId('xero-payments-checked'))).toBe('Payments last checked 4 Oct 2026 at 1:15 pm.');
    expect(callsOf(page, 'xero-options')).toEqual([{}]);

    const select = (name: string) => page.body.querySelector<HTMLSelectElement>(`mt-select[name="${name}"] select`);
    const labels = (name: string) => [...(select(name)?.options ?? [])].map((option) => option.text.trim());
    expect(labels('tenantId')).toEqual(['Choose…', 'Harbour & Vine Legal (demo)', 'Harbour & Vine Holdings (demo)']);
    expect(select('tenantId')?.selectedOptions[0]?.text.trim()).toBe('Harbour & Vine Legal (demo)');
    expect(labels('feesAccountCode')).toEqual(['Choose…', '200 · Professional fees', '260 · Disbursements recovered']);
    // Every invoice from today, sent as it's issued, until someone changes it.
    expect(page.body.querySelector<HTMLInputElement>('mt-text-field[name="sendFrom"] input')?.value).toBe('04/10/2026');
    const toggle = page.body.querySelector<HTMLElement>('mt-switch [role="switch"], mt-switch button');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    // Another organisation brings its own accounts.
    await page.fill('Xero organisation', '1');
    expect(callsOf(page, 'xero-options').at(-1)).toEqual({ tenantId: OTHER });
    expect(labels('feesAccountCode')).toEqual(['Choose…', '410 · Consulting']);
  });

  it('says when payments haven’t been checked yet', async () => {
    const page = await open({ configure: practice(null, connected()) });
    expect(page.text(byTestId('xero-payments-checked'))).toBe('Payments are checked every hour once Xero is set up.');
  });

  it('saves the settings, then offers to send what was issued since the date', async () => {
    const page = await open({ configure: practice(null, connected()) });
    // Both accounts are needed.
    await page.click('Save');
    expect(page.text(byTestId('xero'))).toContain('Choose an account.');
    expect(page.calls('xero-saveSettings')).toHaveLength(0);

    await page.fill('Fees account', '0');
    await page.fill('Disbursements account', '1');
    await page.fill('Send invoices issued from', '01/10/2026');
    page.body.querySelector<HTMLElement>('mt-switch [role="switch"], mt-switch button')?.click();
    await page.stable();
    await page.click('Save');
    expect(callsOf(page, 'xero-saveSettings')).toEqual([
      {
        settings: {
          tenantId: DEMO,
          feesAccountCode: '200',
          disbursementsAccountCode: '260',
          autoPush: false,
          sendFrom: '2026-10-01',
        },
      },
    ]);
    expect(page.text()).toContain('Xero settings saved');
    expect(page.text(byTestId('xero-unsent'))).toContain(
      '3 invoices and credit notes issued since 1 Oct 2026 aren’t in Xero yet.',
    );

    await page.click('Send them to Xero');
    expect(callsOf(page, 'xero-send')).toEqual([{}]);
    expect(page.text()).toContain('Sending 3 to Xero');
    expect(byTestId('xero-unsent')).toBeNull();
  });

  it('starts from the saved settings', async () => {
    const xero = {
      tenantId: DEMO,
      tenantName: 'Harbour & Vine Legal (demo)',
      feesAccountCode: '200',
      disbursementsAccountCode: '260',
      autoPush: false,
      sendFrom: '2026-09-01',
    };
    const page = await open({ configure: practice(xero, connected()) });
    const select = (name: string) => page.body.querySelector<HTMLSelectElement>(`mt-select[name="${name}"] select`);
    expect(select('feesAccountCode')?.selectedOptions[0]?.text.trim()).toBe('200 · Professional fees');
    expect(select('disbursementsAccountCode')?.selectedOptions[0]?.text.trim()).toBe('260 · Disbursements recovered');
    expect(page.body.querySelector<HTMLInputElement>('mt-text-field[name="sendFrom"] input')?.value).toBe('01/09/2026');
    // Nothing changed yet.
    expect(page.buttons('Save')[0]?.hasAttribute('disabled')).toBe(true);
  });

  it('shows why Xero couldn’t be read, inline, and tries again', async () => {
    let fail = true;
    const page = await open({
      configure: practice(null, connected()),
      callables: {
        'xero-options': () => {
          if (fail) {
            throw {
              code: 'functions/failed-precondition',
              details: { code: 'INTEGRATION_RECONNECT_REQUIRED', provider: 'xero' },
            };
          }
          return { tenants: TENANTS, tenantId: DEMO, accounts: ACCOUNTS };
        },
      },
    });
    expect(page.text(byTestId('xero-options-error'))).toContain(
      'This connection has stopped working. Connect it again from Settings.',
    );
    fail = false;
    await page.click('Try again');
    for (let i = 0; i < 3; i++) await page.stable(5);
    expect(byTestId('xero-options-error')).toBeNull();
    expect(page.body.querySelector('mt-select[name="feesAccountCode"]')).not.toBeNull();
  });

  it('disconnects after confirming', async () => {
    const page = await open({ configure: practice(null, connected()) });
    await page.click('Disconnect');
    expect(page.text(page.dialog())).toContain('Disconnect Xero?');
    await page.click('Disconnect Xero', page.dialog() as HTMLElement);
    for (let i = 0; i < 3; i++) await page.stable(5);
    expect(callsOf(page, 'integrations-disconnect')).toEqual([{ provider: 'xero' }]);
    expect(page.text()).toContain('Xero disconnected');
    expect(page.buttons('Connect Xero')).toHaveLength(1);
  });
});
