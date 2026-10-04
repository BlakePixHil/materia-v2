import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { keyFactsFor, matterStages } from './matter-detail';
import { MatterTypeSchema } from './schemas/enums';
import { Task } from './schemas/matter-records';
import { MatterTemplate, MatterTemplateVersion } from './schemas/org-records';
import { SYSTEM_TEMPLATE_SOURCES, systemTemplate, systemTemplates } from './system-templates';
import {
  ApplyTemplateInput,
  hasUnmetStageEntry,
  isSystemTemplateId,
  knownEventDate,
  mapStageAcrossVersions,
  PublishTemplateInput,
  removedStageIds,
  SaveTemplateInput,
  SystemTemplateSchema,
  systemTemplateId,
  templateAssignee,
  TemplateContentSchema,
  templateProblems,
  templateTaskDocId,
  templateTaskDue,
  templateTaskFields,
  templateTaskKeyOf,
  templateTasksFor,
  unmetStageEntry,
  type TemplateContent,
} from './templates';
import { dateOnly } from './values/date-only';

/** Matter templates (CORE-07). All people and matters are fictional. */

const SYSTEM_DIR = path.resolve(import.meta.dirname, '../../templates/system');
const RULE_SET = path.resolve(import.meta.dirname, '../../../deadlines/data/rulesets/vic-v1.json');

const tiny = (overrides: Partial<TemplateContent> = {}): TemplateContent => ({
  matterType: 'probate',
  name: 'Fictional probate',
  stages: [
    { id: 'start', name: 'Start', order: 1 },
    { id: 'middle', name: 'Middle', order: 2, entryRequires: { tasksDone: ['first'], events: ['notice_published'] } },
    { id: 'end', name: 'End', order: 3, entryRequires: { facts: ['grantDate'] }, terminal: true },
  ],
  tasks: [
    {
      key: 'first',
      title: 'First',
      stageId: 'start',
      assignTo: 'responsible',
      priority: 'high',
      due: { fromStageEntry: 3 },
    },
    {
      key: 'anchored',
      title: 'Anchored',
      stageId: 'end',
      assignTo: 'role:paralegal',
      priority: 'medium',
      due: { fromEvent: 'date_of_death', offsetDays: 30 },
    },
    { key: 'loose', title: 'Loose', stageId: 'middle', assignTo: null, priority: 'none', checklist: ['a', 'b'] },
  ],
  deadlineRuleIds: [],
  ...overrides,
});

describe('system templates (the "load, validate" check)', () => {
  const files = readdirSync(SYSTEM_DIR).filter((file) => file.endsWith('.json'));

  it('has one JSON file per matter type, and bundles each', () => {
    expect(files.map((file) => file.replace('.json', '')).sort()).toEqual([...MatterTypeSchema.options].sort());
    expect(Object.keys(SYSTEM_TEMPLATE_SOURCES).sort()).toEqual([...MatterTypeSchema.options].sort());
  });

  it.each(MatterTypeSchema.options)('%s.json is a valid system template', (type) => {
    const raw = JSON.parse(readFileSync(path.join(SYSTEM_DIR, `${type}.json`), 'utf8'));
    const parsed = SystemTemplateSchema.safeParse(raw);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.matterType).toBe(type);
    expect(parsed.data?.id).toBe(systemTemplateId(type));
    // Only the bundled copy is used at run time.
    expect(SYSTEM_TEMPLATE_SOURCES[type]).toEqual(raw);
  });

  it.each(MatterTypeSchema.options)('%s: key fact requirements are facts the type shows', (type) => {
    const template = systemTemplate(systemTemplateId(type));
    const facts = keyFactsFor(type).map((fact) => fact.id);
    for (const stage of template?.stages ?? [])
      for (const id of stage.entryRequires?.facts ?? []) expect(facts).toContain(id);
    // The last stage closes the matter.
    expect(template?.stages.at(-1)?.terminal).toBe(true);
    expect(template?.stages.filter((stage) => stage.terminal)).toHaveLength(1);
  });

  it('names only deadline rules of the CORE-09 rule set that apply to the type', () => {
    const ruleSet = JSON.parse(readFileSync(RULE_SET, 'utf8')) as {
      rules: { id: string; appliesTo: { matterTypes: string[] } }[];
    };
    const rules = new Map(ruleSet.rules.map((rule) => [rule.id, rule.appliesTo.matterTypes]));
    for (const template of systemTemplates()) {
      for (const id of template.deadlineRuleIds) {
        expect(rules.has(id), `${template.id}: ${id}`).toBe(true);
        expect(rules.get(id), `${template.id}: ${id}`).toContain(template.matterType);
      }
    }
    expect(systemTemplate('system-probate')?.deadlineRuleIds).toContain('vic.distribution.s33_notice');
    expect(systemTemplate('system-will')?.deadlineRuleIds).toEqual([]);
  });

  it('follows the Victorian probate path from instructions to close', () => {
    expect(systemTemplate('system-probate')?.stages.map((stage) => stage.name)).toEqual([
      'Instructions',
      'Will & death certificate obtained',
      'Advertisement of intention to apply published',
      'Application filed (RedCrest)',
      'Grant issued',
      'Statutory (s 33) notice published',
      'Assets collected',
      'Liabilities paid',
      'Family provision window closed',
      'Distribution',
      'Closed',
    ]);
    expect(systemTemplate('system-will')?.stages.map((stage) => stage.name)).toEqual([
      'Instructions',
      'Draft',
      'Client review',
      'Execution',
      'Safe custody',
      'Closed',
    ]);
    expect(systemTemplate('system-fp')?.stages.map((stage) => stage.name)).toEqual([
      'Instructions',
      'Limitation check',
      'Letter of demand',
      'Summons filed',
      'Directions',
      'Mediation',
      'Hearing',
      'Orders',
      'Closed',
    ]);
  });

  it('knows system ids, and nothing else is a system template', () => {
    expect(isSystemTemplateId('system-probate')).toBe(true);
    expect(isSystemTemplateId('abc123')).toBe(false);
    expect(systemTemplate('abc123')).toBeUndefined();
    expect(systemTemplate('system-nope')).toBeUndefined();
    expect(systemTemplate('system-trust')).toMatchObject({ id: 'system-trust', version: 1, source: 'system' });
  });

  it('refuses a system file with the wrong id', () => {
    const raw = JSON.parse(readFileSync(path.join(SYSTEM_DIR, 'will.json'), 'utf8'));
    expect(SystemTemplateSchema.safeParse({ ...raw, id: 'system-poa' }).success).toBe(false);
  });
});

