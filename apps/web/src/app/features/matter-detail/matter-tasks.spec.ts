import { cleanUpOverlays, MATTER, meta, ME, openMatter, PRIYA, READONLY } from './testing';

/** The matter's Tasks tab (CORE-08). Fictional data only. */

afterEach(cleanUpOverlays);

const URL = '/matters/m-whitfield/tasks';
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

function taskDoc(title: string, data: Seed = {}): Seed {
  return {
    title,
    status: 'todo',
    priority: 'none',
    order: 1024,
    checklist: [],
    source: 'manual',
    countedOpen: true,
    orgId: 'org-harbour-vine',
    matterId: 'm-whitfield',
    deletedAt: null,
    ...meta,
    ...data,
  };
}

/** Three more tasks: two under the Intake stage (template tasks carry the stage name), one in a group. */
function moreTasks(fs: Page['firestore']): void {
  fs.set(`${MATTER}/tasks/t-will`, taskDoc('Locate the original will', { order: 2048, group: 'Intake' }));
  fs.set(`${MATTER}/tasks/t-id`, taskDoc('Verify the executor’s identity', { order: 3072, group: 'Intake' }));
  fs.set(
    `${MATTER}/tasks/t-bank`,
    taskDoc('Write to the bank', { order: 4096, group: 'Letters', assigneeUid: 'user-gone', priority: 'high' }),
  );
}

/** Each section as `Heading: title, title`. */
const sections = (page: Page) =>
  [...page.body.querySelectorAll('mt-task-list section')].map((section) => {
    const head = page.text(section.querySelector('[role="heading"]')).replace(/\s*\d+$/, '');
    const titles = [...section.querySelectorAll('.mt-task-title')].map((t) => page.text(t));
    return `${head}: ${titles.join(', ')}`;
  });

const title = (page: Page, text: string) =>
  [...page.body.querySelectorAll<HTMLElement>('.mt-task-title')].find((t) => page.text(t) === text) as HTMLElement;

