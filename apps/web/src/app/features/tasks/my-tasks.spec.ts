import { cleanUpOverlays, MATTER, matterDoc, meta, ME, openMatter, ORG } from '../matter-detail/testing';

/** My tasks (`/tasks`) and the Today screen's short version (CORE-08). Fictional data only. */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;
const OTHER = `orgs/${ORG}/matters/m-ostler`;
const PERSONAL = `orgs/${ORG}/members/${ME}/tasks`;

function taskDoc(title: string, matterId: string | null, data: Seed = {}): Seed {
  return {
    title,
    status: 'todo',
    priority: 'none',
    order: 1024,
    checklist: [],
    source: 'manual',
    countedOpen: true,
    orgId: ORG,
    matterId,
    assigneeUid: ME,
    deletedAt: null,
    ...meta,
    ...data,
  };
}

/** Today is Sunday 4 October 2026 (the specs' MT_TODAY). */
function myTasks(fs: Page['firestore']): void {
  fs.set(OTHER, matterDoc({ number: 'M-2026-0150', title: 'Will for Bram Ostler', type: 'will', deceased: undefined }));
  fs.set(`${MATTER}/tasks/t-late`, taskDoc('File the inventory', 'm-whitfield', { dueDate: '2026-10-01' }));
  fs.set(
    `${MATTER}/tasks/t-today`,
    taskDoc('Call the executor', 'm-whitfield', { dueDate: '2026-10-04', priority: 'high' }),
  );
  fs.set(`${OTHER}/tasks/t-draft`, taskDoc('Draft the will', 'm-ostler', { dueDate: '2026-10-12' }));
  fs.set(`${MATTER}/tasks/t-done`, taskDoc('Already finished', 'm-whitfield', { status: 'done' }));
  fs.set(`${MATTER}/tasks/t-theirs`, taskDoc('Someone else’s task', 'm-whitfield', { assigneeUid: 'user-daniel' }));
  fs.set(`${PERSONAL}/p-renew`, taskDoc('Renew my practising certificate', null));
}

const sections = (page: Page) =>
  [...page.body.querySelectorAll('mt-task-list section')].map((section) => {
    const head = page.text(section.querySelector('[role="heading"]')).replace(/\s*\d+$/, '');
    const titles = [...section.querySelectorAll('.mt-task-title')].map((t) => page.text(t));
    return `${head}: ${titles.join(', ')}`;
  });