describe('template validation', () => {
  it('accepts a valid template', () => {
    expect(templateProblems(tiny())).toEqual([]);
    expect(TemplateContentSchema.safeParse(tiny()).success).toBe(true);
  });

  it('reports duplicate and unordered stages, requirements on the first stage and unknown task stages', () => {
    const content = tiny({
      stages: [
        { id: 'start', name: 'Start', order: 2, entryRequires: { events: ['hearing'] } },
        { id: 'start', name: 'Again', order: 1 },
      ],
      tasks: [
        { key: 'a', title: 'A', stageId: 'start', assignTo: null, priority: 'none' },
        { key: 'a', title: 'A again', stageId: 'start', assignTo: null, priority: 'none' },
        { key: 'b', title: 'B', stageId: 'nowhere', assignTo: null, priority: 'none' },
      ],
      deadlineRuleIds: ['x', 'x'],
    });
    expect(templateProblems(content).map((p) => [p.path.join('.'), p.message])).toEqual([
      ['stages.1.id', 'Stage ids must be unique'],
      ['stages.1.order', 'Stages must be listed in increasing order'],
      ['stages.0.entryRequires', 'The first stage cannot have requirements'],
      ['tasks.1.key', 'Task keys must be unique'],
      ['tasks.2.stageId', 'Choose one of the stages'],
      ['deadlineRuleIds', 'Deadline rules must be unique'],
    ]);
    expect(TemplateContentSchema.safeParse(content).success).toBe(false);
  });

  it('needs tasksDone to name a task of an earlier stage', () => {
    const content = tiny();
    const end = content.stages[2];
    if (end) end.entryRequires = { tasksDone: ['anchored', 'missing'] };
    expect(templateProblems(content).map((p) => p.path.join('.'))).toEqual([
      'stages.2.entryRequires.tasksDone.0',
      'stages.2.entryRequires.tasksDone.1',
    ]);
  });

  it('checks keys and dues by type', () => {
    const bad = tiny({
      tasks: [{ key: 'Bad Key', title: 'x', stageId: 'start', assignTo: null, priority: 'none' }],
    });
    expect(TemplateContentSchema.safeParse(bad).success).toBe(false);
    const due = tiny({
      tasks: [
        { key: 'a', title: 'x', stageId: 'start', assignTo: null, priority: 'none', due: { fromStageEntry: -1 } },
      ],
    });
    expect(TemplateContentSchema.safeParse(due).success).toBe(false);
  });

  it('stores org drafts and versions as entities', () => {
    const meta = { createdAt: new Date(), createdBy: 'u', updatedAt: new Date(), updatedBy: 'u', schemaVersion: 1 };
    expect(
      MatterTemplate.schema.safeParse({ ...tiny(), ...meta, version: 0, source: 'org', published: false }).success,
    ).toBe(true);
    expect(
      MatterTemplateVersion.schema.safeParse({
        ...tiny(),
        ...meta,
        templateId: 't1',
        version: 1,
        source: 'org',
        published: true,
        publishedAt: new Date(),
        publishedBy: 'u',
        stageMapping: { old: 'start' },
      }).success,
    ).toBe(true);
    // Clients never write templates: every write goes through a callable.
    expect(Object.keys(MatterTemplate.update.shape)).toEqual([]);
    expect(Object.keys(MatterTemplateVersion.update.shape)).toEqual([]);
    // Template task fields on tasks are server-owned.
    expect(Object.keys(Task.update.shape)).not.toContain('duePending');
    expect(Object.keys(Task.update.shape)).not.toContain('templateTaskKey');
  });

  it('validates the callable inputs', () => {
    const requestId = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    expect(ApplyTemplateInput.safeParse({ requestId, matterId: 'm', templateId: 't', version: 1 }).success).toBe(true);
    expect(ApplyTemplateInput.safeParse({ requestId, matterId: 'm', templateId: 't', version: 0 }).success).toBe(false);
    expect(PublishTemplateInput.safeParse({ requestId, templateId: 't', stageMapping: { a: 'b' } }).success).toBe(true);
    expect(PublishTemplateInput.safeParse({ requestId, templateId: 't', stageMapping: { a: 'B C' } }).success).toBe(
      false,
    );
    expect(SaveTemplateInput.safeParse({ requestId, templateId: 't', name: 'New name' }).success).toBe(true);
  });
});