describe('matter tasks tab', () => {
  it('groups tasks by stage, or by their own group, and remembers the choice', async () => {
    const page = await openMatter(URL, { configure: moreTasks });
    expect(page.text(page.body.querySelector('mt-matter-tasks h2'))).toBe('Tasks');
    expect(page.text(page.body.querySelector('mt-matter-tasks .head'))).toContain('4 open');
    expect(sections(page)).toEqual([
      'Intake: Locate the original will, Verify the executor’s identity',
      'Letters: Write to the bank',
      'Other tasks: Order the death certificate',
    ]);
    await page.click('Group');
    expect(sections(page)).toEqual([
      'Intake: Locate the original will, Verify the executor’s identity',
      'Letters: Write to the bank',
      'No group: Order the death certificate',
    ]);
    expect(localStorage.getItem('materia.tasks.groupBy')).toBe('group');
    localStorage.removeItem('materia.tasks.groupBy');
  });

  it('shows a former member as the assignee, and the checklist count', async () => {
    const page = await openMatter(URL, {
      configure: (fs) => {
        moreTasks(fs);
        fs.set(`${MATTER}/tasks/t-will`, {
          ...taskDoc('Locate the original will', { order: 2048, group: 'Intake' }),
          checklist: [
            { id: 'a', text: 'Ask the client', done: true },
            { id: 'b', text: 'Search the will bank', done: false },
          ],
        });
      },
    });
    const row = (text: string) => title(page, text).closest('li') as HTMLElement;
    expect(page.text(row('Write to the bank'))).toContain('Unassigned (former member)');
    expect(page.text(row('Locate the original will'))).toContain('Checklist 1/2');
  });

  it('adds a task with c: @name, !priority and a due date are parsed as you type', async () => {
    const page = await openMatter(URL);
    await page.press('c');
    const field = page.body.querySelector<HTMLInputElement>('mt-task-quick-add input');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    await page.stable(50);
    (field as HTMLInputElement).value = 'Lodge the inventory @priya !high due 9/10/2026 @nobody';
    field?.dispatchEvent(new Event('input'));
    await page.stable(50);
    const quickAdd = page.body.querySelector('mt-task-quick-add');
    expect(page.text(quickAdd)).toContain('Assigned to Priya Shah · High priority · Due 9 Oct 2026');
    expect(page.text(quickAdd)).toContain('No one in the team matches @nobody');
    expect([...(quickAdd?.querySelectorAll('mark') ?? [])].map((m) => m.dataset['kind'])).toEqual([
      'assignee',
      'priority',
      'due',
      'unresolved',
    ]);
    await page.press('Enter', {}, field as HTMLElement);
    await page.stable(20);
    const write = page.firestore.writes.find((w) => w.op === 'create' && w.path.startsWith(`${MATTER}/tasks/`));
    const created = write && page.firestore.get(write.path);
    expect(created).toMatchObject({
      title: 'Lodge the inventory @nobody',
      assigneeUid: PRIYA,
      priority: 'high',
      dueDate: '2026-10-09',
      status: 'todo',
      countedOpen: false,
    });
    // The line stays open for the next task; Escape closes it.
    expect(field?.value).toBe('');
    await page.press('Escape', {}, field as HTMLElement);
    expect(page.body.querySelector('mt-task-quick-add')).toBeNull();
    await page.stable(20);
    expect(page.text(document.activeElement)).toContain('Add task');
  });

  it('completes a task with Space, with an Undo', async () => {
    const page = await openMatter(URL);
    const t = title(page, 'Order the death certificate');
    t.focus();
    await page.press(' ', {}, t);
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['status']).toBe('done');
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Task done');
    await page.click('Undo');
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['status']).toBe('todo');
  });

  it('asks before completing a task with unticked checklist items', async () => {
    const page = await openMatter(URL, {
      configure: (fs) =>
        fs.set(`${MATTER}/tasks/t-cert`, {
          ...(fs.get(`${MATTER}/tasks/t-cert`) as Seed),
          checklist: [{ id: 'a', text: 'Request from BDM', done: false }],
        }),
    });
    await page.click('Done: Order the death certificate');
    expect(page.text(page.dialog())).toContain('Complete this task anyway?');
    expect(page.text(page.dialog())).toContain('1 checklist item isn’t ticked yet.');
    await page.click('Cancel', page.dialog() ?? page.body);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['status']).toBe('todo');
    await page.click('Done: Order the death certificate');
    await page.click('Complete anyway', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['status']).toBe('done');
  });

  it('offers to mark a linked deadline as done too', async () => {
    const page = await openMatter(URL, {
      configure: (fs) =>
        fs.set(`${MATTER}/tasks/t-cert`, { ...(fs.get(`${MATTER}/tasks/t-cert`) as Seed), deadlineId: 'd-notice' }),
    });
    await page.click('Done: Order the death certificate');
    await page.stable(20);
    expect(page.text(page.dialog())).toContain('Mark the deadline as done too?');
    await page.click('Mark deadline done', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['status']).toBe('done');
    // Through deadlines-complete (CORE-10): the rules refuse a direct status write.
    expect(page.calls('deadlines-complete')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', deadlineId: 'd-notice', outcome: 'done' }),
    ]);
    expect(page.firestore.writes.some((w) => w.path === `${MATTER}/deadlines/d-notice`)).toBe(false);
    expect(page.firestore.get(`${MATTER}/deadlines/d-notice`)?.['status']).toBe('done');
  });

  it('moves a task with Alt+Down and announces it', async () => {
    const page = await openMatter(URL, { configure: moreTasks });
    const t = title(page, 'Locate the original will');
    t.focus();
    await page.press('ArrowDown', { altKey: true }, t);
    await page.stable(20);
    expect(sections(page)[0]).toBe('Intake: Verify the executor’s identity, Locate the original will');
    expect(page.text(page.body.querySelector('mt-task-list [aria-live]'))).toBe(
      'Moved Locate the original will to position 2 of 2 in Intake.',
    );
    const orders = ['t-will', 't-id'].map((id) => page.firestore.get(`${MATTER}/tasks/${id}`)?.['order'] as number);
    expect(orders[0]).toBeGreaterThan(orders[1] as number);
    // The moved task keeps focus.
    expect(page.text(document.activeElement)).toBe('Locate the original will');
    await page.press('ArrowDown', { altKey: true }, document.activeElement as HTMLElement);
    expect(page.text(page.body.querySelector('mt-task-list [aria-live]'))).toBe(
      'Locate the original will is already last in Intake.',
    );
  });

  it('selects with x and assigns the selection in bulk', async () => {
    const page = await openMatter(URL, { configure: moreTasks });
    for (const text of ['Locate the original will', 'Write to the bank']) {
      const t = title(page, text);
      t.focus();
      await page.press('x', {}, t);
    }
    const bar = page.body.querySelector<HTMLElement>('mt-tasks-bulk-bar');
    expect(page.text(bar)).toContain('2 selected');
    await page.click('Assign', bar as HTMLElement);
    await page.click('Jordan Price');
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-will`)?.['assigneeUid']).toBe(ME);
    expect(page.firestore.get(`${MATTER}/tasks/t-bank`)?.['assigneeUid']).toBe(ME);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('2 tasks assigned to Jordan Price');
    await page.press('Escape');
    expect(page.body.querySelector('mt-tasks-bulk-bar')).toBeNull();
  });

  it('changes more than 50 tasks through tasks-bulkUpdate, and says which were skipped', async () => {
    const page = await openMatter(URL, {
      configure: (fs) => {
        for (let i = 1; i <= 55; i++) {
          fs.set(`${MATTER}/tasks/t-bulk-${i}`, taskDoc(`Fictional task ${i}`, { order: 2048 + i }));
        }
      },
      callables: {
        'tasks-bulkUpdate': (data) => ({
          updated: (data['tasks'] as unknown[]).length - 1,
          skipped: [{ matterId: 'm-whitfield', taskId: 't-bulk-1', reason: 'deleted' }],
        }),
      },
    });
    const first = title(page, 'Order the death certificate');
    first.focus();
    await page.press('a', { ctrlKey: true }, first);
    const bar = page.body.querySelector<HTMLElement>('mt-tasks-bulk-bar');
    expect(page.text(bar)).toContain('56 selected');
    await page.click('Priority', bar as HTMLElement);
    await page.click('Urgent');
    await page.stable(20);
    const calls = page.calls('tasks-bulkUpdate');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ change: { op: 'priority', priority: 'urgent' }, requestId: expect.any(String) });
    expect(calls[0]?.['tasks']).toHaveLength(56);
    expect(calls[0]?.['tasks']).toContainEqual({ matterId: 'm-whitfield', taskId: 't-cert' });
    const toasts = page.text(page.body.querySelector('.mt-toaster'));
    expect(toasts).toContain('1 task wasn’t changed');
    expect(toasts).toContain('It was deleted, or is on a matter you can’t change.');
    expect(toasts).toContain('56 tasks set to urgent');
    // Nothing was written directly.
    expect(page.firestore.writes.filter((w) => w.op === 'update')).toEqual([]);
  });

  it('shows the callable’s error when a bulk change fails', async () => {
    const page = await openMatter(URL, {
      configure: (fs) => {
        for (let i = 1; i <= 51; i++) fs.set(`${MATTER}/tasks/t-bulk-${i}`, taskDoc(`Fictional task ${i}`));
      },
      callables: {
        'tasks-bulkUpdate': () => {
          throw { code: 'functions/permission-denied', details: { code: 'PERMISSION_DENIED' } };
        },
      },
    });
    const first = title(page, 'Order the death certificate');
    first.focus();
    await page.press('a', { metaKey: true }, first);
    await page.click('Priority', page.body.querySelector('mt-tasks-bulk-bar') as HTMLElement);
    await page.click('Low');
    await page.stable(20);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Those tasks didn’t change');
  });

  it('edits the title inline and ticks checklist items in the details', async () => {
    const page = await openMatter(URL);
    await page.click('Edit title: Order the death certificate');
    const editor = page.body.querySelector<HTMLInputElement>('.mt-task-edit');
    (editor as HTMLInputElement).value = 'Order two death certificates';
    await page.press('Enter', {}, editor as HTMLElement);
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['title']).toBe('Order two death certificates');

    await page.click('Details: Order two death certificates');
    // The add field shows only once asked for (CORE-08c).
    expect(page.body.querySelector('mt-task-details .add')).toBeNull();
    expect(page.text(page.body.querySelector('mt-task-details'))).toContain('Add checklist item');
    page.body.querySelector<HTMLButtonElement>('mt-task-details .start')?.click();
    await page.stable(5);
    const add = page.body.querySelector<HTMLInputElement>('mt-task-details .add');
    expect(document.activeElement).toBe(add);
    for (const text of ['Pay the fee', 'Post the form']) {
      (add as HTMLInputElement).value = text;
      add?.dispatchEvent(new Event('input'));
      await page.press('Enter', {}, add as HTMLElement);
      await page.stable(20);
    }
    const checklist = page.firestore.get(`${MATTER}/tasks/t-cert`)?.['checklist'] as { text: string; done: boolean }[];
    expect(checklist).toEqual([
      { id: expect.any(String), text: 'Pay the fee', done: false },
      { id: expect.any(String), text: 'Post the form', done: false },
    ]);
    // Still open for more; Escape closes it and returns to the button.
    const field = page.body.querySelector<HTMLInputElement>('mt-task-details .add');
    await page.press('Escape', {}, field as HTMLElement);
    await page.stable(5);
    expect(page.body.querySelector('mt-task-details .add')).toBeNull();
    expect(document.activeElement).toBe(page.body.querySelector('mt-task-details .start'));
    const box = page.body.querySelector<HTMLInputElement>('mt-task-details li input[type="checkbox"]');
    box?.click();
    await page.stable(20);
    expect((page.firestore.get(`${MATTER}/tasks/t-cert`)?.['checklist'] as { done: boolean }[])[0]?.done).toBe(true);
  });

  it('changes the priority from the details', async () => {
    const page = await openMatter(URL);
    await page.click('Details: Order the death certificate');
    const selects = page.body.querySelectorAll<HTMLSelectElement>('mt-task-details select');
    const priority = selects[1] as HTMLSelectElement;
    priority.value = 'urgent';
    priority.dispatchEvent(new Event('change'));
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['priority']).toBe('urgent');
  });

  it('starts a new group from the details, and clears it again', async () => {
    const page = await openMatter(URL, { configure: moreTasks });
    await page.click('Group');
    await page.click('Details: Order the death certificate');
    const field = page.body.querySelector<HTMLInputElement>('mt-task-details input.group') as HTMLInputElement;
    expect(field.value).toBe('');
    const suggestions = [...page.body.querySelectorAll<HTMLOptionElement>('mt-task-details datalist option')];
    // The list's groups first, then the matter's other stages.
    expect(suggestions.map((option) => option.value).slice(0, 3)).toEqual(['Intake', 'Letters', 'Grant application']);
    field.value = '  Checklist A ';
    field.dispatchEvent(new Event('change'));
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['group']).toBe('Checklist A');
    expect(sections(page)).toContain('Checklist A: Order the death certificate');

    const again = page.body.querySelector<HTMLInputElement>('mt-task-details input.group') as HTMLInputElement;
    again.value = '';
    again.dispatchEvent(new Event('change'));
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['group']).toBeUndefined();
    expect(sections(page)).toContain('No group: Order the death certificate');
    localStorage.removeItem('materia.tasks.groupBy');
  });

  it('moves the selection into a group from the bulk bar', async () => {
    const page = await openMatter(URL, { configure: moreTasks });
    for (const text of ['Order the death certificate', 'Locate the original will']) {
      const t = title(page, text);
      t.focus();
      await page.press('x', {}, t);
    }
    const bar = page.body.querySelector<HTMLElement>('mt-tasks-bulk-bar') as HTMLElement;
    await page.click('Group', bar);
    // The dialog is a lazy chunk: wait for it rather than for a fixed time.
    await vi.waitFor(async () => {
      await page.stable(20);
      expect(page.body.querySelector('mt-task-group-dialog')).not.toBeNull();
    });
    const dialog = page.body.querySelector<HTMLElement>('mt-task-group-dialog') as HTMLElement;
    expect(page.text(dialog)).toContain('Move 2 tasks to a group');
    await page.click('Letters', dialog);
    await page.click('Move to group', dialog);
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['group']).toBe('Letters');
    expect(page.firestore.get(`${MATTER}/tasks/t-will`)?.['group']).toBe('Letters');
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('2 tasks moved to Letters');
  });

  it('is read-only for read-only members', async () => {
    const page = await openMatter(URL, { session: READONLY });
    expect(page.buttons('Add task')).toHaveLength(0);
    const check = page.body.querySelector<HTMLButtonElement>('mt-task-row .mt-check');
    expect(check?.disabled).toBe(true);
    await page.press('c');
    expect(page.body.querySelector('mt-task-quick-add')).toBeNull();
  });
});
