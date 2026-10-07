import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { DomainError, resolveSecurity, type Role } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { CONNECTOR_BROWSER } from './connector-browser';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/** The Claude connector's consent page and Settings page (INT-07), against fakes. A fictional practice only. */

const ORG = 'org-harbour-vine';
const ORIGIN = 'https://materia.example';
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const FLAG = 'integrations.claudeConnector';
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};
const session = (role: Role, uid = `u-${role}`) =>
  testSession({ uid, displayName: `Fictional ${role}`, claims: { orgId: ORG, role, orgName: 'Harbour & Vine Legal' } });

const connection = (uid: string, extra: Record<string, unknown> = {}) => ({
  uid,
  clientId: CLAUDE,
  clientName: 'Claude',
  scopes: ['materia.read', 'materia.propose'],
  status: 'active',
  authTime: new Date('2026-10-06T00:00:00Z'),
  secondFactor: false,
  connectedAt: new Date('2026-10-06T00:00:00Z'),
  lastUsedAt: new Date('2026-10-07T00:00:00Z'),
  ...meta,
  ...extra,
});

function authorizeUrl(overrides: Record<string, string | null> = {}): string {
  const params = new URLSearchParams();
  const values: Record<string, string | null> = {
    response_type: 'code',
    client_id: CLAUDE,
    redirect_uri: CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'materia.read materia.propose',
    state: 'xyz-state',
    resource: `${ORIGIN}/mcp`,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) if (value !== null) params.set(key, value);
  return `/connect/claude?${params.toString()}`;
}

