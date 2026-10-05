import { TestBed } from '@angular/core/testing';

import { CHECKLIST_TEMPLATES_QUERY, checklistTemplatesRepository } from './checklist-templates';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Checklist templates (CORE-08d): reads and client-direct writes. Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const PATH = 'orgs/org-a/checklistTemplates';

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  const templates = TestBed.runInInjectionContext(() => checklistTemplatesRepository());
  return { fs, templates };
}

describe('checklistTemplatesRepository', () => {
  it('lists the active org’s live templates by name', async () => {
    const { fs, templates } = setup();
    fs.set(`${PATH}/t-2`, { name: 'Probate kick-off', items: ['Order the death certificate'], ...meta });
    fs.set(`${PATH}/t-1`, { name: 'Grant application', items: ['Swear the affidavit'], priority: 'high', ...meta });
    fs.set(`${PATH}/t-3`, { name: 'Gone', items: ['x'], deletedAt: new Date('2026-10-02T00:00:00Z'), ...meta });
    fs.set('orgs/org-b/checklistTemplates/t-9', { name: 'Other org', items: ['x'], ...meta });
    const rows = await templates.query(CHECKLIST_TEMPLATES_QUERY);
    expect(rows.map((row) => [row.id, row.name, row.priority])).toEqual([
      ['t-1', 'Grant application', 'high'],
      ['t-2', 'Probate kick-off', undefined],
    ]);
  });

  it('creates, updates and soft deletes a template, validating the values', async () => {
    const { fs, templates } = setup();
    const id = await templates.create({
      name: ' Probate kick-off ',
      items: ['Order the death certificate'],
      dueInDays: 7,
    });
    expect(fs.get(`${PATH}/${id}`)).toMatchObject({
      name: 'Probate kick-off',
      items: ['Order the death certificate'],
      dueInDays: 7,
      createdBy: 'u-jordan',
      schemaVersion: 1,
    });
    await templates.update(id, { items: ['Locate the original will'], priority: 'urgent' }, { remove: ['dueInDays'] });
    expect(fs.get(`${PATH}/${id}`)).toMatchObject({ items: ['Locate the original will'], priority: 'urgent' });
    expect(fs.get(`${PATH}/${id}`)).not.toHaveProperty('dueInDays');
    await templates.softDelete(id);
    expect(fs.get(`${PATH}/${id}`)).toMatchObject({ deletedBy: 'u-jordan' });
    expect(await templates.query(CHECKLIST_TEMPLATES_QUERY)).toEqual([]);

    await expect(templates.create({ name: 'Empty', items: [] })).rejects.toBeTruthy();
    await expect(templates.create({ name: 'Late', items: ['x'], dueInDays: 400 })).rejects.toBeTruthy();
    await expect(templates.update(id, { createdBy: 'someone-else' })).rejects.toBeTruthy();
  });
});
