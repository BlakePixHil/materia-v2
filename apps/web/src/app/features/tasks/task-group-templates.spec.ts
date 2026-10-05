import { cleanUpOverlays, MATTER, meta, ME, openMatter, ORG, READONLY } from '../matter-detail/testing';

/** Task group templates from a matter's Tasks tab (CORE-08f). Today is 4 October 2026. Fictional data only. */

afterEach(cleanUpOverlays);

const URL = '/matters/m-whitfield/tasks';
const TEMPLATES = `orgs/${ORG}/taskGroupTemplates`;
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

function templateDoc(name: string, tasks: Seed[], data: Seed = {}): Seed {
  return { name, tasks: tasks.map((task) => ({ checklist: [], ...task })), ...meta, ...data };
}

/** Two live templates and a deleted one. */
function seedTemplates(fs: Page['firestore']): void {
  fs.set(
    `${TEMPLATES}/tg-a`,
    templateDoc('Checklist A', [
      { title: 'item 1', checklist: ['sub-item 1a', 'sub-item 1b'], priority: 'high', dueInDays: 3 },
      { title: 'item 2' },
      { title: 'item 3' },
    ]),
  );
  fs.set(`${TEMPLATES}/tg-b`, templateDoc('Checklist B', [{ title: 'item 4' }, { title: 'item 5' }]));
  fs.set(
    `${TEMPLATES}/tg-gone`,
    templateDoc('Old group', [{ title: 'Retired task' }], {
      deletedAt: new Date('2026-09-02T00:00:00Z'),
      deletedBy: ME,
    }),
  );
}

/** Opens the templates from the Tasks header; the dialog loads on demand. */
async function openTemplates(page: Page): Promise<HTMLElement> {
  await page.click('Task group templates');
  // The dialog is a lazy chunk: wait for it rather than for a fixed time.
  return vi.waitFor(async () => {
    await page.stable(50);
    const dialog = page.dialog();
    if (!dialog) throw new Error('No dialog');
    return dialog;
  });
}

const names = (page: Page) =>
  [...(page.dialog()?.querySelectorAll('.mt-task-group-templates .name') ?? [])].map((n) => page.text(n));

/** Each section of the task list as `Heading: title, title`. */
const sections = (page: Page) =>
  [...page.body.querySelectorAll('mt-task-list section')].map((section) => {
    const head = page.text(section.querySelector('[role="heading"]')).replace(/\s*\d+$/, '');
    const titles = [...section.querySelectorAll('.mt-task-title')].map((t) => page.text(t));
    return `${head}: ${titles.join(', ')}`;
  });

const outline = (page: Page) => page.dialog()?.querySelector<HTMLTextAreaElement>('mt-textarea textarea')?.value;

const createdTemplate = (page: Page) => {
  const write = page.firestore.writes.find((w) => w.op === 'create' && w.path.startsWith(`${TEMPLATES}/`));
  return write && page.firestore.get(write.path);
};

