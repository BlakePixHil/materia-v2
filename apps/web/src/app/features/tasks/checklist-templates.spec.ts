import { cleanUpOverlays, MATTER, meta, ME, openMatter, ORG, READONLY } from '../matter-detail/testing';

/** Checklist templates from a task's details (CORE-08d). Today is 4 October 2026. Fictional data only. */

afterEach(cleanUpOverlays);

const URL = '/matters/m-whitfield/tasks';
const TEMPLATES = `orgs/${ORG}/checklistTemplates`;
const TASK = `${MATTER}/tasks/t-cert`;
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;
/** The native Priority select's option values (its options' indexes). */
const PRIORITY = { none: '0', urgent: '1' };

function templateDoc(name: string, items: string[], data: Seed = {}): Seed {
  return { name, items, ...meta, ...data };
}

/** Two templates, one deleted, and the task with one item, no priority and no due date. */
function seedTemplates(fs: Page['firestore']): void {
  fs.set(
    `${TEMPLATES}/ct-kickoff`,
    templateDoc('Probate kick-off', ['Request from BDM', 'Locate the original will', 'Search the will bank'], {
      priority: 'high',
      dueInDays: 7,
    }),
  );
  fs.set(`${TEMPLATES}/ct-letters`, templateDoc('Administration letters', ['Write to the bank']));
  fs.set(
    `${TEMPLATES}/ct-gone`,
    templateDoc('Old checklist', ['Retired item'], { deletedAt: new Date('2026-09-02T00:00:00Z'), deletedBy: ME }),
  );
  const task = fs.get(TASK) as Seed;
  const rest = { ...task };
  delete rest['dueDate'];
  fs.set(TASK, { ...rest, priority: 'none', checklist: [{ id: 'a', text: 'request from bdm ', done: true }] });
}

/** Opens the task's details, then its checklist templates. */
async function openTemplates(page: Page, title = 'Order the death certificate', expand = true): Promise<HTMLElement> {
  if (expand) await page.click(`Details: ${title}`);
  await page.click(`Checklist templates for ${title}`);
  // The dialog loads on demand.
  await page.stable(50);
  const dialog = page.dialog();
  if (!dialog) throw new Error('No dialog');
  return dialog;
}

const names = (page: Page) =>
  [...(page.dialog()?.querySelectorAll('.mt-checklist-templates .name') ?? [])].map((n) => page.text(n));

const search = async (page: Page, query: string) => {
  const field = page.dialog()?.querySelector<HTMLInputElement>('mt-search-field input');
  (field as HTMLInputElement).value = query;
  field?.dispatchEvent(new Event('input'));
  await page.stable(20);
};

