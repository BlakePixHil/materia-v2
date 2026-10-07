import { expect, test, type APIRequestContext } from '@playwright/test';

import { LEGAL_DOCUMENTS, TERMS_VERSION } from '@materia/domain';
import {
  createTestAccount,
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_CALL,
  FIRST_LOAD,
  signInThroughUi,
  uniqueEmail,
} from '@materia/test-utils/e2e';

/**
 * The legal pages and terms acceptance (SEC-01) against the emulators: every document at `/legal`
 * signed out, an owner accepting the terms before the app (and when creating a practice), and a
 * lawyer never being asked. Every person and practice is fictional.
 */

/** Signing in, then the guards waiting on the org document, on a busy emulator. */
const SERVER = { timeout: 20_000 };

type RestFields = Record<string, { stringValue?: string; timestampValue?: string } | undefined>;

/** A document's fields, read through the Firestore emulator's admin access. */
async function readDocument(request: APIRequestContext, path: string): Promise<RestFields> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { fields?: RestFields }).fields ?? {};
}

function expectTermsAccepted(org: RestFields, uid: string): void {
  expect(org['termsAcceptedVersion']?.stringValue).toBe(TERMS_VERSION);
  expect(org['termsAcceptedBy']?.stringValue).toBe(uid);
  expect(Date.parse(org['termsAcceptedAt']?.timestampValue ?? '')).toBeGreaterThan(Date.now() - 10 * 60_000);
}

test.describe('legal pages, signed out', () => {
  test('the index lists every document, and sign-in links to the privacy policy and terms', async ({ page }) => {
    await page.goto('/auth/sign-in');
    const legal = page.getByRole('navigation', { name: 'Legal' });
    await expect(legal.getByRole('link', { name: 'Terms of service' })).toHaveAttribute('href', '/legal/terms');
    await legal.getByRole('link', { name: 'Privacy policy' }).click();
    await expect(page).toHaveURL(/\/legal\/privacy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();

    await page.goto('/legal');
    await expect(page.getByRole('heading', { level: 1, name: 'Legal' })).toBeVisible();
    for (const doc of LEGAL_DOCUMENTS) {
      await expect(page.getByRole('link', { name: doc.title, exact: true }).first()).toHaveAttribute(
        'href',
        `/legal/${doc.key}`,
      );
    }
    await expectNoA11yViolations(page);
  });

  for (const doc of LEGAL_DOCUMENTS) {
    test(`${doc.title} (/legal/${doc.key})`, async ({ page }) => {
      await page.goto(`/legal/${doc.key}`);
      await expect(page).toHaveTitle(new RegExp(`^${doc.title}`));
      await expect(page.getByRole('heading', { level: 1, name: doc.title })).toBeVisible();
      await expect(page.getByText(`Version ${doc.version} · Effective`)).toBeVisible();
      if (doc.status === 'draft')
        await expect(page.getByRole('note').first()).toContainText('Draft — not yet reviewed');
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }
});

test.describe('terms acceptance', () => {
  test('an owner whose practice hasn’t accepted the terms accepts them first, and the org records it', async ({
    page,
    request,
  }) => {
    const orgId = `org-terms-${Date.now().toString(36)}`;
    const owner = await createTestAccount(request, {
      claims: { orgId, role: 'owner', orgName: 'Fictional Terms Legal' },
      displayName: 'Avery Fictional',
      termsAccepted: false,
    });
    await signInThroughUi(page, owner);
    await expect(page).toHaveURL(/\/accept-terms/, SERVER);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accept the terms for Fictional Terms Legal');
    await expect(page.getByRole('heading', { name: 'The terms in brief' })).toBeVisible();
    await expect(page.getByRole('link', { name: /data processing addendum/ }).first()).toHaveAttribute(
      'target',
      '_blank',
    );
    await expectNoA11yViolations(page);

    // The box must be ticked.
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(page.getByText('Tick this box to continue.')).toBeVisible();

    await page.getByRole('checkbox', { name: /I’ve read the terms of service/ }).click();
    const accepted = page.waitForResponse((r) => r.url().includes('orgs-acceptTerms'), FIRST_CALL);
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    expect((await accepted).ok()).toBe(true);
    await expect(page).toHaveURL(/\/today$/, SERVER);
    expectTermsAccepted(await readDocument(request, `orgs/${orgId}`), owner.uid);

    // Not asked again, after a fresh load either.
    await page.goto('/accept-terms');
    await expect(page).toHaveURL(/\/today$/, FIRST_LOAD);
  });

  test('a lawyer in a practice that hasn’t accepted the terms is never asked', async ({ page, request }) => {
    const orgId = `org-terms-lawyer-${Date.now().toString(36)}`;
    const lawyer = await createTestAccount(request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Unsigned Legal' },
      termsAccepted: false,
    });
    await signInThroughUi(page, lawyer);
    await expect(page).toHaveURL(/\/today$/, SERVER);
    expect((await readDocument(request, `orgs/${orgId}`))['termsAcceptedVersion']).toBeUndefined();
    await page.goto('/accept-terms');
    await expect(page).toHaveURL(/\/today$/, FIRST_LOAD);
  });

  test('creating a practice accepts the terms for it', async ({ page, request }) => {
    const founder = await createTestAccount(request, {
      claims: {},
      displayName: 'Morgan Fictional',
      email: uniqueEmail('terms'),
    });
    await signInThroughUi(page, founder);
    await expect(page).toHaveURL(/\/onboarding$/, SERVER);
    await page.getByLabel('Practice name').fill('Fictional Founders Legal');
    await page.getByRole('button', { name: 'Create practice' }).click();
    await expect(page.getByText('Tick this box to continue.')).toBeVisible();
    await page.getByRole('checkbox', { name: /I accept the terms of service/ }).click();
    await page.getByRole('button', { name: 'Create practice' }).click();
    // Straight into the app: the owner accepted the terms as they created the practice.
    await expect(page).toHaveURL(/\/today$/, SERVER);
    const orgId = (await readDocument(request, `users/${founder.uid}`))['activeOrgId']?.stringValue ?? '';
    expect(orgId).not.toBe('');
    expectTermsAccepted(await readDocument(request, `orgs/${orgId}`), founder.uid);
  });
});
