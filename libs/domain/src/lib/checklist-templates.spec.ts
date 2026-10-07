import {
  applyChecklistTemplate,
  checklistKey,
  checklistTemplateItemsFromTask,
  checklistTemplateLines,
  checklistTemplateNameFromTask,
  checklistTemplatePath,
  filterChecklistTemplates,
} from './checklist-templates';
import { TASK_CHECKLIST_MAX } from './schemas/matter-records';
import { ChecklistTemplate } from './schemas/task-templates';
import { dateOnly } from './values/date-only';

/** Checklist templates (CORE-08d). Fictional data only. */

const TODAY = dateOnly('2026-10-05');
const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};
const KICK_OFF = {
  name: 'Probate kick-off',
  items: ['Order the death certificate', 'Locate the original will', 'Search the will bank'],
};

describe('ChecklistTemplate schema', () => {
  const valid = { name: 'Probate kick-off', items: ['Order the death certificate'] };

  it('lives under the org and whitelists its fields', () => {
    expect(ChecklistTemplate.path).toBe('orgs/{orgId}/checklistTemplates');
    expect(Object.keys(ChecklistTemplate.update.shape).sort()).toEqual(['dueInDays', 'items', 'name', 'priority']);
    expect(checklistTemplatePath('org-1')).toBe('orgs/org-1/checklistTemplates');
    expect(checklistTemplatePath('org-1', 't1')).toBe('orgs/org-1/checklistTemplates/t1');
  });

  it('accepts a name, 1 to 30 items and an optional priority and due offset', () => {
    expect(ChecklistTemplate.create.safeParse(valid).success).toBe(true);
    expect(ChecklistTemplate.create.safeParse({ ...valid, priority: 'high', dueInDays: 0 }).success).toBe(true);
    expect(ChecklistTemplate.create.safeParse({ ...valid, dueInDays: 365 }).success).toBe(true);
    expect(ChecklistTemplate.create.parse({ name: '  Grant  ', items: ['  File  '] })).toEqual({
      name: 'Grant',
      items: ['File'],
    });
  });

  it('refuses invalid templates', () => {
    const bad = [
      { ...valid, name: '   ' },
      { ...valid, name: 'n'.repeat(101) },
      { ...valid, items: [] },
      { ...valid, items: Array.from({ length: 31 }, (_, i) => `Item ${i}`) },
      { ...valid, items: [' '] },
      { ...valid, items: ['i'.repeat(201)] },
      { ...valid, items: ['Two\nlines'] },
      { ...valid, priority: 'p1' },
      { ...valid, dueInDays: -1 },
      { ...valid, dueInDays: 366 },
      { ...valid, dueInDays: 1.5 },
      { ...valid, extra: true },
    ];
    for (const input of bad)
      expect(ChecklistTemplate.create.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
});

describe('applyChecklistTemplate', () => {
  it('adds the items unticked with new ids, and fills in an empty priority and due date', () => {
    const result = applyChecklistTemplate(
      { checklist: [], priority: 'none' },
      { ...KICK_OFF, priority: 'high', dueInDays: 7 },
      { today: TODAY, newId: counter() },
    );
    expect(result).toEqual({
      patch: {
        checklist: [
          { id: 'n1', text: 'Order the death certificate', done: false },
          { id: 'n2', text: 'Locate the original will', done: false },
          { id: 'n3', text: 'Search the will bank', done: false },
        ],
        priority: 'high',
        dueDate: '2026-10-12',
      },
      added: 3,
      skipped: 0,
      duplicates: 0,
      overLimit: 0,
      changed: true,
    });
  });

  it('keeps existing items (ticked or not) and skips ones already there, ignoring case and spaces', () => {
    const result = applyChecklistTemplate(
      {
        checklist: [
          { id: 'a', text: 'order the  DEATH certificate ', done: true },
          { id: 'b', text: 'Pay the fee', done: false },
        ],
      },
      { ...KICK_OFF, items: [...KICK_OFF.items, 'Search the Will Bank', '  '] },
      { today: TODAY, newId: counter() },
    );
    expect(result.patch.checklist).toEqual([
      { id: 'a', text: 'order the  DEATH certificate ', done: true },
      { id: 'b', text: 'Pay the fee', done: false },
      { id: 'n1', text: 'Locate the original will', done: false },
      { id: 'n2', text: 'Search the will bank', done: false },
    ]);
    expect(result).toMatchObject({ added: 2, skipped: 2, duplicates: 2, overLimit: 0, changed: true });
  });

  it('never changes a priority or due date the task already has', () => {
    const result = applyChecklistTemplate(
      { checklist: [], priority: 'low', dueDate: '2026-11-01' },
      { ...KICK_OFF, priority: 'urgent', dueInDays: 3 },
      { today: TODAY, newId: counter() },
    );
    expect(result.patch.priority).toBeUndefined();
    expect(result.patch.dueDate).toBeUndefined();
  });

  it('treats a missing priority as none, a template priority of none as nothing, and 0 days as today', () => {
    const result = applyChecklistTemplate({}, { ...KICK_OFF, dueInDays: 0 }, { today: TODAY, newId: counter() });
    expect(result.patch).toMatchObject({ dueDate: '2026-10-05' });
    expect(result.patch.priority).toBeUndefined();
    const noneTemplate = applyChecklistTemplate({}, { ...KICK_OFF, priority: 'none' }, { today: TODAY });
    expect(noneTemplate.patch.priority).toBeUndefined();
    const fromMissing = applyChecklistTemplate({}, { ...KICK_OFF, priority: 'medium' }, { today: TODAY });
    expect(fromMissing.patch.priority).toBe('medium');
  });

  it('crosses month and year ends in calendar days', () => {
    const result = applyChecklistTemplate({}, { ...KICK_OFF, dueInDays: 30 }, { today: dateOnly('2026-12-15') });
    expect(result.patch.dueDate).toBe('2027-01-14');
  });

  it('stops at the checklist limit and says how many were left out', () => {
    const full = Array.from({ length: TASK_CHECKLIST_MAX - 1 }, (_, i) => ({
      id: `x${i}`,
      text: `Item ${i}`,
      done: false,
    }));
    const result = applyChecklistTemplate({ checklist: full }, KICK_OFF, { today: TODAY, newId: counter() });
    expect(result.patch.checklist).toHaveLength(TASK_CHECKLIST_MAX);
    expect(result).toMatchObject({ added: 1, skipped: 2, duplicates: 0, overLimit: 2 });
  });

  it('reports no change when everything is already there', () => {
    const result = applyChecklistTemplate(
      { checklist: KICK_OFF.items.map((text, i) => ({ id: `i${i}`, text, done: false })), priority: 'high' },
      { ...KICK_OFF, priority: 'urgent' },
      { today: TODAY },
    );
    expect(result).toMatchObject({ added: 0, skipped: 3, changed: false });
  });

  it('makes ids unique within the task, even if the id source repeats', () => {
    const ids = ['a', 'a', 'b', 'c', 'd'];
    const result = applyChecklistTemplate({ checklist: [{ id: 'a', text: 'Existing', done: false }] }, KICK_OFF, {
      today: TODAY,
      newId: () => ids.shift() ?? 'z',
    });
    expect(result.patch.checklist.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    const random = applyChecklistTemplate({}, KICK_OFF, { today: TODAY });
    expect(new Set(random.patch.checklist.map((item) => item.id)).size).toBe(3);
  });

  it('does not change the task it was given', () => {
    const checklist = [{ id: 'a', text: 'Existing', done: false }];
    applyChecklistTemplate({ checklist }, KICK_OFF, { today: TODAY });
    expect(checklist).toHaveLength(1);
  });
});

describe('template items from text and tasks', () => {
  it('splits lines, trims, collapses spaces and drops blanks and repeats', () => {
    expect(
      checklistTemplateLines('  Order the certificate \n\n order the   certificate\r\nFile  the  inventory\n'),
    ).toEqual(['Order the certificate', 'File the inventory']);
    expect(checklistTemplateLines(`${'x'.repeat(250)}`)).toEqual(['x'.repeat(200)]);
  });

  it('takes a task’s checklist, at most 30 items', () => {
    const checklist = Array.from({ length: 35 }, (_, i) => ({ text: `Item ${i}` }));
    expect(checklistTemplateItemsFromTask(checklist)).toHaveLength(30);
    expect(checklistTemplateItemsFromTask([{ text: 'A' }, { text: ' a ' }, { text: 'B' }])).toEqual(['A', 'B']);
  });

  it('names a template after the task', () => {
    expect(checklistTemplateNameFromTask(`  ${'T'.repeat(120)}`)).toHaveLength(100);
  });

  it('compares lines without case or extra spaces', () => {
    expect(checklistKey('  Order  The Will ')).toBe('order the will');
  });
});

describe('filterChecklistTemplates', () => {
  const templates = [{ name: 'Probate kick-off' }, { name: 'Administration letters' }, { name: 'probate grant' }];

  it('matches every word of the query, sorted by name', () => {
    expect(filterChecklistTemplates(templates, '').map((t) => t.name)).toEqual([
      'Administration letters',
      'probate grant',
      'Probate kick-off',
    ]);
    expect(filterChecklistTemplates(templates, ' PROBATE ').map((t) => t.name)).toEqual([
      'probate grant',
      'Probate kick-off',
    ]);
    expect(filterChecklistTemplates(templates, 'grant probate').map((t) => t.name)).toEqual(['probate grant']);
    expect(filterChecklistTemplates(templates, 'wills')).toEqual([]);
  });
});
