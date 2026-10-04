import { cleanUpOverlays, MATTER, meta, openMatter, ORG, PARALEGAL, TEMPLATES_ON } from './testing';

/**
 * The matter screen with matter templates on (CORE-07): moving back a stage, requirements that
 * name events and template tasks, upgrading to a newer template version and tasks whose due date
 * waits for an event. Fictional data only.
 */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
const stage = (page: Page, title: string) =>
  [...page.body.querySelectorAll<HTMLElement>('mt-estate-stepper button')].find((b) => b.textContent?.includes(title));
const note = (page: Page) => page.body.querySelector('mt-matter-stages mt-note');

describe('open tasks on the overview', () => {
  it('say when a due date waits for an event', async () => {
    const page = await openMatter(undefined, {
      configure: (fs) =>
        fs.set(`${MATTER}/tasks/tpl-file_application`, {
          title: 'File the application for probate',
          status: 'todo',
          priority: 'high',
          duePending: 'notice_published',
          order: 2,
          checklist: [],
          orgId: ORG,
          matterId: 'm-whitfield',
          ...meta,
        }),
    });
    const tasks = page.body.querySelector('[aria-labelledby="mt-ov-tasks"]');
    const row = [...(tasks?.querySelectorAll('li') ?? [])].find((li) => li.textContent?.includes('File the'));
    expect(page.text(row?.querySelector('.pending'))).toBe(
      'Due date pending: Notice of intended application published unknown',
    );
  });
});

describe('stages with templates on', () => {
  it('asks a lawyer why when moving back, and sends the reason', async () => {
    const page = await openMatter(undefined, { flags: TEMPLATES_ON, matter: { stageId: 'grant_issued' } });
    stage(page, 'Intake')?.click();
    await page.stable();
    expect(page.text(page.dialog())).toContain('Move back to Intake');
    await page.fill('Reason', 'Executor withdrew the application');
    await page.submit(page.dialog());
    expect(page.calls('matters-changeStage')).toEqual([
      expect.objectContaining({ stageId: 'intake', reason: 'Executor withdrew the application' }),
    ]);
    expect(page.firestore.get(MATTER)?.['stageId']).toBe('intake');
  });

  it('doesn’t move back when the reason dialog is cancelled', async () => {
    const page = await openMatter(undefined, { flags: TEMPLATES_ON, matter: { stageId: 'grant_issued' } });
    stage(page, 'Intake')?.click();
    await page.stable();
    await page.click('Cancel', page.dialog() ?? page.body);
    expect(page.calls('matters-changeStage')).toEqual([]);
  });

  it('locks earlier stages for members who aren’t lawyers, with the reason', async () => {
    const page = await openMatter(undefined, {
      session: PARALEGAL,
      flags: TEMPLATES_ON,
      matter: { stageId: 'grant_issued' },
    });
    const intake = stage(page, 'Intake');
    expect(intake?.getAttribute('aria-disabled')).toBe('true');
    intake?.click();
    await page.stable();
    expect(page.dialog()).toBeNull();
    expect(page.calls('matters-changeStage')).toEqual([]);
    // Forward moves stay open.
    expect(stage(page, 'Collection')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('lists missing events and template tasks by name', async () => {
    const page = await openMatter(undefined, {
      flags: TEMPLATES_ON,
      matter: { templateId: 'system-probate', templateVersion: 1, stageId: 'instructions' },
      callables: {
        'matters-changeStage': () => {
          throw {
            code: 'functions/failed-precondition',
            details: {
              code: 'MATTER_STAGE_REQUIREMENTS',
              requirements: [],
              events: ['grant_issued', 'notice_published'],
              tasks: ['obtain_death_certificate', 'retrieve_original_will'],
            },
          };
        },
      },
    });
    stage(page, 'Will & death certificate obtained')?.click();
    await page.stable();
    const text = page.text(note(page));
    // An event a key fact stands for is recorded from the key facts.
    expect(text).toContain('To move to Will & death certificate obtained, record: Grant date');
    expect(text).toContain('Also record these events: Notice of intended application published.');
    expect(text).toContain(
      'And finish these tasks: Obtain the death certificate, Retrieve the original will from safe custody.',
    );
    expect(page.buttons('Try again', note(page) ?? page.body)).toEqual([]);
  });

  it('offers to try again once only events or tasks are left', async () => {
    const page = await openMatter(undefined, {
      flags: TEMPLATES_ON,
      callables: {
        'matters-changeStage': () => {
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'MATTER_STAGE_REQUIREMENTS', requirements: [], events: [], tasks: ['send_letter'] },
          };
        },
      },
    });
    stage(page, 'Grant application')?.click();
    await page.stable();
    expect(page.text(note(page))).toContain('To move to Grant application, finish these tasks: send letter.');
    await page.click('Try again', note(page) ?? page.body);
    expect(page.calls('matters-changeStage')).toHaveLength(2);
  });
});

/** An org template at v2, with the matter on v1. */
function onOrgTemplate(version = 2) {
  const content = {
    name: 'Probate (fictional practice)',
    matterType: 'probate',
    stages: [
      { id: 'intake', name: 'Intake', order: 10 },
      { id: 'grant_application', name: 'Grant application', order: 20 },
    ],
    tasks: [],
    deadlineRuleIds: [],
    source: 'org',
    published: true,
    ...meta,
  };
  return {
    flags: TEMPLATES_ON,
    matter: { templateId: 'tpl-probate', templateVersion: 1 },
    configure: (fs: Page['firestore']) => {
      fs.set(`orgs/${ORG}/templates/tpl-probate`, { ...content, version });
      fs.set(`orgs/${ORG}/templates/tpl-probate/versions/1`, {
        ...content,
        templateId: 'tpl-probate',
        version: 1,
        publishedAt: meta.createdAt,
        publishedBy: 'user-priya',
      });
    },
  };
}

describe('upgrading a matter’s template', () => {
  it('offers the newer version, explains it, and says how many tasks were added', async () => {
    const page = await openMatter(undefined, {
      ...onOrgTemplate(),
      callables: {
        'matters-upgradeTemplate': (data) => ({
          matterId: data['matterId'],
          templateId: 'tpl-probate',
          version: data['version'],
          stageId: 'intake',
          createdTaskIds: ['tpl-a', 'tpl-b'],
        }),
      },
    });
    await page.click('More matter actions');
    await page.click('Upgrade matter to v2');
    expect(page.text(page.dialog())).toContain('Only tasks it doesn’t have yet are added');
    await page.click('Upgrade to v2', page.dialog() ?? page.body);
    expect(page.calls('matters-upgradeTemplate')).toEqual([
      { matterId: 'm-whitfield', version: 2, requestId: expect.any(String) },
    ]);
    expect(page.text()).toContain('Upgraded to v2');
    expect(page.text()).toContain('2 tasks added.');
  });

  it('isn’t offered when the matter is on the latest version', async () => {
    const page = await openMatter(undefined, onOrgTemplate(1));
    await page.click('More matter actions');
    expect(page.buttons('Upgrade matter')).toEqual([]);
  });

  it('says why an upgrade was refused', async () => {
    const page = await openMatter(undefined, {
      ...onOrgTemplate(),
      callables: {
        'matters-upgradeTemplate': () => {
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'FAILED_PRECONDITION', reason: 'stage_unmapped' },
          };
        },
      },
    });
    await page.click('More matter actions');
    await page.click('Upgrade matter to v2');
    await page.click('Upgrade to v2', page.dialog() ?? page.body);
    expect(page.text()).toContain('The matter’s stage isn’t in that version.');
  });
});