describe('task group templates', () => {
  it('lists the org’s live templates by name, searchable', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    expect(page.text(dialog.querySelector('h2'))).toBe('Task group templates');
    expect(names(page)).toEqual(['Checklist A', 'Checklist B']);
    expect(page.text(dialog)).toContain('3 tasks · 2 checklist items');
    expect(page.text(dialog)).toContain('2 tasks');
    const field = dialog.querySelector<HTMLInputElement>('mt-search-field input') as HTMLInputElement;
    field.value = 'b';
    field.dispatchEvent(new Event('input'));
    await page.stable(20);
    expect(names(page)).toEqual(['Checklist B']);
  });

  it('adds a template’s tasks as a group after the last task, with an Undo', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    await page.click('Group');
    await openTemplates(page);
    const before = page.firestore.writes.length;
    await page.click('Add Checklist A', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.dialog()).toBeNull();
    const creates = page.firestore.writes.slice(before).filter((w) => w.op === 'create');
    expect(creates).toHaveLength(3);
    const created = creates.map((w) => page.firestore.get(w.path));
    expect(created[0]).toMatchObject({
      title: 'item 1',
      group: 'Checklist A',
      status: 'todo',
      priority: 'high',
      dueDate: '2026-10-07',
      checklist: [
        { id: expect.any(String), text: 'sub-item 1a', done: false },
        { id: expect.any(String), text: 'sub-item 1b', done: false },
      ],
      source: 'manual',
      countedOpen: false,
      createdBy: ME,
    });
    expect(created.map((task) => task?.['order'])).toEqual([1025, 2049, 3073]);
    expect(created[1]).not.toHaveProperty('dueDate');
    expect(sections(page)).toEqual(['Checklist A: item 1, item 2, item 3', 'No group: Order the death certificate']);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Added 3 tasks to Checklist A');

    await page.click('Undo');
    await page.stable(20);
    for (const write of creates) expect(page.firestore.get(write.path)).toMatchObject({ deletedBy: ME });
    expect(sections(page)).toEqual(['No group: Order the death certificate']);
    localStorage.removeItem('materia.tasks.groupBy');
  });

  it('creates a template from an outline, checking it first', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    await page.click('New template', dialog);
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('New task group template');
    expect(document.activeElement).toBe(page.dialog()?.querySelector('mt-text-field input'));
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Enter a name.');
    expect(page.text(page.dialog())).toContain('Add at least one task.');
    await page.fill('Tasks', 'Advertise the notice in 400 days');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('“Advertise the notice” is due more than 365 days out.');

    await page.fill('Name', '  Checklist C ');
    await page.fill(
      'Tasks',
      ['* item 1', '   * sub-item 1a', '   * sub-item 1b', '* item 2 !urgent', '', '* item 3'].join('\n'),
    );
    expect(page.text(page.dialog())).toContain('Reads as 3 tasks · 2 checklist items.');
    await page.submit(page.dialog());
    await page.stable(20);
    expect(createdTemplate(page)).toMatchObject({
      name: 'Checklist C',
      tasks: [
        { title: 'item 1', checklist: ['sub-item 1a', 'sub-item 1b'] },
        { title: 'item 2', checklist: [], priority: 'urgent' },
        { title: 'item 3', checklist: [] },
      ],
      createdBy: ME,
    });
    // Back to the list, which shows it.
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('Task group templates');
    expect(names(page)).toEqual(['Checklist A', 'Checklist B', 'Checklist C']);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Created “Checklist C”');
  });

  it('saves a group on the matter as a template', async () => {
    const page = await openMatter(URL, {
      configure: (fs) => {
        const task = (id: string, title: string, order: number, data: Seed = {}) =>
          fs.set(`${MATTER}/tasks/${id}`, {
            ...(fs.get(`${MATTER}/tasks/t-cert`) as Seed),
            title,
            order,
            priority: 'none',
            group: 'Letters',
            checklist: [],
            ...data,
          });
        task('t-bank', 'Write to the bank', 2048, {
          priority: 'high',
          checklist: [{ id: 'a', text: 'Account numbers', done: true }],
        });
        task('t-super', 'Write to the super fund', 3072, { status: 'done' });
      },
    });
    const dialog = await openTemplates(page);
    expect(page.text(dialog)).toContain('No task group templates yet.');
    await page.click('Save Letters as a template', dialog);
    expect(page.dialog()?.querySelector<HTMLInputElement>('mt-text-field input')?.value).toBe('Letters');
    expect(outline(page)).toBe('Write to the bank !high\n  - Account numbers\nWrite to the super fund');
    await page.submit(page.dialog());
    await page.stable(20);
    expect(createdTemplate(page)).toMatchObject({
      name: 'Letters',
      tasks: [
        { title: 'Write to the bank', checklist: ['Account numbers'], priority: 'high' },
        { title: 'Write to the super fund', checklist: [] },
      ],
    });
  });

  it('edits a template as an outline', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    await page.click('Edit Checklist A', dialog);
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('Edit Checklist A');
    expect(outline(page)).toBe('item 1 !high in 3 days\n  - sub-item 1a\n  - sub-item 1b\nitem 2\nitem 3');
    await page.fill('Tasks', 'item 1 in 1 week\n  - sub-item 1a\nitem 2');
    expect(page.buttons('Save template', page.dialog() ?? page.body)).toHaveLength(1);
    await page.submit(page.dialog());
    await page.stable(20);
    expect(page.firestore.get(`${TEMPLATES}/tg-a`)).toMatchObject({
      name: 'Checklist A',
      tasks: [
        { title: 'item 1', checklist: ['sub-item 1a'], dueInDays: 7 },
        { title: 'item 2', checklist: [] },
      ],
      updatedBy: ME,
    });
    expect(page.text(page.dialog())).toContain('2 tasks · 1 checklist item');
  });

  it('deletes a template after a confirm (a soft delete)', async () => {
    const page = await openMatter(URL, { configure: seedTemplates });
    const dialog = await openTemplates(page);
    await page.click('Delete Checklist B', dialog);
    const confirm = [...page.body.querySelectorAll<HTMLElement>('.mt-dialog')].at(-1) as HTMLElement;
    expect(page.text(confirm)).toContain('Delete “Checklist B”?');
    await page.click('Delete template', confirm);
    await page.stable(20);
    expect(page.firestore.get(`${TEMPLATES}/tg-b`)).toMatchObject({ deletedBy: ME });
    expect(page.firestore.writes.some((w) => w.op === 'delete')).toBe(false);
    expect(names(page)).toEqual(['Checklist A']);
  });

  it('read-only members don’t get templates on matter tasks', async () => {
    const page = await openMatter(URL, { session: READONLY, configure: seedTemplates });
    expect(page.buttons('Task group templates')).toHaveLength(0);
  });
});