describe('anchors and due dates', () => {
  const deceased = { contactId: 'c', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: 'Geelong VIC' };

  it('knows an event from a matter event first, then from the key fact standing for it', () => {
    expect(knownEventDate('date_of_death', { matter: { deceased }, events: [] })).toBe('2026-08-01');
    expect(
      knownEventDate('date_of_death', {
        matter: { deceased },
        events: [
          { kind: 'date_of_death', date: '2026-07-31' },
          { kind: 'date_of_death', date: '2026-07-30' },
        ],
      }),
    ).toBe('2026-07-30');
    expect(knownEventDate('grant_issued', { matter: { estate: { grantDate: '2026-09-15' } }, events: [] })).toBe(
      '2026-09-15',
    );
    expect(knownEventDate('grant_issued', { matter: {}, events: [] })).toBeUndefined();
    expect(knownEventDate('hearing', { matter: { deceased }, events: [] })).toBeUndefined();
    expect(knownEventDate('notice_published', { matter: {}, events: [{ kind: 'notice_published', date: 'x' }] })).toBe(
      undefined,
    );
  });

  it('computes due dates with DateOnly maths, or marks them pending', () => {
    const entered = dateOnly('2026-10-04');
    expect(templateTaskDue({ due: { fromStageEntry: 30 } }, { matter: {}, events: [] }, entered)).toEqual({
      dueDate: '2026-11-03',
    });
    // Across a month end and a leap day.
    expect(
      templateTaskDue(
        { due: { fromEvent: 'date_of_death', offsetDays: 1 } },
        { matter: { deceased: { ...deceased, dateOfDeath: '2028-02-28' } }, events: [] },
        entered,
      ),
    ).toEqual({ dueDate: '2028-02-29' });
    expect(
      templateTaskDue({ due: { fromEvent: 'grant_issued', offsetDays: 184 } }, { matter: {}, events: [] }, entered),
    ).toEqual({ duePending: 'grant_issued' });
    expect(templateTaskDue({}, { matter: {}, events: [] }, entered)).toEqual({});
  });

  it('assigns to the responsible person, the paralegal (else responsible) or nobody', () => {
    expect(templateAssignee('responsible', { responsibleUid: 'r', paralegalUid: 'p' })).toBe('r');
    expect(templateAssignee('role:paralegal', { responsibleUid: 'r', paralegalUid: 'p' })).toBe('p');
    expect(templateAssignee('role:paralegal', { responsibleUid: 'r' })).toBe('r');
    expect(templateAssignee(null, { responsibleUid: 'r' })).toBeUndefined();
  });

  it('creates a stage’s tasks, plus later tasks with a known anchor, never earlier ones', () => {
    const template = tiny();
    const known = { matter: { deceased }, events: [] };
    const unknown = { matter: {}, events: [] };
    expect(templateTasksFor(template, 'start', known, { knownAnchors: true }).map((t) => t.key)).toEqual([
      'first',
      'anchored',
    ]);
    expect(templateTasksFor(template, 'start', unknown, { knownAnchors: true }).map((t) => t.key)).toEqual(['first']);
    expect(templateTasksFor(template, 'start', known, { knownAnchors: false }).map((t) => t.key)).toEqual(['first']);
    expect(templateTasksFor(template, 'end', known, { knownAnchors: true }).map((t) => t.key)).toEqual(['anchored']);
    expect(templateTasksFor(template, 'nowhere', known, { knownAnchors: true })).toEqual([]);
  });

  it('makes task fields with a deterministic id, the stage as group and the template order', () => {
    const template = tiny();
    const [, anchored, loose] = template.tasks;
    const options = { stageEnteredOn: dateOnly('2026-10-04'), responsibleUid: 'u-r', paralegalUid: 'u-p' };
    expect(templateTaskFields(template, anchored as never, { matter: {}, events: [] }, options)).toEqual({
      title: 'Anchored',
      status: 'todo',
      priority: 'medium',
      assigneeUid: 'u-p',
      duePending: 'date_of_death',
      group: 'End',
      checklist: [],
      order: 2,
      source: 'template',
      templateTaskKey: 'anchored',
    });
    expect(templateTaskFields(template, loose as never, { matter: {}, events: [] }, options)).toMatchObject({
      checklist: [
        { id: 'c1', text: 'a', done: false },
        { id: 'c2', text: 'b', done: false },
      ],
    });
    expect(templateTaskDocId('first')).toBe('tpl-first');
    expect(templateTaskKeyOf('tpl-first')).toBe('first');
    expect(templateTaskKeyOf('manual-1')).toBeUndefined();
  });
});