describe('checklist templates', () => {
  it('lists the org’s live templates by name, searchable', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    expect(page.text(dialog.querySelector('h2'))).toBe('Checklist templates');
    expect(names(page)).toEqual(['Administration letters', 'Probate kick-off']);
    expect(page.text(dialog)).toContain('3 items · High priority · Due in 7 days');
    await search(page, 'kick');
    expect(names(page)).toEqual(['Probate kick-off']);
    await search(page, 'wills');
    expect(names(page)).toEqual([]);
    expect(page.text(dialog)).toContain('No templates match “wills”.');
  });

  it('applies a template: new items unticked, and the empty priority and due date filled in, in one write', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    await openTemplates(page);
    const before = page.firestore.writes.length;
    await page.click('Apply Probate kick-off', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.dialog()).toBeNull();
    const writes = page.firestore.writes.slice(before);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ op: 'update', path: TASK });
    expect(page.firestore.get(TASK)).toMatchObject({
      checklist: [
        { id: 'a', text: 'request from bdm ', done: true },
        { id: expect.any(String), text: 'Locate the original will', done: false },
        { id: expect.any(String), text: 'Search the will bank', done: false },
      ],
      priority: 'high',
      dueDate: '2026-10-11',
    });
    const toasts = page.text(page.body.querySelector('.mt-toaster'));
    expect(toasts).toContain('Added 2 items from “Probate kick-off”');
    expect(toasts).toContain('1 item was already there. Priority set to high. Due 11 Oct 2026.');
  });

  it('keeps the task’s own priority and due date, and says when there’s nothing to add', async () => {
    const page = await openMatter(URL, {
      configure: (fs) =>
        fs.set(`${TEMPLATES}/ct-cert`, templateDoc('Certificate', ['Pay the fee'], { priority: 'low', dueInDays: 1 })),
    });
    await openTemplates(page);
    await page.click('Apply Certificate', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.firestore.get(TASK)).toMatchObject({
      checklist: [{ id: expect.any(String), text: 'Pay the fee', done: false }],
      priority: 'high',
      dueDate: '2026-10-06',
    });
    await openTemplates(page, 'Order the death certificate', false);
    const before = page.firestore.writes.length;
    await page.click('Apply Certificate', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.firestore.writes.length).toBe(before);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Nothing to add from “Certificate”');
  });

  it('creates a template, checking the name, items and days first', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    await page.click('New template', dialog);
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('New checklist template');
    expect(document.activeElement).toBe(page.dialog()?.querySelector('mt-text-field input'));
    await page.fill('Due in (days)', '400');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Enter a name.');
    expect(page.text(page.dialog())).toContain('Add at least one item.');
    expect(page.text(page.dialog())).toContain('Enter a whole number of days from 0 to 365.');
    await page.fill('Items', Array.from({ length: 31 }, (_, i) => `Item ${i + 1}`).join('\n'));
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Up to 30 items (this has 31).');

    await page.fill('Name', '  Grant application ');
    await page.fill('Items', 'Swear the affidavit\n\n  File the application  \nswear the affidavit');
    await page.fill('Priority', PRIORITY.urgent);
    await page.fill('Due in (days)', '14');
    await page.submit(page.dialog());
    await page.stable(20);
    const write = page.firestore.writes.find((w) => w.op === 'create' && w.path.startsWith(`${TEMPLATES}/`));
    expect(write && page.firestore.get(write.path)).toMatchObject({
      name: 'Grant application',
      items: ['Swear the affidavit', 'File the application'],
      priority: 'urgent',
      dueInDays: 14,
      createdBy: ME,
    });
    // Back to the list, which shows it.
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('Checklist templates');
    expect(names(page)).toEqual(['Administration letters', 'Grant application', 'Probate kick-off']);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Created “Grant application”');
  });

  it('saves the task’s checklist as a template', async () => {
    const page = await openMatter(URL, {
      configure: (fs) =>
        fs.set(TASK, {
          ...(fs.get(TASK) as Seed),
          checklist: [
            { id: 'a', text: 'Request from BDM', done: true },
            { id: 'b', text: 'Pay the fee', done: false },
          ],
        }),
    });
    const dialog = await openTemplates(page);
    expect(page.text(dialog)).toContain('No checklist templates yet.');
    await page.click('Save this task’s checklist as a template', dialog);
    const form = page.dialog();
    expect(form?.querySelector<HTMLInputElement>('mt-text-field input')?.value).toBe('Order the death certificate');
    expect(form?.querySelector<HTMLTextAreaElement>('mt-textarea textarea')?.value).toBe(
      'Request from BDM\nPay the fee',
    );
    await page.submit(form);
    await page.stable(20);
    const write = page.firestore.writes.find((w) => w.op === 'create' && w.path.startsWith(`${TEMPLATES}/`));
    expect(write && page.firestore.get(write.path)).toMatchObject({
      name: 'Order the death certificate',
      items: ['Request from BDM', 'Pay the fee'],
    });
    expect(write && page.firestore.get(write.path)).not.toHaveProperty('priority');
    expect(write && page.firestore.get(write.path)).not.toHaveProperty('dueInDays');
  });

  it('edits a template, clearing its priority and due offset', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    await page.click('Edit Probate kick-off', dialog);
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('Edit Probate kick-off');
    expect(page.dialog()?.querySelector<HTMLTextAreaElement>('mt-textarea textarea')?.value).toBe(
      'Request from BDM\nLocate the original will\nSearch the will bank',
    );
    await page.fill('Name', 'Probate first steps');
    await page.fill('Items', 'Request from BDM\nLocate the original will');
    await page.fill('Priority', PRIORITY.none);
    await page.fill('Due in (days)', '');
    expect(page.buttons('Save template', page.dialog() ?? page.body)).toHaveLength(1);
    await page.submit(page.dialog());
    await page.stable(20);
    const saved = page.firestore.get(`${TEMPLATES}/ct-kickoff`);
    expect(saved).toMatchObject({
      name: 'Probate first steps',
      items: ['Request from BDM', 'Locate the original will'],
      updatedBy: ME,
    });
    expect(saved).not.toHaveProperty('priority');
    expect(saved).not.toHaveProperty('dueInDays');
    expect(names(page)).toEqual(['Administration letters', 'Probate first steps']);
  });

  it('cancelling the form goes back to the list without saving', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    await page.click('Edit Administration letters', dialog);
    await page.fill('Name', 'Changed');
    const before = page.firestore.writes.length;
    await page.click('Cancel', page.dialog() ?? page.body);
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('Checklist templates');
    expect(page.firestore.writes.length).toBe(before);
  });

  it('deletes a template after a confirm (a soft delete)', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    await page.click('Delete Administration letters', dialog);
    const confirm = [...page.body.querySelectorAll<HTMLElement>('.mt-dialog')].at(-1) as HTMLElement;
    expect(page.text(confirm)).toContain('Delete “Administration letters”?');
    await page.click('Delete template', confirm);
    await page.stable(20);
    expect(page.firestore.get(`${TEMPLATES}/ct-letters`)).toMatchObject({ deletedBy: ME });
    expect(page.firestore.writes.some((w) => w.op === 'delete')).toBe(false);
    expect(names(page)).toEqual(['Probate kick-off']);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Deleted “Administration letters”');
  });

  it('read-only members don’t get templates on matter tasks', async () => {
    const page = await openMatter(URL, { session: READONLY, configure: seedTemplates });
    await page.click('Details: Order the death certificate');
    expect(page.buttons('Checklist templates for Order the death certificate')).toHaveLength(0);
  });

  it('read-only members apply templates to their personal tasks, but don’t change templates', async () => {
    const page = await openMatter('/tasks', {
      session: READONLY,
      configure: (fs) => {
        seedTemplates(fs);
        fs.set(`orgs/${ORG}/members/${ME}/tasks/p-renew`, {
          title: 'Renew my practising certificate',
          status: 'todo',
          priority: 'none',
          order: 1024,
          checklist: [{ id: 'a', text: 'Pay the fee', done: false }],
          source: 'manual',
          orgId: ORG,
          matterId: null,
          assigneeUid: ME,
          deletedAt: null,
          ...meta,
        });
      },
    });
    await page.stable(20);
    const dialog = await openTemplates(page, 'Renew my practising certificate');
    expect(names(page)).toEqual(['Administration letters', 'Probate kick-off']);
    expect(page.buttons('New template', dialog)).toHaveLength(0);
    expect(page.buttons('Edit Probate kick-off', dialog)).toHaveLength(0);
    expect(page.buttons('Save this task’s checklist as a template', dialog)).toHaveLength(0);
    await page.click('Apply Administration letters', dialog);
    await page.stable(20);
    expect(page.firestore.get(`orgs/${ORG}/members/${ME}/tasks/p-renew`)?.['checklist']).toEqual([
      { id: 'a', text: 'Pay the fee', done: false },
      { id: expect.any(String), text: 'Write to the bank', done: false },
    ]);
  });
});