async function open(
  who: AuthSession,
  url: string,
  options: { flag?: boolean; practice?: Record<string, unknown> | null; connections?: Record<string, unknown> } = {},
) {
  const port = new FakeAuthPort(who);
  const firestore = new InMemoryFirestore();
  const tenancy = new FakeTenancyPort();
  tenancy.security_ = { policy: resolveSecurity({ mfaRequired: false }), validAfter: null };
  const practice = options.practice === undefined ? { enabled: true, allowProposals: true } : options.practice;
  firestore.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    ...(practice ? { settings: { connector: practice } } : {}),
    ...meta,
  });
  for (const [uid, role, name] of [
    ['u-owner', 'owner', 'Jordan Price'],
    ['u-lawyer', 'lawyer', 'Priya Shah'],
    ['u-admin', 'admin', 'Daniel Kim'],
  ] as const) {
    firestore.set(`orgs/${ORG}/members/${uid}`, {
      displayName: name,
      email: `${uid}@example.test`,
      role,
      status: 'active',
      ...meta,
    });
  }
  for (const [id, data] of Object.entries(options.connections ?? {})) {
    firestore.set(`orgs/${ORG}/connectorConnections/${id}`, data as Record<string, unknown>);
  }
  const browser = { origin: () => ORIGIN, assign: vi.fn(), copy: vi.fn(async () => undefined) };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: tenancy },
      { provide: CONNECTOR_BROWSER, useValue: browser },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags({ [FLAG]: options.flag ?? true }),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle(20);
    await fixture.whenStable();
  };
  await router.navigateByUrl(url);
  await stable();
  const button = (text: string, root: ParentNode = document.body) => {
    const found = [...root.querySelectorAll<HTMLElement>('button, a')].find((b) => b.textContent?.trim() === text);
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  return {
    port,
    firestore,
    browser,
    router,
    el,
    stable,
    button,
    text: (root: Element | null = el) => root?.textContent?.replace(/\s+/g, ' ') ?? '',
    dialog: () => document.body.querySelector<HTMLElement>('.mt-dialog'),
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

describe('the consent page (/connect/claude)', () => {
  it('asks the person to allow Claude, as them, in their practice, and says what it can and can’t do', async () => {
    const page = await open(session('lawyer'), authorizeUrl());
    expect(page.text()).toContain('Allow Claude to use Materia?');
    expect(page.text(page.el.querySelector('[data-testid="who"]'))).toContain(
      'Claude will work as you, Fictional lawyer, in Harbour & Vine Legal',
    );
    const scopes = page.text(page.el.querySelector('[data-testid="scopes"]'));
    expect(scopes).toContain('Read your matters');
    expect(scopes).toContain('Suggest changes');
    const note = page.text(page.el.querySelector('[data-testid="data-note"]'));
    expect(note).toContain('processed by Anthropic outside Australia');
    expect(note).toContain('Privileged matters and the text of documents are never shared');
    expect(page.text(page.el.querySelector('[data-testid="client-host"]')).trim()).toBe('Asked by claude.ai');
    expect(page.el.querySelector('[data-testid="local-app"]')).toBeNull();
  });

  it('warns that Claude Code is an app on this computer', async () => {
    const page = await open(
      session('lawyer'),
      authorizeUrl({ client_id: CLAUDE_CODE, redirect_uri: 'http://127.0.0.1:53682/callback' }),
    );
    expect(page.text()).toContain('Allow Claude Code to use Materia?');
    expect(page.text(page.el.querySelector('[data-testid="local-app"]'))).toContain(
      'Claude Code is an app on this computer. Allow it only if you just asked it to connect to Materia yourself.',
    );
    expect(page.el.querySelector('[data-testid="client-host"]')).toBeNull();
  });

  it('allows: records the connection and goes back to Claude with the code', async () => {
    const page = await open(session('lawyer'), authorizeUrl());
    const redirectUrl = `${CALLBACK}?code=mtc.abc&state=xyz-state&iss=${encodeURIComponent(ORIGIN)}`;
    page.port.callResults['connector-authorize'] = { redirectUrl, connectionId: 'conn-1' };
    await page.click('Allow');
    expect(page.callsTo('connector-authorize')).toEqual([
      {
        requestId: expect.any(String),
        clientId: CLAUDE,
        redirectUri: CALLBACK,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        scopes: ['materia.read', 'materia.propose'],
        state: 'xyz-state',
        resource: `${ORIGIN}/mcp`,
        origin: ORIGIN,
      },
    ]);
    expect(page.browser.assign).toHaveBeenCalledWith(redirectUrl);
    expect(page.text()).toContain('Returning to Claude…');
  });

  it('cancels back to Claude with access_denied', async () => {
    const page = await open(session('lawyer'), authorizeUrl());
    await page.click('Cancel');
    const url = new URL(page.browser.assign.mock.calls[0]?.[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(CALLBACK);
    expect(Object.fromEntries(url.searchParams)).toEqual({ error: 'access_denied', state: 'xyz-state', iss: ORIGIN });
    expect(page.callsTo('connector-authorize')).toEqual([]);
  });

  it('refuses an unknown client or redirect without sending the browser anywhere', async () => {
    for (const overrides of [
      { client_id: 'https://evil.example/client' },
      { redirect_uri: 'https://evil.example/cb' },
    ]) {
      const page = await open(session('lawyer'), authorizeUrl(overrides));
      expect(page.text()).toContain('This connection request isn’t valid');
      expect(page.browser.assign).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
    }
  });

  it('sends any other problem straight back to Claude as an OAuth error', async () => {
    const page = await open(session('lawyer'), authorizeUrl({ code_challenge_method: 'plain' }));
    const url = new URL(page.browser.assign.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('error')).toBe('invalid_request');
    expect(url.searchParams.get('state')).toBe('xyz-state');
    expect(page.text()).not.toContain('Allow Claude');
  });

  it('says when the practice hasn’t turned the connector on, and where an admin turns it on', async () => {
    const lawyer = await open(session('lawyer'), authorizeUrl(), { practice: null });
    expect(lawyer.text(lawyer.el.querySelector('[data-testid="unavailable"]'))).toContain(
      'An owner or admin can turn it on in Settings → Claude connector',
    );
    expect(lawyer.text()).not.toContain('Open Claude connector settings');
    TestBed.resetTestingModule();
    const admin = await open(session('admin'), authorizeUrl(), { practice: { enabled: false, allowProposals: true } });
    expect(admin.button('Open Claude connector settings').getAttribute('href')).toBe('/settings/claude');
    await admin.click('Back to Claude');
    expect(new URL(admin.browser.assign.mock.calls[0]?.[0] as string).searchParams.get('error')).toBe('access_denied');
  });

  it('says so when the flag is off, or the server finds the connector off', async () => {
    const off = await open(session('lawyer'), authorizeUrl(), { flag: false });
    expect(off.text()).toContain('The Claude connector isn’t available for your practice yet.');
    TestBed.resetTestingModule();
    const page = await open(session('lawyer'), authorizeUrl());
    vi.spyOn(page.port, 'call').mockRejectedValueOnce(new DomainError('CONNECTOR_OFF', 'off'));
    await page.click('Allow');
    expect(page.text(page.el.querySelector('[data-testid="unavailable"]'))).toContain(
      'Your practice hasn’t turned on the Claude connector.',
    );
    expect(page.browser.assign).not.toHaveBeenCalled();
  });

  it('notes when suggesting can’t do anything for this person', async () => {
    const page = await open(session('readonly'), authorizeUrl(), { practice: { enabled: true, allowProposals: true } });
    expect(page.text(page.el.querySelector('[data-testid="scopes"]'))).toContain('Your role can’t make these changes');
    TestBed.resetTestingModule();
    const off = await open(session('lawyer'), authorizeUrl(), { practice: { enabled: true, allowProposals: false } });
    expect(off.text(off.el.querySelector('[data-testid="scopes"]'))).toContain(
      'Your practice has turned suggestions off',
    );
  });
});

describe('Settings → Claude connector (/settings/claude)', () => {
  const connections = {
    'c-mine': connection('u-lawyer'),
    'c-owner': connection('u-owner', { clientName: 'Claude Code', connectedAt: new Date('2026-10-05T00:00:00Z') }),
    'c-old': connection('u-lawyer', { status: 'revoked' }),
  };

  it('shows a lawyer the address to add, their own connections, and the practice’s switches read-only', async () => {
    const page = await open(session('lawyer'), '/settings/claude', { connections });
    expect(page.text(page.el.querySelector('[data-testid="server-url"]'))).toBe(`${ORIGIN}/mcp`);
    expect(page.el.querySelector('[data-value="enabled"]')?.textContent?.trim()).toBe('On');
    expect(page.el.querySelector('mt-switch')).toBeNull();
    const mine = page.el.querySelectorAll('[data-testid="mine"] mt-settings-row');
    expect(mine).toHaveLength(1);
    expect(page.text(mine[0] ?? null)).toContain('Claude');
    expect(page.text(mine[0] ?? null)).toContain('Read your matters, Suggest changes');
    expect(page.el.querySelector('[data-testid="everyone"]')).toBeNull();
    expect(page.text(page.el.querySelector('[data-testid="disclosure"]'))).toContain(
      'processed by Anthropic outside Australia',
    );
    expect(page.text(page.el.querySelector('[data-testid="disclosure"]'))).toContain(
      'use the practice’s Claude Team or Enterprise accounts, not personal ones',
    );

    await page.click('Copy');
    expect(page.browser.copy).toHaveBeenCalledWith(`${ORIGIN}/mcp`);
  });

  it('disconnects the person’s own connection after confirming', async () => {
    const page = await open(session('lawyer'), '/settings/claude', { connections });
    page.port.callResults['connector-disconnect'] = { revoked: true };
    await page.click('Disconnect', page.el.querySelector('[data-testid="mine"]') ?? undefined);
    expect(page.text(page.dialog())).toContain('Disconnect Claude?');
    await page.click('Disconnect', page.dialog() ?? undefined);
    expect(page.callsTo('connector-disconnect')).toEqual([{ requestId: expect.any(String), connectionId: 'c-mine' }]);
    expect(page.text(document.body)).toContain('Claude disconnected');
  });

  it('lets an admin turn suggestions off, and see and end anyone’s connection', async () => {
    const page = await open(session('admin'), '/settings/claude', { connections });
    page.port.callResults['connector-setPractice'] = { enabled: true, allowProposals: false, revoked: 0 };
    const everyone = page.el.querySelector('[data-testid="everyone"]');
    expect(page.text(everyone)).toContain('Priya Shah · Claude');
    expect(page.text(everyone)).toContain('Jordan Price · Claude Code');

    const proposals = page.el.querySelector<HTMLElement>('mt-switch[name="allowProposals"] button');
    proposals?.click();
    await page.stable();
    expect(page.callsTo('connector-setPractice')).toEqual([
      { requestId: expect.any(String), enabled: true, allowProposals: false },
    ]);

    page.port.callResults['connector-disconnect'] = { revoked: true };
    const jordan = [...(everyone?.querySelectorAll('mt-settings-row') ?? [])].find((row) =>
      row.textContent?.includes('Jordan Price'),
    );
    await page.click('Disconnect', jordan);
    expect(page.text(page.dialog())).toContain('Disconnect Jordan Price’s Claude Code?');
    await page.click('Disconnect', page.dialog() ?? undefined);
    expect(page.callsTo('connector-disconnect')).toEqual([{ requestId: expect.any(String), connectionId: 'c-owner' }]);
  });

  it('warns before turning the connector off, which ends every connection', async () => {
    const page = await open(session('owner'), '/settings/claude', { connections });
    page.port.callResults['connector-setPractice'] = { enabled: false, allowProposals: true, revoked: 2 };
    const enabled = () => page.el.querySelector<HTMLElement>('mt-switch[name="enabled"] button');

    enabled()?.click();
    await page.stable();
    expect(page.text(page.dialog())).toContain('All 2 connections end at once.');
    await page.click('Cancel', page.dialog() ?? undefined);
    expect(page.callsTo('connector-setPractice')).toEqual([]);
    expect(enabled()?.getAttribute('aria-checked')).toBe('true');

    enabled()?.click();
    await page.stable();
    await page.click('Turn off', page.dialog() ?? undefined);
    expect(page.callsTo('connector-setPractice')).toEqual([
      { requestId: expect.any(String), enabled: false, allowProposals: true },
    ]);
    expect(page.text(document.body)).toContain('2 connections ended.');
  });

  it('isn’t there while the flag is off', async () => {
    const page = await open(session('owner'), '/settings/claude', { flag: false });
    expect(page.router.url).toBe('/today');
  });
});