describe('stage requirements', () => {
  const stages = matterStages('probate', tiny().stages);
  const ctx = (extra: Partial<Parameters<typeof unmetStageEntry>[3]> = {}) => ({
    matter: {},
    events: [],
    doneTaskKeys: new Set<string>(),
    ...extra,
  });

  it('maps template stages for the stepper (name → title) with their requirements', () => {
    expect(stages.map((s) => [s.id, s.title])).toEqual([
      ['start', 'Start'],
      ['middle', 'Middle'],
      ['end', 'End'],
    ]);
    expect(stages[1]).toMatchObject({ events: ['notice_published'], tasksDone: ['first'] });
    expect(stages[2]).toMatchObject({ requires: ['grantDate'], terminal: true });
    // A stage with a CORE-06 default id keeps the default's key facts too.
    expect(
      matterStages('probate', [
        { id: 'start', name: 'Start' },
        { id: 'grant_issued', name: 'Grant' },
      ])[1],
    ).toMatchObject({ requires: ['grantDate'], criteria: 'Grant received from the court' });
  });

  it('checks every stage passed on a forward move, skips included', () => {
    expect(unmetStageEntry(stages, 'start', 'end', ctx())).toEqual({
      requirements: ['grantDate'],
      events: ['notice_published'],
      tasks: ['first'],
    });
    const met = ctx({
      matter: { estate: { grantDate: '2026-09-01' } },
      events: [{ kind: 'notice_published', date: '2026-08-20' }],
      doneTaskKeys: new Set(['first']),
    });
    expect(hasUnmetStageEntry(unmetStageEntry(stages, 'start', 'end', met))).toBe(false);
    expect(unmetStageEntry(stages, undefined, 'middle', ctx({ doneTaskKeys: new Set(['first']) }))).toEqual({
      requirements: [],
      events: ['notice_published'],
      tasks: [],
    });
  });

  it('has nothing to check going back or staying', () => {
    expect(hasUnmetStageEntry(unmetStageEntry(stages, 'end', 'start', ctx()))).toBe(false);
    expect(hasUnmetStageEntry(unmetStageEntry(stages, 'middle', 'middle', ctx()))).toBe(false);
  });
});

describe('versions', () => {
  it('lists the stages a new version drops', () => {
    const next = tiny({
      stages: [
        { id: 'start', name: 'Start', order: 1 },
        { id: 'end', name: 'End', order: 2 },
      ],
    });
    expect(removedStageIds(tiny(), next)).toEqual(['middle']);
    expect(removedStageIds(next, tiny())).toEqual([]);
  });

  it('follows stage mappings across versions', () => {
    const v2 = { stages: [{ id: 'a' }, { id: 'c' }], stageMapping: { b: 'c' } };
    const v3 = { stages: [{ id: 'a' }, { id: 'd' }], stageMapping: { c: 'd' } };
    expect(mapStageAcrossVersions('b', [v2, v3])).toBe('d');
    expect(mapStageAcrossVersions('a', [v2, v3])).toBe('a');
    expect(mapStageAcrossVersions('x', [v2, v3])).toBeUndefined();
    expect(mapStageAcrossVersions('b', [])).toBe('b');
  });
});
