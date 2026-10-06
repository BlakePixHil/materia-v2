import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { expectNoA11yViolations, setEmulatorDocuments, setOrgFlags, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Matter templates (CORE-07) against the emulators, with `templates.system` on for the org: an
 * admin customises the system will template, edits a task, publishes v1 and v2, and upgrades a
 * matter on v1; and a matter moves forward into a stage whose requirement is recorded on the way.
 * Fictional data only.
 */

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

async function signInAs(page: Page, request: APIRequestContext, role: 'admin' | 'lawyer') {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, { 'templates.system': true });
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role, orgName: 'Fictional Template Practice' },
    displayName: role === 'admin' ? 'Priya Fictional' : 'Jordan Fictional',
  });
  await seedClient(request, orgId, account.uid);
  return { orgId, uid: account.uid };
}

/** A will matter on a template, at a stage, without a will date. */
function willMatter(
  orgId: string,
  uid: string,
  id: string,
  template: { id: string; version: number; stageId: string },
) {
  const matter = matterDoc(orgId, uid, {
    id,
    number: id === 'm-upgrade' ? 'M-2026-0410' : 'M-2026-0411',
    title: id === 'm-upgrade' ? 'Will of Odette Fictional' : 'Will of Linus Fictional',
    type: 'will',
    responsibleUid: uid,
    daysAgo: 1,
  });
  return {
    ...matter,
    data: {
      ...matter.data,
      templateId: template.id,
      templateVersion: template.version,
      stageId: template.stageId,
      stageEnteredOn: '2026-10-01',
    },
  };
}

test.describe('matter templates', () => {
  test('customise a system template, publish two versions and upgrade a matter', async ({ page, request }) => {
    test.setTimeout(180_000);
    const { orgId, uid } = await signInAs(page, request, 'admin');

    // Settings → Templates lists the system templates.
    await page.goto('/settings/templates');
    await expect(page.getByRole('heading', { level: 1, name: 'Matter templates' })).toBeVisible();
    await expect(page.getByText('System v1').first()).toBeVisible();
    await expectNoA11yViolations(page);

    // Customise the will template: a draft copy opens in the editor.
    await page.getByRole('button', { name: 'Customise Will', exact: true }).click();
    // The first call cold-starts the Functions emulator.
    await expect(page).toHaveURL(/\/settings\/templates\/[^/]+$/, { timeout: 20_000 });
    const templateId = page.url().split('/').at(-1) as string;
    await expect(page.getByRole('heading', { level: 1, name: 'Will (customised)' })).toBeVisible();
    await expect(page.getByText('Not published yet')).toBeVisible();

    // Edit a task, then publish v1 (saving first).
    const task = page.locator('details[data-task="send_engagement"]');
    await task.locator('summary').click();
    await task.getByLabel('Task title').fill('Send the engagement letter and costs agreement');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByRole('button', { name: 'Publish v1' }).click();
    // Publishing saves first, so this cold-starts two callables (save, then publish) in turn; on a
    // busy CI runner the pair has taken over 20s.
    await expect(page.getByText('Published v1', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: 'Publish v2' })).toBeVisible();

    // Edit again: a new task in the first stage, published as v2.
    await page.getByRole('button', { name: 'Add task' }).click();
    const added = page.locator('details.task').last();
    await added.getByLabel('Task title').fill('Check the client’s identity documents');
    await page.getByRole('button', { name: 'Publish v2' }).click();
    await expect(page.getByText('Published v2', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // The list shows the org template at v2.
    await page.locator('mt-template-editor-page').getByRole('link', { name: 'Matter templates' }).click();
    await expect(page.locator(`[data-template="${templateId}"]`)).toContainText('Published v2');

    // A matter on v1 of that template offers the upgrade to v2, which adds the missing tasks.
    await setEmulatorDocuments(request, [
      willMatter(orgId, uid, 'm-upgrade', { id: templateId, version: 1, stageId: 'instructions' }),
    ]);
    await page.goto('/matters/m-upgrade');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Will of Odette Fictional');
    await page.getByRole('button', { name: 'More matter actions' }).click();
    await page.getByRole('menuitem', { name: 'Upgrade matter to v2…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Only tasks it doesn’t have yet are added');
    await dialog.getByRole('button', { name: 'Upgrade to v2' }).click();
    await expect(page.getByText('Upgraded to v2').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/\d+ tasks? added\./).first()).toBeVisible();
    await expect(page.locator('mt-matter-overview')).toContainText('Check the client’s identity documents');
    await page.getByRole('button', { name: 'More matter actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Upgrade matter/ })).toHaveCount(0);
  });

  test('move a matter forward into a stage once its requirement is recorded', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await signInAs(page, request, 'lawyer');
    // At Execution, with signing supervised: Safe custody still needs the will date.
    await setEmulatorDocuments(request, [
      willMatter(orgId, uid, 'm-stage', { id: 'system-will', version: 1, stageId: 'execution' }),
      {
        path: `orgs/${orgId}/matters/m-stage/tasks/tpl-supervise_execution`,
        data: {
          title: 'Supervise signing and witnessing',
          status: 'done',
          priority: 'high',
          order: 7,
          checklist: [],
          source: 'template',
          templateTaskKey: 'supervise_execution',
          orgId,
          matterId: 'm-stage',
          deletedAt: null,
          completedAt: new Date(),
          ...meta(uid),
        },
      },
    ]);
    await page.goto('/matters/m-stage');
    const stepper = page.locator('mt-estate-stepper');
    await expect(stepper.getByRole('button', { name: /^Execution\s*, current$/ })).toBeVisible();

    await stepper.getByRole('button', { name: 'Safe custody', exact: true }).click();
    const note = page.locator('mt-matter-stages mt-note');
    await expect(note).toContainText('To move to Safe custody, record:', { timeout: 20_000 });
    await expectNoA11yViolations(page);

    // Record the will date from the note, then move.
    await note.getByRole('button', { name: 'Will date' }).click();
    await page.getByLabel('Will date', { exact: true }).fill('02/10/2026');
    await page.locator('mt-key-facts').getByRole('button', { name: 'Save' }).click();
    await expect(note).toContainText('Everything Safe custody needs is recorded');
    await note.getByRole('button', { name: 'Move to Safe custody' }).click();
    await expect(page.getByText('Moved to Safe custody').first()).toBeVisible({ timeout: 20_000 });
    await expect(stepper.getByRole('button', { name: /^Safe custody\s*, current$/ })).toBeVisible();
  });
});
