import { TestBed } from '@angular/core/testing';

import { OrgContext } from './org-context';
import { TASK_GROUP_TEMPLATES_QUERY, taskGroupTemplatesRepository } from './task-group-templates';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Task group templates (CORE-08f): reads and client-direct writes. Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const PATH = 'orgs/org-a/taskGroupTemplates';
const TASKS = [{ title: 'Locate the original will', checklist: ['Ask the family'] }];

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  const templates = TestBed.runInInjectionContext(() => taskGroupTemplatesRepository());
  return { fs, templates };
}

describe('taskGroupTemplatesRepository', () => {
  it('lists the active org’s live templates by name', async () => {
    const { fs, templates } = setup();
    fs.set(`${PATH}/t-2`, { name: 'Checklist B', tasks: TASKS, ...meta });
    fs.set(`${PATH}/t-1`, { name: 'Checklist A', tasks: TASKS, ...meta });
    fs.set(`${PATH}/t-3`, { name: 'Gone', tasks: TASKS, deletedAt: new Date('2026-10-02T00:00:00Z'), ...meta });
    fs.set('orgs/org-b/taskGroupTemplates/t-9', { name: 'Other org', tasks: TASKS, ...meta });
    const rows = await templates.query(TASK_GROUP_TEMPLATES_QUERY);
    expect(rows.map((row) => [row.id, row.name, row.tasks.length])).toEqual([
      ['t-1', 'Checklist A', 1],
      ['t-2', 'Checklist B', 1],
    ]);
  });

  it('creates, updates and soft deletes a template, validating the values', async () => {
    const { fs, templates } = setup();
    const id = await templates.create({
      name: ' Checklist A ',
      tasks: [{ title: 'Write to the bank', priority: 'high' }],
    });
    expect(fs.get(`${PATH}/${id}`)).toMatchObject({
      name: 'Checklist A',
      tasks: [{ title: 'Write to the bank', checklist: [], priority: 'high' }],
      createdBy: 'u-jordan',
      schemaVersion: 1,
    });
    await templates.update(id, { tasks: TASKS });
    expect(fs.get(`${PATH}/${id}`)).toMatchObject({ tasks: TASKS });
    await templates.softDelete(id);
    expect(await templates.query(TASK_GROUP_TEMPLATES_QUERY)).toEqual([]);

    await expect(templates.create({ name: 'Empty', tasks: [] })).rejects.toBeTruthy();
    await expect(templates.create({ name: 'Late', tasks: [{ title: 'x', dueInDays: 400 }] })).rejects.toBeTruthy();
  });
});
