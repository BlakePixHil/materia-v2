import { expect, test, type Locator, type Page } from '@playwright/test';

import { insightsPeriod, shiftMonth, today } from '@materia/domain';
import { expectNoA11yViolations, FIRST_LOAD, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Insights (INS-02) against the emulators, from a seeded INS-01 metrics snapshot: the figures for
 * three months chosen in the URL, switching to last month (kept in the URL), the table view behind
 * a chart, and drilling from a bar into the matters and deadlines it counts, each opening its
 * matter. Months are relative to today in Melbourne, so the snapshot is always in the past.
 * Fictional data only.
 */

const TODAY = today('Australia/Melbourne');
const LAST = shiftMonth(TODAY.slice(0, 7), -1);
const FIRST = shiftMonth(LAST, -2);
const RANGE = insightsPeriod({ range: 'custom', from: FIRST, to: LAST }, TODAY);

const card = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const bar = (chart: Locator, name: RegExp) => chart.getByRole('button', { name });
const stat = (page: Page, id: string) => page.getByTestId(`stat-${id}`).locator('.v');

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/**
 * The first month: $12,000 billed, $10,000 collected, a probate matter opened and a deadline met on
 * time. The last month: $8,000 billed and a deadline met late. The month between has no document.
 */
async function seed(page: Page, request: Parameters<typeof signInAsTestUser>[1]) {
  const orgId = uniqueOrg();
  const jordan = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Insights Practice' },
    displayName: 'Jordan Fictional',
  });
  await seedClient(request, orgId, jordan.uid);
  const matter = matterDoc(orgId, jordan.uid, {
    id: 'm-quill',
    number: 'M-2026-0301',
    title: 'Estate of Ada Quillfeather',
    responsibleUid: jordan.uid,
    daysAgo: 2,
  });
  const deadline = (id: string, title: string, dueDate: string, on: string) => ({
    path: `orgs/${orgId}/matters/m-quill/deadlines/${id}`,
    data: {
      title,
      dueDate,
      kind: 'statutory',
      critical: false,
      status: 'done',
      resolution: { on, by: jordan.uid, at: new Date(`${on}T02:00:00Z`) },
      assigneeUid: jordan.uid,
      orgId,
      matterId: 'm-quill',
      privileged: false,
      deletedAt: null,
      ...meta(jordan.uid),
    },
  });
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Insights Practice',
        timezone: 'Australia/Melbourne',
        fy: { startMonth: 7 },
        billing: { dailyTargetMinutes: 360 },
      },
    },
    // Opened mid-morning in Melbourne on the 15th of the first month.
    { ...matter, data: { ...matter.data, createdAt: new Date(`${FIRST}-15T00:00:00Z`) } },
    deadline('d-filed', 'File the probate application', `${FIRST}-20`, `${FIRST}-19`),
    deadline('d-served', 'Serve the notice on the beneficiaries', `${LAST}-10`, `${LAST}-12`),
    {
      path: `orgs/${orgId}/metrics/month-${FIRST}`,
      data: {
        period: `month-${FIRST}`,
        values: {
          'billing.invoicedCents': 1_200_000,
          'billing.collectedCents': 1_000_000,
          'matters.opened': 1,
          'matters.opened.type.probate': 1,
          'deadlines.due': 1,
          'deadlines.metOnTime': 1,
        },
      },
    },
    {
      path: `orgs/${orgId}/metrics/month-${LAST}`,
      data: {
        period: `month-${LAST}`,
        values: { 'billing.invoicedCents': 800_000, 'deadlines.due': 1, 'deadlines.metLate': 1 },
      },
    },
  ]);
}

test.describe('insights', () => {
  test('figures from the metrics, switching the period, the table view and drilling into records', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await seed(page, request);

    await page.goto(`/insights?period=custom&from=${FIRST}&to=${LAST}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Insights' })).toBeVisible();
    await expect(page.getByTestId('hero-billed')).toHaveText('$20,000.00', FIRST_LOAD);
    await expect(page.getByTestId('insights-subtitle')).toHaveText(RANGE.label);
    await expect(stat(page, 'collected')).toHaveText('$10,000.00');
    await expect(stat(page, 'opened')).toHaveText('1');
    // One met on time of two resolved.
    await expect(stat(page, 'deadlines')).toHaveText('50%');
    await expectNoA11yViolations(page);

    // The table view behind a chart.
    const types = card(page, 'Matters opened by type');
    await types.getByText('View as table').click();
    await expect(types.getByRole('row', { name: 'Probate 1' })).toBeVisible();

    // Drill from the probate bar into the matter, and open it.
    await bar(types, /^Probate: 1$/).click();
    const dialog = page.getByRole('dialog', { name: 'Probate matters opened' });
    await expect(dialog.getByRole('link', { name: /M-2026-0301 Estate of Ada Quillfeather/ })).toBeVisible(FIRST_LOAD);
    await expectNoA11yViolations(page);
    await dialog.getByRole('link', { name: /M-2026-0301/ }).click();
    await expect(page).toHaveURL(/\/matters\/m-quill/);

    // Back to the same months (the URL kept them), then drill into the deadline met late.
    await page.goBack();
    await expect(page.getByTestId('hero-billed')).toHaveText('$20,000.00', FIRST_LOAD);
    await bar(card(page, 'Deadline performance'), /^Met late: 1$/).click();
    const late = page.getByRole('dialog', { name: 'Deadlines met late' });
    await expect(late.getByRole('link', { name: /Serve the notice on the beneficiaries/ })).toBeVisible(FIRST_LOAD);
    await expect(late.getByRole('link', { name: /File the probate application/ })).toHaveCount(0);
    await late.getByRole('button', { name: 'Close' }).click();
    await expect(late).toBeHidden();

    // Last month: its own figures, and the choice is in the URL.
    await page.getByRole('combobox', { name: 'Period' }).selectOption({ label: 'Last month' });
    await expect(page).toHaveURL(/[?&]period=last_month(&|$)/);
    await expect(page.getByTestId('hero-billed')).toHaveText('$8,000.00');
    await expect(stat(page, 'opened')).toHaveText('0');
    await page.reload();
    await expect(page.getByTestId('hero-billed')).toHaveText('$8,000.00', FIRST_LOAD);
  });
});
