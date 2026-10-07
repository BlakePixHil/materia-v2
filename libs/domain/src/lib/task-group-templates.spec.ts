import { TaskGroupTemplate } from './schemas/task-templates';
import {
  parseTaskGroupOutline,
  planTaskGroup,
  taskGroupOutline,
  taskGroupTemplateName,
  taskGroupTemplatePath,
  taskGroupTemplateTasks,
} from './task-group-templates';
import { dateOnly } from './values/date-only';

/** Task group templates (CORE-08f). Fictional data only. */

const TODAY = dateOnly('2026-10-05');
const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

describe('TaskGroupTemplate schema', () => {
  const valid = { name: 'Checklist A', tasks: [{ title: 'Order the death certificate' }] };

  it('lives under the org and whitelists its fields', () => {
    expect(TaskGroupTemplate.path).toBe('orgs/{orgId}/taskGroupTemplates');
    expect(Object.keys(TaskGroupTemplate.update.shape).sort()).toEqual(['name', 'tasks']);
    expect(taskGroupTemplatePath('org-1')).toBe('orgs/org-1/taskGroupTemplates');
    expect(taskGroupTemplatePath('org-1', 't1')).toBe('orgs/org-1/taskGroupTemplates/t1');
  });

  it('accepts a name and 1 to 50 tasks, each with a checklist and optional defaults', () => {
    expect(TaskGroupTemplate.create.parse(valid)).toEqual({
      name: 'Checklist A',
      tasks: [{ title: 'Order the death certificate', checklist: [] }],
    });
    const full = {
      name: 'Checklist A',
      tasks: [{ title: 'Write to the bank', checklist: ['Account numbers'], priority: 'high', dueInDays: 7 }],
    };
    expect(TaskGroupTemplate.create.safeParse(full).success).toBe(true);
  });

  it('refuses invalid templates', () => {
    const task = { title: 'Write to the bank' };
    const bad = [
      { ...valid, name: ' ' },
      { ...valid, name: 'n'.repeat(121) },
      { ...valid, tasks: [] },
      { ...valid, tasks: Array.from({ length: 51 }, () => task) },
      { ...valid, tasks: [{ title: ' ' }] },
      { ...valid, tasks: [{ title: 'Two\nlines' }] },
      { ...valid, tasks: [{ ...task, checklist: Array.from({ length: 31 }, (_, i) => `Item ${i}`) }] },
      { ...valid, tasks: [{ ...task, priority: 'p1' }] },
      { ...valid, tasks: [{ ...task, dueInDays: 366 }] },
      { ...valid, extra: true },
    ];
    for (const value of bad)
      expect(TaskGroupTemplate.create.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('parseTaskGroupOutline', () => {
  it('reads tasks and their indented checklist items', () => {
    const outline = ['* item 1', '   * sub-item 1a', '   * sub-item 1b', '* item 2', '', '* item 3'].join('\n');
    expect(parseTaskGroupOutline(outline)).toEqual({
      tasks: [
        { title: 'item 1', checklist: ['sub-item 1a', 'sub-item 1b'] },
        { title: 'item 2', checklist: [] },
        { title: 'item 3', checklist: [] },
      ],
      problems: [],
    });
  });

  it('takes plain lines, numbers, boxes and tabs too', () => {
    const outline = 'Locate the original will\n\tAsk the family\n\t[ ] Search the will bank\n2. Write to the bank';
    expect(parseTaskGroupOutline(outline).tasks).toEqual([
      { title: 'Locate the original will', checklist: ['Ask the family', 'Search the will bank'] },
      { title: 'Write to the bank', checklist: [] },
    ]);
  });

  it('reads !priority and "in N days" on a task line', () => {
    const { tasks } = parseTaskGroupOutline(
      [
        'Order the death certificate !high in 3 days',
        'Lodge the inventory due in 2 weeks !l !urgent',
        'Call the executor in 1d',
        'Keep !nonsense words',
        'Pay the fee !none',
      ].join('\n'),
    );
    expect(tasks).toEqual([
      { title: 'Order the death certificate', checklist: [], priority: 'high', dueInDays: 3 },
      { title: 'Lodge the inventory', checklist: [], priority: 'urgent', dueInDays: 14 },
      { title: 'Call the executor', checklist: [], dueInDays: 1 },
      { title: 'Keep !nonsense words', checklist: [] },
      { title: 'Pay the fee', checklist: [] },
    ]);
  });

  it('drops repeated checklist items and reports what is over the limits', () => {
    const items = Array.from({ length: 31 }, (_, i) => `  - Item ${i}`);
    const outline = ['Big task', '  - Item 0', ...items, 'Far task in 400 days'].join('\n');
    const result = parseTaskGroupOutline(outline);
    expect(result.tasks[0]?.checklist).toHaveLength(31);
    expect(result.problems).toEqual([
      '“Far task” is due more than 365 days out.',
      '“Big task” has 31 checklist items; a template task holds up to 30.',
    ]);
    const many = Array.from({ length: 51 }, (_, i) => `Task ${i}`).join('\n');
    expect(parseTaskGroupOutline(many).problems).toEqual(['A template holds up to 50 tasks; this has 51.']);
  });

  it('round-trips through taskGroupOutline', () => {
    const tasks = [
      {
        title: 'Order the death certificate',
        checklist: ['Two certified copies'],
        priority: 'high' as const,
        dueInDays: 1,
      },
      { title: 'Write to the bank', checklist: [], dueInDays: 14 },
      { title: 'Notify Centrelink', checklist: ['Reference number', 'Date of death'] },
    ];
    const outline = taskGroupOutline(tasks);
    expect(outline).toBe(
      [
        'Order the death certificate !high in 1 day',
        '  - Two certified copies',
        'Write to the bank in 14 days',
        'Notify Centrelink',
        '  - Reference number',
        '  - Date of death',
      ].join('\n'),
    );
    expect(parseTaskGroupOutline(outline).tasks).toEqual(tasks);
  });
});

describe('saving a group', () => {
  it('keeps titles, checklist texts and priorities, at most 50 tasks', () => {
    const tasks = taskGroupTemplateTasks([
      {
        title: '  Locate   the original will ',
        checklist: [{ text: 'Ask the family' }, { text: 'ask THE family' }, { text: ' ' }],
        priority: 'high',
      },
      { title: 'Write to the bank', priority: 'none' },
      { title: '   ' },
    ]);
    expect(tasks).toEqual([
      { title: 'Locate the original will', checklist: ['Ask the family'], priority: 'high' },
      { title: 'Write to the bank', checklist: [] },
    ]);
    expect(taskGroupTemplateTasks(Array.from({ length: 60 }, (_, i) => ({ title: `T${i}` })))).toHaveLength(50);
    expect(taskGroupTemplateName(`  ${'g'.repeat(130)} `)).toHaveLength(120);
  });
});

describe('planTaskGroup', () => {
  it('plans one task per template task in the template’s group, after the last task', () => {
    const planned = planTaskGroup(
      {
        name: ' Checklist A ',
        tasks: [
          { title: 'item 1', checklist: ['sub-item 1a', 'sub-item 1b'], priority: 'high', dueInDays: 3 },
          { title: 'item 2', checklist: [] },
        ],
      },
      { today: TODAY, firstOrder: 5120, newId: counter() },
    );
    expect(planned).toEqual([
      {
        title: 'item 1',
        group: 'Checklist A',
        checklist: [
          { id: 'n1', text: 'sub-item 1a', done: false },
          { id: 'n2', text: 'sub-item 1b', done: false },
        ],
        priority: 'high',
        dueDate: '2026-10-08',
        order: 5120,
      },
      { title: 'item 2', group: 'Checklist A', checklist: [], priority: 'none', order: 6144 },
    ]);
  });
});
