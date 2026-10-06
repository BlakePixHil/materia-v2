import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, FIRST_LOAD, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

/**
 * Settings → Integrations (INT-03, BILL-09) against the emulators, from seeded status documents:
 * Xero needing reconnecting (the vault marked the saved sign-in refused), then disconnected, in
 * both themes. Connecting itself needs a live Xero (BILL-09a). A fictional practice only.
 */

const uniqueOrg = () => `org-integrations-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test.describe('integrations settings', () => {
  test.skip(({ isMobile }) => isMobile, 'The settings sidebar is the desktop layout');

  test('Xero’s card shows when it needs reconnecting, then when it’s disconnected', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const now = new Date();
    const meta = { createdAt: now, createdBy: 'e2e', updatedAt: now, updatedBy: 'e2e', schemaVersion: 1 };
    const status = (data: Record<string, unknown>) => ({
      path: `orgs/${orgId}/integrationStatus/xero`,
      data: { provider: 'xero', level: 'org', uid: null, scopes: [], ...meta, ...data },
    });
    await setEmulatorDocuments(request, [
      {
        path: `orgs/${orgId}`,
        data: {
          name: 'Fictional Ledger Legal',
          practiceType: 'wills_estates',
          jurisdictions: ['VIC'],
          primaryJurisdiction: 'VIC',
          timezone: 'Australia/Melbourne',
          holidayLocality: 'VIC_MELBOURNE',
          retentionYears: 7,
          billing: { unitMinutes: 6, rounding: 'up', gstRegistered: true, defaultRateCents: 30000 },
          matterNumberFormat: 'M-{YYYY}-{seq:4}',
          fy: { startMonth: 7 },
          plan: 'trial',
          security: { mfaRequired: false, sessionIdleMinutes: 60 },
          flags: { 'integrations.xero': true },
          ...meta,
        },
      },
      status({
        status: 'reconnect_required',
        reason: 'revoked',
        account: { tenantName: 'Fictional Ledger Legal (demo)' },
        connectedAt: new Date('2026-09-01T00:00:00Z'),
        reconnectRequiredAt: new Date('2026-10-03T01:00:00Z'),
      }),
    ]);
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'owner', orgName: 'Fictional Ledger Legal' },
      displayName: 'Priya Fictional',
    });

    await page.goto('/settings/integrations');
    await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible(FIRST_LOAD);
    const card = page.getByTestId('xero-card');
    await expect(card.getByText('Reconnect needed')).toBeVisible(FIRST_LOAD);
    await expect(card).toContainText('Xero refused Materia’s saved sign-in on 3 Oct 2026.');
    await expect(card.getByRole('button', { name: 'Reconnect Xero' })).toBeVisible();
    await expectNoA11yViolations(page);

    // Disconnected: no badge, and Connect instead (the page follows the status document live).
    await setEmulatorDocuments(request, [
      status({ status: 'disconnected', reason: 'disconnected', disconnectedAt: now, disconnectedBy: 'e2e' }),
    ]);
    await expect(card.getByRole('button', { name: 'Connect Xero' })).toBeVisible();
    await expect(card.getByText('Reconnect needed')).toHaveCount(0);

    // The reconnect state in the dark theme.
    await setEmulatorDocuments(request, [
      status({ status: 'reconnect_required', reason: 'revoked', reconnectRequiredAt: now }),
    ]);
    await page.evaluate(() => localStorage.setItem('mt-theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(card.getByText('Reconnect needed')).toBeVisible(FIRST_LOAD);
    await expectNoA11yViolations(page);
  });
});
