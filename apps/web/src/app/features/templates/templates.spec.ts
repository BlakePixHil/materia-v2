import {
  ADMIN,
  cleanUpOverlays,
  LAWYER,
  meta,
  openMatter,
  ORG,
  TEMPLATES_ON,
  type OpenOptions,
} from '../matter-detail/testing';

/**
 * Settings → Templates (CORE-07): the list, customising a system template, and the editor's save
 * (field errors here and from the server) and publish (with a stage mapping). Fictional data only.
 */

afterEach(cleanUpOverlays);

const TEMPLATE = `orgs/${ORG}/templates/tpl-wills`;
const content = {
  name: 'Wills (fictional practice)',
  matterType: 'will',
  stages: [
    { id: 'start', name: 'Instructions', order: 10 },
    { id: 'review', name: 'Client review', order: 20, entryRequires: { tasksDone: ['call_client'] } },
    { id: 'done', name: 'Signed', order: 30, terminal: true },
  ],
  tasks: [
    {
      key: 'call_client',
      title: 'Call the client',
      stageId: 'start',
      assignTo: 'responsible',
      due: { fromStageEntry: 2 },
      priority: 'high',
      checklist: ['Confirm executors'],
    },
  ],
  deadlineRuleIds: [],
};

function open(url = '/settings/templates/tpl-wills', options: OpenOptions = {}) {
  return openMatter(url, {
    session: ADMIN,
    flags: TEMPLATES_ON,
    ...options,
    configure: (fs, port) => {
      fs.set(TEMPLATE, { ...content, version: 1, published: true, source: 'org', ...meta });
      fs.set(`${TEMPLATE}/versions/1`, {
        ...content,
        templateId: 'tpl-wills',
        version: 1,
        published: true,
        source: 'org',
        publishedAt: meta.createdAt,
        publishedBy: 'user-priya',
        ...meta,
      });
      fs.set(`orgs/${ORG}/templates/tpl-draft`, {
        ...content,
        name: 'Advance care (draft)',
        version: 0,
        published: false,
        source: 'org',
        ...meta,
      });
      options.configure?.(fs, port);
    },
  });
}

type Page = Awaited<ReturnType<typeof open>>;
const stageBox = (page: Page, n: number) =>
  [...page.body.querySelectorAll('fieldset.item')].find(
    (f) => f.querySelector('legend')?.textContent?.trim() === `Stage ${n}`,
  );
const fieldError = (root: Element | null | undefined, label: string) =>
  [...(root?.querySelectorAll('mt-text-field, mt-select') ?? [])]
    .find((field) => field.querySelector('.mt-label')?.textContent?.trim().startsWith(label))
    ?.querySelector('.mt-error')
    ?.textContent?.trim();

describe('templates list', () => {
  it('lists the org’s templates with their version, and the system templates', async () => {
    const page = await open('/settings/templates');
    const ours = page.body.querySelector('[data-template="tpl-wills"]');
    expect(page.text(ours)).toContain('Wills (fictional practice)');
    expect(page.text(ours)).toContain('Published v1');
    expect(page.text(page.body.querySelector('[data-template="tpl-draft"]'))).toContain('Draft');
    expect(page.text(page.body.querySelector('[data-template="system-probate"]'))).toContain('System v1');
  });

  it('customises a system template into a new draft and opens it', async () => {
    const page = await open('/settings/templates', {
      callables: {
        'templates-clone': (data, fs) => {
          fs.set(`orgs/${ORG}/templates/tpl-new`, {
            ...content,
            name: data['name'],
            version: 0,
            published: false,
            source: 'org',
            basedOn: { templateId: 'system-will', version: 1 },
            ...meta,
          });
          return { templateId: 'tpl-new' };
        },
      },
    });
    await page.click('Customise Will');
    await page.stable();
    expect(page.calls('templates-clone')).toEqual([
      { sourceTemplateId: 'system-will', name: 'Will (customised)', requestId: expect.any(String) },
    ]);
    expect(page.router.url).toBe('/settings/templates/tpl-new');
    expect(page.text(page.body.querySelector('h1'))).toBe('Will (customised)');
    expect(page.text()).toContain('Based on Will (system) v1');
  });

  it('is for owners and admins only', async () => {
    const page = await open('/settings/templates', { session: LAWYER });
    expect(page.router.url).toBe('/no-access');
  });

  it('is hidden while matter templates are off', async () => {
    const page = await open('/settings/templates', { flags: {} });
    expect(page.router.url).toBe('/today');
  });
});

