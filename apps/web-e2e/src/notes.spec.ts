import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  createTestAccount,
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Matter notes (CORE-13) against the emulators: write a note that mentions a colleague through the
 * real `notes-create` callable (the colleague gets a `mention` notification), pin it (it shows on
 * the Overview), edit it through `notes-update` (it reads "edited" and its history has the earlier
 * version), see "Added a note" on the Activity tab, then delete it and undo. Fictional data only.
 */

const NOTES = '/matters/m-quill/notes';
/** Callables cold-start the Functions emulator, and the activity feed is written by a trigger. */
const SERVER = { timeout: 20_000 };

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Notes Practice' },
    displayName: 'Jordan Fictional',
  });
  await seedClient(request, orgId, account.uid);
  const matter = matterDoc(orgId, account.uid, {
    id: 'm-quill',
    number: 'M-2026-0310',
    title: 'Estate of Rosalind Quill',
    responsibleUid: account.uid,
    daysAgo: 2,
  });
  await setEmulatorDocuments(request, [{ ...matter, data: { ...matter.data, stageId: 'intake' } }]);
  // A colleague to mention.
  const colleague = await createTestAccount(request, {
    claims: { orgId, role: 'lawyer' },
    displayName: 'Priya Fictional',
  });
  return { orgId, uid: account.uid, colleague: colleague.uid };
}

type Fields = Record<string, Record<string, unknown>>;

/** The practice's notifications for one member, read through the emulator's admin access. */
async function notificationsFor(request: APIRequestContext, orgId: string, uid: string): Promise<Fields[]> {
  const response = await request.post(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}:runQuery`,
    {
      headers: { Authorization: 'Bearer owner' },
      data: {
        structuredQuery: {
          from: [{ collectionId: 'notifications' }],
          where: { fieldFilter: { field: { fieldPath: 'recipientUid' }, op: 'EQUAL', value: { stringValue: uid } } },
        },
      },
    },
  );
  if (!response.ok()) return [];
  const rows = (await response.json()) as { document?: { fields: Fields } }[];
  return rows.flatMap((row) => (row.document ? [row.document.fields] : []));
}

const notesList = (page: Page) => page.getByRole('list', { name: 'Notes' });
const noteCards = (page: Page) => notesList(page).locator('article[data-note]');

test.describe('notes', () => {
  test('write with a mention, pin, edit with history, see the activity, delete and undo', async ({ page, request }) => {
    test.setTimeout(120_000);
    const { orgId, colleague } = await setUp(page, request);

    await page.goto(NOTES);
    await expect(page.getByRole('heading', { level: 2, name: 'Notes' })).toBeVisible(FIRST_LOAD);
    await expect(page.getByText('No notes yet')).toBeVisible();
    await expectNoA11yViolations(page);

    // Write a note, mentioning Priya from the @ list; Ctrl+Enter saves it.
    const composer = page.getByRole('textbox', { name: 'New note' });
    await composer.click();
    await composer.pressSequentially('Original will is in the safe. Ask @pri');
    const people = page.getByRole('listbox', { name: 'People' });
    await expect(people.getByRole('option', { name: /Priya Fictional/ })).toBeVisible();
    await expectNoA11yViolations(page);
    await composer.press('Enter');
    await expect(people).toBeHidden();
    await expect(composer).toHaveValue(/Ask @\[[^\]]+\] $/);
    await composer.pressSequentially('to collect it.');
    await composer.press('ControlOrMeta+Enter');

    await expect(composer).toHaveValue('', SERVER);
    const note = noteCards(page).first();
    await expect(note).toContainText('Original will is in the safe. Ask @Priya Fictional to collect it.');
    await expect(note).toContainText('Jordan Fictional');
    await expect(page.locator('.mt-toaster')).toContainText('Note added');

    // Priya gets a mention notification that links to the note.
    await expect
      .poll(
        async () => (await notificationsFor(request, orgId, colleague)).map((n) => n['kind']?.['stringValue']),
        SERVER,
      )
      .toContain('mention');
    const [mention] = (await notificationsFor(request, orgId, colleague)).filter(
      (n) => n['kind']?.['stringValue'] === 'mention',
    );
    expect(String(mention?.['link']?.['stringValue'])).toMatch(/^\/matters\/m-quill\/notes#note-/);

    // Pin it: it's marked Pinned and shows on the Overview.
    await note.getByRole('button', { name: 'Pin note' }).click();
    await expect(note).toContainText('Pinned');
    const tabs = page.getByRole('navigation', { name: 'Matter sections' });
    await tabs.getByRole('link', { name: 'Overview' }).click();
    const pinned = page.getByRole('region', { name: 'Pinned notes' });
    await expect(pinned).toContainText('Original will is in the safe.');
    await expectNoA11yViolations(page);

    // Edit it: it reads "edited", and its history has the earlier version.
    await pinned.getByRole('link', { name: 'All notes' }).click();
    await expect(page).toHaveURL(/\/matters\/m-quill\/notes$/);
    await noteCards(page).first().getByRole('button', { name: 'Edit note' }).click();
    const editor = page.getByRole('textbox', { name: 'Edit note' });
    await expect(editor).toBeFocused();
    await editor.press('End');
    await editor.pressSequentially(' Collected on Monday.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toBeHidden(SERVER);
    const edited = noteCards(page).first();
    await expect(edited).toContainText('Collected on Monday.');
    await edited.getByRole('button', { name: /^Edited .*Show history$/ }).click();
    const history = page.getByRole('dialog', { name: 'Note history' });
    await expect(history).toContainText('Original will is in the safe. Ask @Priya Fictional to collect it.');
    await expect(history).not.toContainText('Collected on Monday.');
    await expectNoA11yViolations(page);
    await history.getByRole('button', { name: 'Done' }).click();
    await expect(history).toBeHidden();

    // The Activity tab lists it, with who did it.
    await tabs.getByRole('link', { name: 'Activity' }).click();
    await expect(page).toHaveURL(/\/matters\/m-quill\/activity$/);
    await expect(page.locator('mt-timeline')).toContainText('Jordan Fictional added a note', SERVER);
    await expectNoA11yViolations(page);

    // Delete it, then Undo brings it back.
    await tabs.getByRole('link', { name: 'Notes' }).click();
    await noteCards(page).first().getByRole('button', { name: 'Delete note' }).click();
    await expect(page.getByText('No notes yet')).toBeVisible();
    await page.locator('.mt-toaster').getByRole('button', { name: 'Undo' }).click();
    await expect(noteCards(page)).toHaveCount(1);
    await expect(noteCards(page).first()).toContainText('Collected on Monday.');
  });

  test('a mention link scrolls to and highlights the note', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await setUp(page, request);
    const now = new Date();
    await setEmulatorDocuments(request, [
      {
        path: `orgs/${orgId}/matters/m-quill/notes/n-fixture`,
        data: {
          orgId,
          matterId: 'm-quill',
          bodyMd: 'Spoke to the executor about the house.',
          mentions: { uids: [], matterIds: [] },
          privileged: false,
          pinned: false,
          source: 'manual',
          deletedAt: null,
          createdAt: now,
          createdBy: uid,
          updatedAt: now,
          updatedBy: uid,
          schemaVersion: 1,
        },
      },
    ]);
    await page.goto(`${NOTES}#note-n-fixture`);
    const target = page.locator('#note-n-fixture');
    await expect(target).toContainText('Spoke to the executor about the house.', FIRST_LOAD);
    await expect(target).toHaveAttribute('data-highlight', '');
    await expect(target).toBeFocused();
  });
});
