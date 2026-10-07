import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  expectNoA11yViolations,
  setClerkKey,
  setEmulatorDocuments,
  setOrgFlags,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The Clerk chat panel (AI-06) against the emulators and the fake model: ⌘J on a matter opens the
 * panel scoped to it; a question streams back an answer after Clerk searches the documents and
 * reads the deadlines (shown as it works), with a proposed task as a suggestion card; an answer is
 * rated down with a reason, retried, and a slow one stopped. Asked to add a file note, Clerk drafts
 * it as a card that saves the note once accepted (AI-06b). Fictional data only; the markers in the
 * questions (`[fake:tools]`…) steer the emulator's fake model.
 */

const MATTER = 'm-chat';
/** What `[fake:note]` drafts (the emulator's fake model, AI-06b). */
const DRAFTED_NOTE = 'Called the executor about the house valuation (fictional).';
const NUMBER = 'M-2026-0142';
/** Callables, Cloud Tasks and the first reads cold-start the emulators. */
const SERVER = { timeout: 30_000 };

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, {
    'clerk.enabled': true,
    'clerk.features.chat': true,
    'clerk.features.suggestions': true,
  });
  await setClerkKey(request, orgId);
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Chat Practice' },
    displayName: 'Jordan Fictional',
  });
  await seedClient(request, orgId, account.uid);
  const matter = matterDoc(orgId, account.uid, {
    id: MATTER,
    number: NUMBER,
    title: 'Estate of Fictional Harrow',
    responsibleUid: account.uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [{ path: matter.path, data: { ...matter.data, stageId: 'intake' } }]);
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Clerk' });
const composer = (page: Page) => panel(page).getByRole('textbox', { name: 'Ask Clerk' });

async function ask(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.describe('Clerk chat panel', () => {
  test.skip(({ isMobile }) => isMobile, 'The Clerk panel is a desktop feature; phones have no way to open it yet');

  test('answers about the matter with tools, proposes a task, takes feedback and retries', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await setUp(page, request);
    await page.goto(`/matters/${MATTER}/overview`);
    await expect(page.getByRole('heading', { name: 'Estate of Fictional Harrow' })).toBeVisible(SERVER);

    await page.keyboard.press('Control+j');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText(`Asking about ${NUMBER}`)).toBeVisible(SERVER);
    // The commands still to come are listed but can't be picked.
    await composer(page).fill('/t');
    await expect(panel(page).getByRole('option', { name: /timeline/ })).toHaveAttribute('aria-disabled', 'true');

    await ask(page, '[fake:tools] [fake:propose] Who is the executor?');
    const answer = panel(page).getByRole('article', { name: 'Clerk' }).last();
    await expect(answer).toContainText('Fake Clerk reply after checking the matter.', SERVER);
    await expect(panel(page).getByText('Request certified copies of the death certificate')).toBeVisible(SERVER);
    await expectNoA11yViolations(page);

    await answer.getByRole('button', { name: 'Not helpful' }).click();
    await panel(page).getByRole('button', { name: 'Missing or wrong sources' }).click();
    await expect(page.locator('.mt-toaster')).toContainText('Thanks for the feedback', SERVER);

    await answer.getByRole('button', { name: 'Retry' }).click();
    await expect(panel(page).getByRole('article', { name: 'Clerk' })).toHaveCount(2, SERVER);
    await expect(panel(page).getByRole('article', { name: 'Clerk' }).last()).toContainText(
      'Fake Clerk reply after checking the matter.',
      SERVER,
    );
  });

  test('drafts a file note when asked, and saves it only once accepted (AI-06b)', async ({ page, request }) => {
    test.setTimeout(150_000);
    await setUp(page, request);
    await page.goto(`/matters/${MATTER}/overview`);
    await expect(page.getByRole('heading', { name: 'Estate of Fictional Harrow' })).toBeVisible(SERVER);
    await page.keyboard.press('Control+j');
    await expect(panel(page).getByText(`Asking about ${NUMBER}`)).toBeVisible(SERVER);

    await ask(page, '[fake:note] Add a file note saying I called the executor about the house valuation.');
    const answer = panel(page).getByRole('article', { name: 'Clerk' }).last();
    await expect(answer).toContainText('waiting below for you to confirm', SERVER);
    await expect(panel(page).getByText(DRAFTED_NOTE).first()).toBeVisible(SERVER);
    await expectNoA11yViolations(page);

    await panel(page).getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('.mt-toaster')).toContainText('Suggestion accepted', SERVER);
    // The card leaves once accepted; the note is on the matter.
    await expect(panel(page).getByRole('button', { name: 'Add note' })).toHaveCount(0, SERVER);
    await page.goto(`/matters/${MATTER}/notes`);
    await expect(page.getByRole('heading', { level: 2, name: 'Notes' })).toBeVisible(SERVER);
    await expect(page.getByText(DRAFTED_NOTE).first()).toBeVisible(SERVER);
  });

  test('stops a slow answer and keeps what was written', async ({ page, request }) => {
    test.setTimeout(120_000);
    await setUp(page, request);
    await page.goto(`/matters/${MATTER}/overview`);
    await expect(page.getByRole('heading', { name: 'Estate of Fictional Harrow' })).toBeVisible(SERVER);
    await page.keyboard.press('Control+j');

    await ask(page, '[fake:slow] Tell me everything.');
    const answer = panel(page).getByRole('article', { name: 'Clerk' }).last();
    await expect(answer).toContainText('word1', SERVER);
    await panel(page).getByRole('button', { name: 'Stop' }).click();
    await expect(answer).toContainText('Stopped. This answer is incomplete.', SERVER);
    await expect(answer).not.toContainText('word80');
  });
});