describe('template editor: saving', () => {
  it('checks the draft before sending and shows problems at their fields', async () => {
    const page = await open();
    await page.fill('Stage name', '', stageBox(page, 2));
    await page.fill('Stage id', 'start', stageBox(page, 3));
    await page.click('Save draft');
    expect(page.calls('templates-save')).toEqual([]);
    expect(fieldError(stageBox(page, 3), 'Stage id')).toContain('Stage ids must be unique');
    expect(page.text(page.body.querySelector('.problems'))).toContain('Stage 2 name');
  });

  it('shows the server’s field errors at their paths', async () => {
    const page = await open(undefined, {
      callables: {
        'templates-save': () => {
          throw {
            code: 'functions/invalid-argument',
            details: { code: 'INVALID_ARGUMENT', fields: { 'stages.1.name': ['Use a shorter name'] } },
          };
        },
      },
    });
    await page.fill('Template name', 'Wills, revised');
    await page.click('Save draft');
    expect(page.calls('templates-save')).toHaveLength(1);
    expect(fieldError(stageBox(page, 2), 'Stage name')).toBe('Use a shorter name');
    expect(page.text(page.body.querySelector('.problems'))).toContain('Stage 2 name: Use a shorter name');
  });

  it('saves edited tasks, stages and requirements', async () => {
    const page = await open(undefined, {
      callables: { 'templates-save': (data) => ({ templateId: data['templateId'] }) },
    });
    const task = page.body.querySelector<HTMLDetailsElement>('details[data-task="call_client"]');
    if (task) task.open = true;
    await page.stable();
    await page.fill('Task title', 'Call the client back', task ?? page.body);
    // Native selects take the option's index: "Days from an event".
    await page.fill('Due', '1', task ?? page.body);
    await page.fill('Offset days', '-3', task ?? page.body);
    await page.click('Move stage 3 up');
    await page.click('Save draft');
    const [saved] = page.calls('templates-save') as { stages: { id: string }[]; tasks: unknown[] }[];
    expect(saved?.stages.map((stage) => stage.id)).toEqual(['start', 'done', 'review']);
    expect(saved?.tasks).toEqual([
      expect.objectContaining({
        key: 'call_client',
        title: 'Call the client back',
        due: { fromEvent: 'date_of_death', offsetDays: -3 },
        checklist: ['Confirm executors'],
      }),
    ]);
    expect(page.text()).toContain('Draft saved');
  });

  it('adds and removes stages and tasks', async () => {
    const page = await open(undefined, {
      callables: { 'templates-save': (data) => ({ templateId: data['templateId'] }) },
    });
    await page.click('Add stage');
    await page.fill('Stage name', 'Storage', stageBox(page, 4));
    await page.click('Add task');
    await page.fill(
      'Task title',
      'Store the original',
      page.body.querySelector('details[data-task="task_2"]') ?? page.body,
    );
    await page.click('Remove stage 2');
    await page.click('Save draft');
    const [saved] = page.calls('templates-save') as { stages: { id: string }[]; tasks: { key: string }[] }[];
    expect(saved?.stages.map((stage) => stage.id)).toEqual(['start', 'done', 'stage_4']);
    expect(saved?.tasks.map((t) => t.key)).toEqual(['call_client', 'task_2']);
  });
});

describe('template editor: publishing', () => {
  it('publishes the next version', async () => {
    const page = await open(undefined, {
      callables: { 'templates-publish': () => ({ templateId: 'tpl-wills', version: 2 }) },
    });
    await page.click('Publish v2');
    expect(page.calls('templates-publish')).toEqual([{ templateId: 'tpl-wills', requestId: expect.any(String) }]);
    expect(page.text()).toContain('Published v2');
  });

  it('asks where matters in removed stages go, then publishes with the mapping', async () => {
    const page = await open(undefined, {
      callables: {
        'templates-save': (data) => ({ templateId: data['templateId'] }),
        'templates-publish': (data) => {
          if (!data['stageMapping']) {
            throw {
              code: 'functions/failed-precondition',
              details: { code: 'TEMPLATE_STAGE_MAPPING_REQUIRED', stages: ['review'], allowed: ['start', 'done'] },
            };
          }
          return { templateId: 'tpl-wills', version: 2 };
        },
      },
    });
    await page.click('Remove stage 2');
    await page.click('Publish v2');
    expect(page.calls('templates-save')).toHaveLength(1);
    const dialog = page.dialog();
    expect(page.text(dialog)).toContain('Matters in Client review move to');
    // Native selects take the option's index: "Signed".
    await page.fill('Matters in Client review move to', '1', dialog ?? page.body);
    await page.submit(dialog);
    expect(page.calls('templates-publish')[1]).toEqual(
      expect.objectContaining({ templateId: 'tpl-wills', stageMapping: { review: 'done' } }),
    );
    expect(page.text()).toContain('Published v2');
  });
});