describe('my tasks', () => {
  it('lists my open tasks and personal tasks by when they’re due', async () => {
    const page = await openMatter('/tasks', { configure: myTasks });
    await page.stable(20);
    expect(page.text(page.body.querySelector('h1'))).toBe('My tasks');
    expect(sections(page)).toEqual([
      'Overdue: File the inventory',
      'Today: Call the executor',
      'Later: Draft the will',
      'No date: Renew my practising certificate',
    ]);
    const row = page.body.querySelector('li[data-key*="t-draft"]');
    expect(page.text(row)).toContain('M-2026-0150 · Will for Bram Ostler');
    expect(page.text(page.body.querySelector('li[data-key*="p-renew"]'))).toContain('Personal');
  });

  it('filters by matter type and priority', async () => {
    const page = await openMatter('/tasks', { configure: myTasks });
    await page.stable(20);
    await page.click('Matter type');
    await page.click('Will');
    expect(sections(page)).toEqual(['Later: Draft the will']);
    await page.click('Personal');
    expect(sections(page)).toEqual(['Later: Draft the will', 'No date: Renew my practising certificate']);
    await page.click('Clear filters');
    await page.click('Priority');
    await page.click('High');
    expect(sections(page)).toEqual(['Today: Call the executor']);
    // The menu stays open while ticking.
    await page.click('Clear filters');
    await page.click('Urgent');
    expect(page.text(page.body.querySelector('mt-my-tasks'))).toContain('No tasks match');
  });

  it('adds a personal task with c', async () => {
    const page = await openMatter('/tasks', { configure: myTasks });
    await page.stable(20);
    await page.press('c');
    const field = page.body.querySelector<HTMLInputElement>('mt-task-quick-add input');
    expect(field?.getAttribute('aria-label')).toBe('New personal task');
    await page.stable(50);
    (field as HTMLInputElement).value = 'Book CPD session !low';
    field?.dispatchEvent(new Event('input'));
    await page.stable(50);
    await page.press('Enter', {}, field as HTMLElement);
    await page.stable(20);
    const write = page.firestore.writes.find((w) => w.op === 'create' && w.path.startsWith(`${PERSONAL}/`));
    expect(write && page.firestore.get(write.path)).toMatchObject({
      title: 'Book CPD session',
      priority: 'low',
      assigneeUid: ME,
      matterId: null,
      status: 'todo',
    });
    expect(sections(page).at(-1)).toBe('No date: Book CPD session, Renew my practising certificate');
  });

  it('completes a task, which leaves the list', async () => {
    const page = await openMatter('/tasks', { configure: myTasks });
    await page.stable(20);
    await page.click('Done: File the inventory');
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-late`)?.['status']).toBe('done');
    expect(sections(page)[0]).toBe('Today: Call the executor');
  });

  it('changes the due date of the selection', async () => {
    const page = await openMatter('/tasks', { configure: myTasks });
    await page.stable(20);
    for (const id of ['t-late', 'p-renew']) {
      const title = page.body.querySelector<HTMLElement>(`li[data-key*="${id}"] .mt-task-title`) as HTMLElement;
      title.focus();
      await page.press('x', {}, title);
    }
    await page.click('Due date', page.body.querySelector('mt-tasks-bulk-bar') as HTMLElement);
    expect(page.text(page.dialog())).toContain('Change the due date of 2 tasks');
    await page.fill('Due date', '31/02/2026', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Enter a date like 14/10/2026.');
    await page.fill('Due date', '6/10/2026', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/tasks/t-late`)?.['dueDate']).toBe('2026-10-06');
    expect(page.firestore.get(`${PERSONAL}/p-renew`)?.['dueDate']).toBe('2026-10-06');
  });

  it('deletes the selection after confirming', async () => {
    const page = await openMatter('/tasks', { configure: myTasks });
    await page.stable(20);
    const title = page.body.querySelector<HTMLElement>('li[data-key*="p-renew"] .mt-task-title') as HTMLElement;
    title.focus();
    await page.press('x', {}, title);
    await page.click('Delete', page.body.querySelector('mt-tasks-bulk-bar') as HTMLElement);
    expect(page.text(page.dialog())).toContain('Delete “Renew my practising certificate”?');
    await page.click('Delete task', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.firestore.get(`${PERSONAL}/p-renew`)?.['deletedAt']).toBeTruthy();
    expect(page.body.querySelector('mt-tasks-bulk-bar')).toBeNull();
  });

  it('moves between tasks with j and k', async () => {
    const page = await openMatter('/tasks', { configure: myTasks });
    await page.stable(20);
    await page.press('j');
    expect(page.text(document.activeElement)).toBe('File the inventory');
    await page.press('j', {}, document.activeElement as HTMLElement);
    expect(page.text(document.activeElement)).toBe('Call the executor');
    await page.press('End', {}, document.activeElement as HTMLElement);
    expect(page.text(document.activeElement)).toBe('Renew my practising certificate');
    await page.press('k', {}, document.activeElement as HTMLElement);
    expect(page.text(document.activeElement)).toBe('Draft the will');
  });
});

describe('today', () => {
  it('shows my tasks due this week, with a link to the rest', async () => {
    const page = await openMatter('/today', { configure: myTasks });
    await page.stable(20);
    expect(page.text(page.body.querySelector('h1'))).toBe('Today');
    expect(sections(page)).toEqual(['Overdue: File the inventory', 'Today: Call the executor']);
    expect(page.buttons('All my tasks')).toHaveLength(1);
    expect(page.buttons('Add personal task')).toHaveLength(0);
  });

  it('says when nothing is due this week', async () => {
    const page = await openMatter('/today');
    await page.stable(20);
    expect(page.text(page.body.querySelector('mt-my-tasks'))).toContain('Nothing due this week');
  });
});
