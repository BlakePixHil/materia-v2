import { domain } from '../domain.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { migId, Warnings, type TransformContext, type WarningCode } from './context.ts';
import { mapChecklistTemplates, UNTITLED_TEMPLATE } from './templates.ts';

const { CHECKLIST_TEMPLATE_ITEM_MAX, CHECKLIST_TEMPLATE_ITEMS_MAX, CHECKLIST_TEMPLATE_NAME_MAX } = domain;
const UID = FIXTURE_UIDS.subject;
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const TEMPLATES = 'workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/checklist-templates';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map(),
    members: new Set([UID]),
    warnings: new Warnings(),
    ...over,
  };
}

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

function template(id: string, over: Record<string, unknown> = {}): ExportRecord {
  return {
    path: `${TEMPLATES}/${id}`,
    data: {
      id,
      title: 'Will intake',
      items: [{ name: 'Take instructions' }, { name: 'Send quote' }],
      createdOn: '2024-05-01T00:00:00.000Z',
      updatedOn: '2024-05-02T00:00:00.000Z',
      ...over,
    },
  };
}

const names = (count: number, prefix = 'Step') =>
  Array.from({ length: count }, (_, i) => ({ id: `i${i}`, name: `${prefix} ${i + 1}` }));

describe('mapChecklistTemplates', () => {
  it("maps the fixtures' checklist templates to the org's templates", () => {
    const ctx = makeCtx();
    const records = mapChecklistTemplates(
      ctx,
      loadLegacyFixtures()
        .docs.filter((doc) => doc.path.includes('/checklist-templates/'))
        .map((doc) => ({ path: doc.path, data: doc.data })),
    );
    expect(records).toHaveLength(2);
    const [intake, probate] = records;
    const intakePath = `${TEMPLATES}/7e3a0000-0000-4000-8000-000000000001`;
    expect(intake?.entity).toBe('checklist-templates');
    expect(intake?.legacyPath).toBe(intakePath);
    // The document id is the template's id; the legacy `id` field (…0aa) is wrong.
    expect(intake?.path).toBe(`orgs/org1/checklistTemplates/${migId(intakePath)}`);
    expect(intake?.data).toEqual({
      name: 'Will intake',
      items: ['Take instructions', 'Send quote'],
      createdAt: new Date('2024-05-01T00:00:00.000Z'),
      createdBy: UID,
      updatedAt: new Date('2024-05-01T00:00:00.000Z'),
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: intakePath, loadedAt: AS_OF },
    });
    expect(probate?.data).toMatchObject({ name: 'Probate steps', items: ['Obtain death certificate'] });
    for (const record of records) {
      expect(domain.ChecklistTemplateSchema.parse(record.data)).toEqual(record.data);
      expect(JSON.stringify(record.data)).not.toContain('templateExists');
    }
    expect(warned(ctx)).toEqual({ MIG_W_TEMPLATE_ID_MISMATCH: [intakePath] });
  });

  it('warns when the legacy id differs from the document id, and not when it is missing', () => {
    const ctx = makeCtx();
    const records = mapChecklistTemplates(ctx, [
      template('t1', { id: 'something-else' }),
      template('t2', { id: undefined }),
      template('t3'),
    ]);
    expect(records.map((record) => record.path)).toEqual([
      `orgs/org1/checklistTemplates/${migId(`${TEMPLATES}/t1`)}`,
      `orgs/org1/checklistTemplates/${migId(`${TEMPLATES}/t2`)}`,
      `orgs/org1/checklistTemplates/${migId(`${TEMPLATES}/t3`)}`,
    ]);
    expect(warned(ctx)).toEqual({ MIG_W_TEMPLATE_ID_MISMATCH: [`${TEMPLATES}/t1`] });
  });

  it(`keeps the first ${CHECKLIST_TEMPLATE_ITEMS_MAX} items, with a warning`, () => {
    const ctx = makeCtx();
    const [record] = mapChecklistTemplates(ctx, [template('t1', { items: names(35) })]);
    const items = record?.data?.['items'] as string[];
    expect(items).toHaveLength(CHECKLIST_TEMPLATE_ITEMS_MAX);
    expect(items.at(-1)).toBe('Step 30');
    expect(warned(ctx)).toEqual({ MIG_W_TEMPLATE_TRUNCATED: [`${TEMPLATES}/t1`] });
    expect(() => domain.ChecklistTemplateSchema.parse(record?.data)).not.toThrow();
  });

  it(`keeps exactly ${CHECKLIST_TEMPLATE_ITEMS_MAX} items without a warning`, () => {
    const ctx = makeCtx();
    const [record] = mapChecklistTemplates(ctx, [template('t1', { items: names(CHECKLIST_TEMPLATE_ITEMS_MAX) })]);
    expect(record?.data?.['items']).toHaveLength(CHECKLIST_TEMPLATE_ITEMS_MAX);
    expect(warned(ctx)).toEqual({});
  });

  it('skips a template with no items, with a warning', () => {
    const ctx = makeCtx();
    const records = mapChecklistTemplates(ctx, [
      template('empty', { items: [] }),
      template('blank', { items: [{ name: '' }, { name: '   ' }, null, 'text'] }),
      template('missing', { items: undefined }),
    ]);
    expect(records).toEqual([]);
    expect(warned(ctx)).toEqual({
      MIG_W_TEMPLATE_EMPTY: [`${TEMPLATES}/blank`, `${TEMPLATES}/empty`, `${TEMPLATES}/missing`],
    });
  });

  it('drops blank items and tidies the spacing of the rest', () => {
    const [record] = mapChecklistTemplates(makeCtx(), [
      template('t1', { items: [{ name: '' }, { name: '  Call   the  executor ' }, null, { name: 'Line\nbreak' }] }),
    ]);
    expect(record?.data?.['items']).toEqual(['Call the executor', 'Line break']);
    expect(() => domain.ChecklistTemplateSchema.parse(record?.data)).not.toThrow();
  });

  it(`cuts items longer than ${CHECKLIST_TEMPLATE_ITEM_MAX} characters`, () => {
    const ctx = makeCtx();
    const [record] = mapChecklistTemplates(ctx, [template('t1', { items: [{ name: 'x'.repeat(250) }] })]);
    expect(record?.data?.['items']).toEqual(['x'.repeat(CHECKLIST_TEMPLATE_ITEM_MAX)]);
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [`${TEMPLATES}/t1`] });
  });

  it('names a template with no title as untitled, with a warning', () => {
    const ctx = makeCtx();
    const [record] = mapChecklistTemplates(ctx, [template('t1', { title: ' ' })]);
    expect(record?.data?.['name']).toBe(UNTITLED_TEMPLATE);
    expect(UNTITLED_TEMPLATE).toBe('Untitled checklist (imported)');
    expect(warned(ctx)).toEqual({ MIG_W_UNTITLED: [`${TEMPLATES}/t1`] });
  });

  it(`cuts a name longer than ${CHECKLIST_TEMPLATE_NAME_MAX} characters`, () => {
    const ctx = makeCtx();
    const [record] = mapChecklistTemplates(ctx, [template('t1', { title: 'N'.repeat(150) })]);
    expect(record?.data?.['name']).toBe('N'.repeat(CHECKLIST_TEMPLATE_NAME_MAX));
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [`${TEMPLATES}/t1`] });
  });

  it('dates a template with no readable dates at the export time, with a warning', () => {
    const ctx = makeCtx();
    const [record] = mapChecklistTemplates(ctx, [template('t1', { createdOn: 'x', updatedOn: undefined })]);
    expect(record?.data).toMatchObject({ createdAt: AS_OF, updatedAt: AS_OF });
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [`${TEMPLATES}/t1`] });
  });

  it('skips templates whose document is gone', () => {
    expect(mapChecklistTemplates(makeCtx(), [{ path: `${TEMPLATES}/gone`, data: null }])).toEqual([]);
  });
});
