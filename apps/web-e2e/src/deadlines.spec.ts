import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { isBusinessDay, VIC_CALENDARS } from '@materia/deadlines';
import { addDays, addMonths, today, type DateOnly } from '@materia/domain';
import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_LOAD,
  setEmulatorDocuments,
  setOrgFlags,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';
import { matterTabs } from './support/phone';

/**
 * Deadlines (CORE-10) against the emulators, on a probate matter like the seed's Doyle estate with
 * the illustrative Victorian rule set on: the date of death and the grant date recorded as key
 * facts compute the deadlines; changing them proposes changes instead of moving dates in force;
 * proposals are accepted (a critical one with the matter number typed) or rejected; a date is
 * overridden with a reason; deadlines are marked done; a manual deadline is added; and the
 * Deadlines screen shows the list, the trace and the month calendar. Fictional data only.
 */

const MATTER_NUMBER = 'M-2026-0451';
const CALLABLE_TIMEOUT = { timeout: 20_000 };

const TODAY = today('Australia/Melbourne');
/**
 * The latest day on or before `from` whose derived dates are all business days in every Victorian
 * calendar, so the engine's roll to the next business day never moves a date the test expects.
 */
function settledDay(from: DateOnly, derived: (day: DateOnly) => DateOnly[]): DateOnly {
  let day = from;
  while (!derived(day).every((d) => Object.keys(VIC_CALENDARS).every((id) => isBusinessDay(VIC_CALENDARS, id, d)))) {
    day = addDays(day, -1);
  }
  return day;
}

