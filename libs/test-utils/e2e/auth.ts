import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Auth helpers for e2e against the Firebase emulators (project `demo-materia`). Accounts are
 * created through the emulator's admin API (`Bearer owner`), which skips the sign-up blocking
 * function, as the Admin SDK does. All accounts are fictional (`@example.test`).
 */
export const EMULATOR_PROJECT = 'demo-materia';
export const AUTH_EMULATOR = 'http://127.0.0.1:9099';
export const FIRESTORE_EMULATOR = 'http://127.0.0.1:8080';
export const TEST_PASSWORD = 'fictional-e2e-password';
const ADMIN = { Authorization: 'Bearer owner' };

export interface TestAccount {
  uid: string;
  email: string;
  password: string;
}

export interface TestAccountOptions {
  /** Custom claims; defaults to a lawyer in `org-e2e`. Pass `{}` for someone without an org. */
  claims?: Record<string, unknown>;
  emailVerified?: boolean;
  displayName?: string;
}

/** A unique fictional email for this test. */
export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.test`;
}

export async function createTestAccount(
  request: APIRequestContext,
  options: TestAccountOptions = {},
): Promise<TestAccount> {
  const email = uniqueEmail();
  const created = await request.post(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts`,
    {
      headers: ADMIN,
      data: {
        email,
        password: TEST_PASSWORD,
        displayName: options.displayName ?? 'Jordan Price',
        emailVerified: options.emailVerified ?? true,
      },
    },
  );
  expect(created.ok(), await created.text()).toBe(true);
  const { localId } = (await created.json()) as { localId: string };
  const claims = options.claims ?? { orgId: 'org-e2e', role: 'lawyer', orgName: 'Harbour & Vine Legal' };
  const updated = await request.post(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`,
    {
      headers: ADMIN,
      data: { localId, customAttributes: JSON.stringify(claims) },
    },
  );
  expect(updated.ok(), await updated.text()).toBe(true);
  return { uid: localId, email, password: TEST_PASSWORD };
}

/** Signs in through the sign-in page (email, then password). */
export async function signInThroughUi(
  page: Page,
  account: Pick<TestAccount, 'email' | 'password'>,
  url = '/auth/sign-in',
): Promise<void> {
  await page.goto(url);
  await page.getByLabel('Work email').fill(account.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A ready account (verified, in an org), signed in and on Today. */
export async function signInAsTestUser(
  page: Page,
  request: APIRequestContext,
  options: TestAccountOptions = {},
): Promise<TestAccount> {
  const account = await createTestAccount(request, options);
  await signInThroughUi(page, account);
  await expect(page).toHaveURL(/\/today$/);
  return account;
}

/** The latest out-of-band code the Auth emulator "emailed" to this address. */
export async function latestOobCode(
  request: APIRequestContext,
  email: string,
  type: 'VERIFY_EMAIL' | 'PASSWORD_RESET',
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await request.get(`${AUTH_EMULATOR}/emulator/v1/projects/${EMULATOR_PROJECT}/oobCodes`);
    const { oobCodes } = (await response.json()) as {
      oobCodes: { email: string; requestType: string; oobCode: string }[];
    };
    const match = oobCodes.filter((c) => c.email === email && c.requestType === type).at(-1);
    if (match) return match.oobCode;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No ${type} code for ${email}`);
}

/** Writes a pending invite through the Firestore emulator's admin access (rules bypassed). */
export async function createInvite(request: APIRequestContext, email: string, orgId = 'org-e2e'): Promise<void> {
  const id = `invite-${Date.now().toString(36)}`;
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const response = await request.patch(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/invites/${id}`,
    {
      headers: ADMIN,
      data: {
        fields: {
          email: { stringValue: email.toLowerCase() },
          role: { stringValue: 'paralegal' },
          status: { stringValue: 'pending' },
          tokenHash: { stringValue: 'f'.repeat(64) },
          invitedBy: { stringValue: 'e2e-owner' },
          expiresAt: { timestampValue: expiresAt },
        },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

/** Sets an org's feature flag overrides through the Firestore emulator (what `flags-setOrgOverride` writes). */
export async function setOrgFlags(
  request: APIRequestContext,
  orgId: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const fields = Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, { booleanValue: value }]));
  const response = await request.patch(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}`,
    {
      headers: ADMIN,
      data: { fields: { name: { stringValue: 'Fictional e2e practice' }, flags: { mapValue: { fields } } } },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}
