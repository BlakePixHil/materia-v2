import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Page, type Response } from '@playwright/test';

import {
  expectNoA11yViolations,
  FIRST_CALL,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, uniqueOrg } from './support/matters';

/**
 * The Claude connector (INT-07, ADR-064) against the emulators: an owner turns it on in Settings,
 * allows Claude Code on the consent page and is sent back to Claude Code's loopback callback with a
 * code. Through Hosting (CI's emulator), the code is exchanged for tokens and Claude's MCP calls
 * read the practice's matters, until the owner disconnects it. `ng serve` has no Hosting rewrites,
 * so locally the token and MCP steps skip. Fictional data only.
 */

const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const CALLBACK = 'http://localhost:53682/callback';

/** A callable's answer (the POST, not its CORS preflight), failing with what the server said. */
const answered = (page: Page, name: string) =>
  page.waitForResponse((r) => r.url().endsWith(`/${name}`) && r.request().method() === 'POST', FIRST_CALL);
async function expectOk(response: Promise<Response>): Promise<void> {
  const answer = await response;
  expect(answer.ok(), `${answer.status()} ${await answer.text().catch(() => '')}`).toBe(true);
}

test.describe('Claude connector', () => {
  test.skip(({ isMobile }) => isMobile, 'The settings sidebar is the desktop layout');

  test('an owner turns it on and connects Claude Code, which reads matters until it is disconnected', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const orgId = uniqueOrg();
    const now = new Date();
    const meta = { createdAt: now, createdBy: 'e2e', updatedAt: now, updatedBy: 'e2e', schemaVersion: 1 };
    await setEmulatorDocuments(request, [
      {
        path: `orgs/${orgId}`,
        data: {
          name: 'Fictional Connector Legal',
          practiceType: 'wills_estates',
          jurisdictions: ['VIC'],
          primaryJurisdiction: 'VIC',
          timezone: 'Australia/Melbourne',
          holidayLocality: 'VIC_MELBOURNE',
          retentionYears: 7,
          matterNumberFormat: 'M-{YYYY}-{seq:4}',
          fy: { startMonth: 7 },
          plan: 'trial',
          security: { mfaRequired: false, sessionIdleMinutes: 60 },
          flags: { 'integrations.claudeConnector': true },
          ...meta,
        },
      },
    ]);
    const owner = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'owner', orgName: 'Fictional Connector Legal' },
      displayName: 'Priya Fictional',
    });
    await setEmulatorDocuments(request, [
      matterDoc(orgId, owner.uid, {
        id: 'm-ada',
        number: 'M-2026-0001',
        title: 'Estate of Ada Fictional',
        responsibleUid: owner.uid,
        daysAgo: 1,
      }),
    ]);

    // Off until an owner or admin turns it on.
    await page.goto('/settings/claude');
    await expect(page.getByRole('heading', { name: 'Claude connector', level: 1 })).toBeVisible(FIRST_LOAD);
    const enabled = page.getByRole('switch', { name: 'Let people connect Claude' });
    await expect(enabled).not.toBeChecked(FIRST_LOAD);
    const turnedOn = answered(page, 'connector-setPractice');
    await enabled.click();
    await expectOk(turnedOn);
    const origin = new URL(page.url()).origin;
    await expect(page.getByTestId('server-url')).toHaveText(`${origin}/mcp`, FIRST_LOAD);
    await expectNoA11yViolations(page);

    // Claude Code asks for access: the consent page, then back to its loopback callback with a code.
    await page.route(`${CALLBACK}**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Claude Code</title>' }),
    );
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: CLAUDE_CODE,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'materia.read materia.propose',
      state: 'e2e-state',
      resource: `${origin}/mcp`,
    });
    await page.goto(`/connect/claude?${query.toString()}`);
    await expect(page.getByRole('heading', { name: 'Allow Claude Code to use Materia?' })).toBeVisible(FIRST_LOAD);
    await expect(page.getByTestId('who')).toContainText('in Fictional Connector Legal');
    await expectNoA11yViolations(page);
    const allowed = answered(page, 'connector-authorize');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expectOk(allowed);
    await page.waitForURL(`${CALLBACK}**`);
    const back = new URL(page.url());
    expect(back.searchParams.get('state')).toBe('e2e-state');
    expect(back.searchParams.get('iss')).toBe(origin);
    const code = back.searchParams.get('code') ?? '';
    expect(code).toMatch(/^mtc\./);

    // Claude's side, through Hosting's rewrites to connector-api.
    const metadata = await request.get('/.well-known/oauth-authorization-server');
    const hosted = metadata.ok() && (metadata.headers()['content-type'] ?? '').includes('json');
    let accessToken = '';
    const mcp = (body: Record<string, unknown>) =>
      request.post('/mcp', {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        data: { jsonrpc: '2.0', ...body },
      });
    if (hosted) {
      expect(((await metadata.json()) as { issuer: string }).issuer).toBe(origin);
      const token = await request.post('/oauth/token', {
        form: {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: CLAUDE_CODE,
          redirect_uri: CALLBACK,
          resource: `${origin}/mcp`,
        },
        timeout: FIRST_CALL.timeout,
      });
      expect(token.status(), await token.text()).toBe(200);
      accessToken = ((await token.json()) as { access_token: string }).access_token;
      const init = await mcp({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
      });
      expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe(
        'materia',
      );
      const listed = await mcp({ id: 2, method: 'tools/call', params: { name: 'search_matters', arguments: {} } });
      const found = (await listed.json()) as { result: { structuredContent: { matters: { number: string }[] } } };
      expect(found.result.structuredContent.matters.map((m) => m.number)).toEqual(['M-2026-0001']);
    }

    // Settings shows the connection; disconnecting ends Claude's access at once.
    await page.goto('/settings/claude');
    const mine = page.getByTestId('mine');
    await expect(mine).toContainText('Claude Code', FIRST_LOAD);
    await mine.getByRole('button', { name: 'Disconnect' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Disconnect Claude Code?');
    const ended = answered(page, 'connector-disconnect');
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await expectOk(ended);
    await expect(mine).toContainText('You haven’t connected Claude.');
    if (hosted) expect((await mcp({ id: 3, method: 'ping' })).status()).toBe(401);
  });
});