/** DD/MM/YYYY, as the date fields take it. */
const typed = (date: DateOnly) => `${date.slice(8)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** The Doyle estate: a probate matter with the deceased recorded but no dates yet. */
async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-doyle',
    number: MATTER_NUMBER,
    title: 'Estate of Margaret Doyle',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    {
      ...matter,
      data: {
        ...matter.data,
        stageId: 'intake',
        deceased: { contactId: 'c-doyle', domicile: 'VIC', lastAddress: '12 Fictional Parade, Geelong VIC' },
        estate: { grantType: 'probate' },
      },
    },
    {
      path: `orgs/${orgId}/contacts/c-doyle`,
      data: {
        kind: 'person',
        givenNames: 'Margaret',
        familyName: 'Doyle',
        sortName: 'doyle margaret',
        emails: [],
        phones: [],
        addresses: [],
        tags: [],
        isReferrer: false,
        search: ['margaret', 'doyle'],
        deletedAt: null,
        ...meta(uid),
      },
    },
  ]);
}

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, { 'deadlines.ruleset.vic.v1': true });
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Deadlines Practice' },
    displayName: 'Jordan Fictional',
  });
  await seed(request, orgId, account.uid);
  return { orgId, uid: account.uid };
}

/** A stored deadline's fields, read through the emulator's admin access. */
async function storedDeadline(request: APIRequestContext, orgId: string, id: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-doyle/deadlines/${id}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!response.ok()) return {};
  return ((await response.json()) as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
}

const dueDateOf = async (request: APIRequestContext, orgId: string, id: string) =>
  (await storedDeadline(request, orgId, id))['dueDate']?.['stringValue'];

/** Edits a date key fact on the Overview and waits for the callable's toast. */
async function editDateFact(page: Page, label: string, date: DateOnly): Promise<Locator> {
  const facts = page.locator('mt-key-facts');
  await page.getByRole('button', { name: `Edit ${label}` }).click();
  // The editor renders on the next change detection, which can land after Playwright looks for the
  // field. By role (not getByLabel, which also matches the "Copy …" and "Edit …" buttons and then
  // fails strict mode at once) the fill waits for the text box to appear.
  await facts.getByRole('textbox', { name: label, exact: true }).fill(typed(date));
  await facts.getByRole('button', { name: 'Save' }).click();
  // The editor closes only once the save went through, so wait on that rather than the toast: an
  // earlier "… saved" toast for the same fact can still be up. Then check the toaster as a whole,
  // so a failure shows what it did say.
  await expect(facts.locator('form'), `${label} editor closes after the save`).toHaveCount(0, CALLABLE_TIMEOUT);
  const toaster = page.locator('.mt-toaster');
  await expect(toaster).toContainText(`${label} saved`);
  return toaster;
}

const deadlineRow = (page: Page, title: string) => page.locator('mt-deadline-row').filter({ hasText: title });
const changeRow = (page: Page, title: string) =>
  page.locator('mt-pending-changes li').filter({ has: page.locator('.title', { hasText: title }) });

async function openTab(page: Page, name: string): Promise<void> {
  await matterTabs(page).getByRole('link', { name }).click();
}

test.describe('deadlines', () => {
  test('a new date of death proposes changes; accept, reject and a typed confirmation', async ({ page, request }) => {
    test.setTimeout(150_000);
    const { orgId } = await setUp(page, request);
    // Executor's year is 12 months on (also from the day before); the claim period 6 months on
    // (also from 7 months before).
    const deathDay = settledDay(addDays(TODAY, -60), (d) => [addMonths(d, 12), addMonths(addDays(d, -1), 12)]);
    const grantDay = settledDay(addDays(TODAY, -30), (d) => [addMonths(d, 6), addMonths(addMonths(d, -7), 6)]);

    // Recording the date of death and the grant date computes the deadlines (nothing in force yet).
    await page.goto('/matters/m-doyle/overview');
    // The first read after a page load can be slow while other specs keep the emulators busy.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Estate of Margaret Doyle', CALLABLE_TIMEOUT);
    const first = await editDateFact(page, 'Date of death', deathDay);
    await expect(first).toContainText(/deadlines? added/);
    await editDateFact(page, 'Grant date', grantDay);
    await expect
      .poll(() => dueDateOf(request, orgId, 'rule-org.executor_year'), CALLABLE_TIMEOUT)
      .toBe(addMonths(deathDay, 12));
    await expect
      .poll(() => dueDateOf(request, orgId, 'rule-vic.fp.limitation'), CALLABLE_TIMEOUT)
      .toBe(addMonths(grantDay, 6));

    // A day earlier: proposals, not silent changes.
    const toast = await editDateFact(page, 'Date of death', addDays(deathDay, -1));
    await expect(toast).toContainText(/deadline changes? needs? review/);
    expect(await dueDateOf(request, orgId, 'rule-org.executor_year')).toBe(addMonths(deathDay, 12));

    await openTab(page, 'Deadlines');
    await expect(page).toHaveURL(/\/matters\/m-doyle\/deadlines$/);
    const executor = changeRow(page, 'Executor');
    await expect(executor).toContainText(
      `Moves earlier: ${addMonths(deathDay, 12)} → ${addMonths(addDays(deathDay, -1), 12)}`,
    );
    await expectNoA11yViolations(page);

    // Reject it: the date in force stays.
    await executor.getByRole('button', { name: /^Reject/ }).click();
    await expect(executor).toHaveCount(0, CALLABLE_TIMEOUT);
    expect(await dueDateOf(request, orgId, 'rule-org.executor_year')).toBe(addMonths(deathDay, 12));

    // A grant date seven months back would move the critical family provision deadline into the past.
    await openTab(page, 'Overview');
    await editDateFact(page, 'Grant date', addMonths(grantDay, -7));
    await openTab(page, 'Deadlines');
    const banner = page.locator('mt-pending-changes [role="alert"]');
    await expect(banner).toContainText('A critical deadline would move into the past.');
    const fp = changeRow(page, 'Family provision claim period ends');
    await expect(fp).toContainText('Accepting needs the matter number');
    await expectNoA11yViolations(page);

    // Accepting it needs the matter number typed.
    await fp.getByRole('button', { name: /^Accept/ }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Accept a change to a critical deadline?');
    const accept = dialog.getByRole('button', { name: 'Accept change' });
    await expect(accept).toBeDisabled();
    await dialog.getByLabel(`Type ${MATTER_NUMBER} to confirm`).fill('M-2026-9999');
    await expect(accept).toBeDisabled();
    await dialog.getByLabel(`Type ${MATTER_NUMBER} to confirm`).fill(MATTER_NUMBER.toLowerCase());
    await expectNoA11yViolations(page);
    await accept.click();
    await expect(fp).toHaveCount(0, CALLABLE_TIMEOUT);
    await expect(banner).toHaveCount(0);
    await expect
      .poll(() => dueDateOf(request, orgId, 'rule-vic.fp.limitation'), CALLABLE_TIMEOUT)
      .toBe(addMonths(addMonths(grantDay, -7), 6));
  });

  test('record an event, override with a reason, mark done, add a deadline, then the Deadlines screen', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const { orgId } = await setUp(page, request);
    const deathDay = addDays(TODAY, -45);

    // Record the date of death from the Deadlines tab.
    await page.goto('/matters/m-doyle/deadlines');
    await expect(page.getByRole('heading', { level: 2, name: 'Deadlines' })).toBeVisible(FIRST_LOAD);
    await page.getByRole('button', { name: 'Record event' }).click();
    const eventDialog = page.getByRole('dialog');
    await eventDialog.getByLabel('Event').selectOption({ label: 'Date of death' });
    await eventDialog.getByLabel('Date', { exact: true }).fill(typed(deathDay));
    await expectNoA11yViolations(page);
    await eventDialog.getByRole('button', { name: 'Record event' }).click();
    await expect(eventDialog).toBeHidden(CALLABLE_TIMEOUT);
    // The dialog closes before deadlines-upsertEvent runs, so the event shows only once the callable
    // and its recompute are done.
    await expect(page.locator('[data-event="date_of_death"]')).toContainText('Date of death', CALLABLE_TIMEOUT);
    const executor = deadlineRow(page, 'Executor');
    await expect(executor).toBeVisible(CALLABLE_TIMEOUT);
    // A deadline waiting on the grant says why.
    await expect(deadlineRow(page, 'Family provision claim period ends')).toContainText('Waiting:');

    // The trace.
    await executor.getByText('How it’s worked out').click();
    await expect(executor.locator('details')).toContainText('Computed by rule org.executor_year');
    await expect(executor.locator('details')).toContainText('date_of_death');

    // Override with a reason.
    await executor.getByRole('button', { name: /^More actions for Executor/ }).click();
    await page.getByRole('menuitem', { name: 'Override date…' }).click();
    const override = page.getByRole('dialog');
    await override.getByLabel('New due date').fill(typed(addMonths(deathDay, 11)));
    await override.getByRole('button', { name: 'Override date' }).click();
    await expect(override).toContainText('Say why the date is overridden.');
    await override.getByLabel('Reason').fill('Agreed with the fictional executor');
    await override.getByRole('button', { name: 'Override date' }).click();
    await expect(override).toBeHidden(CALLABLE_TIMEOUT);
    await expect(executor).toContainText('Overridden', CALLABLE_TIMEOUT);
    await expect
      .poll(async () => (await storedDeadline(request, orgId, 'rule-org.executor_year'))['override'], CALLABLE_TIMEOUT)
      .toMatchObject({
        mapValue: {
          fields: expect.objectContaining({ reason: { stringValue: 'Agreed with the fictional executor' } }),
        },
      });

    // Mark another done.
    const tax = deadlineRow(page, 'final tax return');
    await tax.getByRole('button', { name: /^Mark done/ }).click();
    const done = page.getByRole('dialog');
    await expect(done).toContainText('Mark the deadline done');
    await done.getByRole('button', { name: 'Mark done' }).click();
    await expect(done).toBeHidden(CALLABLE_TIMEOUT);
    await expect
      .poll(() => storedDeadline(request, orgId, 'rule-au.tax.final_return'), CALLABLE_TIMEOUT)
      .toMatchObject({ status: { stringValue: 'done' } });
    await expect(page.locator('details.closed > summary')).toContainText('Closed (1)');

    // Add a manual deadline.
    const manualDue = addDays(TODAY, 3);
    await page.getByRole('button', { name: 'Add deadline' }).click();
    const add = page.getByRole('dialog');
    await add.getByLabel('Title').fill('Settle the sale of the fictional house');
    await add.getByLabel('Due date').fill(typed(manualDue));
    await add.getByLabel('Kind').selectOption({ label: 'Contractual' });
    await add.getByRole('button', { name: 'Add deadline' }).click();
    await expect(add).toBeHidden();
    await expect(deadlineRow(page, 'Settle the sale of the fictional house')).toContainText('Contractual');
    await expectNoA11yViolations(page);

    // The Deadlines screen: grouped, with the matter named and the trace.
    await page.goto('/deadlines');
    await expect(page.getByRole('heading', { level: 1, name: 'Deadlines' })).toBeVisible(FIRST_LOAD);
    const manual = deadlineRow(page, 'Settle the sale of the fictional house');
    await expect(manual).toContainText(`${MATTER_NUMBER} · Estate of Margaret Doyle`, FIRST_LOAD);
    await expect(page.locator('section[data-group="later"]')).toContainText('Executor');
    const later = deadlineRow(page, 'Executor');
    await later.getByText('How it’s worked out').click();
    await expect(later.locator('details')).toContainText('Overridden to');
    // On a phone, opening the row scrolls the page, and how far depends on the browser. Scrolled
    // about 100px, the filter chips sit under the sticky top bar's back and timer buttons, which axe
    // counts as hiding them. Scan from the top, where the screen opens.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoA11yViolations(page);

    // Filters: critical leaves none of these (the family provision deadline is still waiting).
    await page.getByRole('button', { name: 'Critical', exact: true }).click();
    await expect(page.getByText('No deadlines match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).first().click();

    // The month calendar.
    await page.getByRole('group', { name: 'Deadlines view' }).getByText('Calendar').click();
    const calendar = page.locator('mt-deadline-calendar');
    await expect(calendar.getByRole('table')).toBeVisible();
    if (manualDue.slice(0, 7) !== TODAY.slice(0, 7)) await calendar.getByRole('button', { name: 'Next month' }).click();
    await expect(calendar.locator(`td[data-date="${manualDue}"]`)).toContainText(
      'Settle the sale of the fictional house',
    );
    await expectNoA11yViolations(page);
    // And in the dark theme.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
  });
});
