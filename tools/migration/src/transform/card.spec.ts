import type * as z from 'zod';

import type { MatterType } from '@materia/domain';

import { domain } from '../domain.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { docId, type StorageObject } from '../legacy/snapshot.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { mapCard, matterIdOf, UNTITLED_MATTER, type CardDeps } from './card.ts';
import {
  migId,
  Warnings,
  type EntityName,
  type TransformContext,
  type TransformedRecord,
  type WarningCode,
} from './context.ts';
import { CopyPlanSchema } from './run.ts';
import { mapWorkflow, type WorkflowPlan } from './workflow.ts';

const UID = FIXTURE_UIDS.subject;
const COLLEAGUE = FIXTURE_UIDS.colleague;
const DEPARTED = FIXTURE_UIDS.departed;
const WILLS = '0b6f1c2e-5d4a-4c3b-9a8e-111111111111';
const ESTATES = '0b6f1c2e-5d4a-4c3b-9a8e-222222222222';
const LANE = {
  enquiries: '5a1e0000-0000-4000-8000-000000000001',
  drafting: '5a1e0000-0000-4000-8000-000000000002',
  signed: '5a1e0000-0000-4000-8000-000000000003',
  closed: '5a1e0000-0000-4000-8000-000000000004',
  probate: '5a1e0000-0000-4000-8000-000000000005',
  administration: '5a1e0000-0000-4000-8000-000000000006',
};
const LABEL = {
  urgent: '1abe1000-0000-4000-8000-000000000001',
  referral: '1abe1000-0000-4000-8000-000000000002',
};
const REFERRER = '7e7e0000-0000-4000-8000-000000000001';
const REFERRER_CONTACT = 'referrerContact0001';
const CARD = `workflows/${WILLS}/cards/WillsCardAuto0000009`;
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const CREATED = new Date('2025-01-10T00:30:00.000Z');
const UPDATED = new Date('2025-02-10T00:30:00.000Z');
const NUMBER = 'M-2025-0001';

const { docs } = loadLegacyFixtures();
const fixture = (path: string): Record<string, unknown> => {
  const doc = docs.find((d) => d.path === path);
  if (!doc) throw new Error(`No fixture ${path}`);
  return doc.data;
};

let profile: MappingProfile;
let wills: WorkflowPlan;
let estates: WorkflowPlan;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
  const plan = (id: string) => {
    const path = `workflows/${id}`;
    const result = mapWorkflow(makeCtx(), { path, id, data: fixture(path) } as ExportRecord);
    if (!result) throw new Error(`No plan for ${path}`);
    return result;
  };
  wills = plan(WILLS);
  estates = plan(ESTATES);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map<string, string | null>([
      [COLLEAGUE, 'Jordan Ellis'],
      [DEPARTED, null],
    ]),
    members: new Set([UID]),
    warnings: new Warnings(),
    ...over,
  };
}

const withDefaults = (defaults: Partial<MappingProfile['matterDefaults']>, over: Partial<MappingProfile> = {}) =>
  makeCtx({ profile: { ...profile, ...over, matterDefaults: { ...profile.matterDefaults, ...defaults } } });

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

/** A card on the Wills board's Drafting column, like the fixtures'. */
function card(over: Record<string, unknown> = {}, path = CARD): ExportRecord {
  return {
    path,
    data: {
      id: docId(path),
      swimlaneId: LANE.drafting,
      workflowId: WILLS,
      order: 0,
      title: 'Jane Smith - will',
      description: '',
      priority: 0,
      assignee: UID,
      referrerId: '',
      dueDate: '',
      checklists: [],
      labelIds: [],
      linkedCardIds: [],
      history: [],
      comments: [],
      fee: { id: 'fee9', billingType: 'fixed', value: 3300 },
      hoursEstimate: null,
      actualHours: null,
      matterReference: null,
      billable: null,
      archived: false,
      createdOn: '2025-01-10T00:30:00.000Z',
      updatedOn: '2025-02-10T00:30:00.000Z',
      ...over,
    },
  } as ExportRecord;
}

function deps(over: Partial<CardDeps> = {}): CardDeps {
  return {
    plan: wills,
    number: NUMBER,
    referrers: new Map([[REFERRER, REFERRER_CONTACT]]),
    subjectName: 'Alex Rivers',
    attachments: [],
    objects: new Map(),
    ...over,
  };
}

const SCHEMAS: Partial<Record<EntityName, z.ZodType>> = {
  contacts: domain.ContactSchema,
  matters: domain.MatterSchema,
  parties: domain.PartySchema,
  tasks: domain.TaskSchema,
  notes: domain.NoteSchema,
  activity: domain.ActivitySchema,
  documents: domain.MatterDocumentSchema,
};

function expectValid(record: TransformedRecord) {
  const schema = SCHEMAS[record.entity];
  if (!schema) throw new Error(`No schema for ${record.entity}`);
  expect(schema.parse(record.data), record.legacyPath).toEqual(record.data);
  if (record.copy) expect(CopyPlanSchema.parse(record.copy)).toEqual(record.copy);
}

const matterData = (result: ReturnType<typeof mapCard>) => result.matter.data ?? {};
const recordAt = (result: ReturnType<typeof mapCard>, legacyPath: string) =>
  result.records.find((record) => record.legacyPath === legacyPath);

describe('mapCard', () => {
  it('maps a card to a matter with its client', () => {
    const ctx = makeCtx();
    const result = mapCard(ctx, card(), deps());
    const matterId = migId(CARD);
    const clientPath = `orgs/org1/contacts/${migId(`${CARD}#client`)}`;
    const template = domain.systemTemplate('system-will');
    expect(template).toBeDefined();
    expect(matterIdOf(CARD)).toBe(matterId);
    expect(result.matter.entity).toBe('matters');
    expect(result.matter.path).toBe(`orgs/org1/matters/${matterId}`);
    expect(result.matter.legacyPath).toBe(CARD);
    expect(result.matter.data).toEqual({
      number: NUMBER,
      title: 'Jane Smith - will',
      type: 'will',
      status: 'open',
      stageId: 'draft',
      templateId: template?.id,
      templateVersion: template?.version,
      jurisdiction: 'VIC',
      responsibleUid: UID,
      teamUids: [],
      clientContactIds: [docId(clientPath)],
      fee: { arrangement: 'fixed', amountCents: 330000, history: [] },
      costsDisclosure: { status: 'required' },
      conflictCheck: { status: 'clear', reason: 'Opened before Materia (imported)' },
      privileged: false,
      priority: 'none',
      labels: ['board:Wills & powers'],
      relatedMatterIds: [],
      search: domain.matterSearchTokens({ number: NUMBER, title: 'Jane Smith - will', clientNames: ['Jane Smith'] }),
      openTaskCount: 0,
      wipCents: 0,
      recomputeVersion: 0,
      legacy: { fee: { id: 'fee9', billingType: 'fixed', value: 3300 } },
      deletedAt: null,
      createdAt: CREATED,
      createdBy: UID,
      updatedAt: UPDATED,
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: CARD, loadedAt: AS_OF },
      needsReview: ['client_from_title'],
    });
    expect(result.records.map((record) => [record.entity, record.legacyPath])).toEqual([
      ['contacts', `${CARD}#client`],
      ['parties', `${CARD}#client-party`],
    ]);
    const [client, party] = result.records;
    expect(client?.path).toBe(clientPath);
    expect(client?.data).toMatchObject({ kind: 'person', givenNames: 'Jane', familyName: 'Smith', isReferrer: false });
    expect(party?.path).toBe(`orgs/org1/matters/${matterId}/parties/client-${docId(clientPath)}`);
    expect(result.links).toEqual([]);
    expectValid(result.matter);
    for (const record of result.records) expectValid(record);
    expect(warned(ctx)).toEqual({});
  });

  describe('title', () => {
    it('trims the title', () => {
      const result = mapCard(makeCtx(), card({ title: '  Fictional Client Two   -  will  ' }), deps());
      expect(matterData(result)['title']).toBe('Fictional Client Two - will');
    });

    it.each(['', '   ', null])('titles a card with no title (%j) as untitled, for review', (title) => {
      const ctx = makeCtx();
      const result = mapCard(ctx, card({ title }), deps());
      expect(matterData(result)).toMatchObject({
        title: UNTITLED_MATTER,
        needsReview: ['title_missing', 'client_placeholder'],
      });
      expect(UNTITLED_MATTER).toBe('Untitled matter (imported)');
      // No name to take: the client is the placeholder.
      expect(result.records[0]?.data).toMatchObject({ kind: 'organisation', orgName: 'Client (imported)' });
      expect(warned(ctx)).toEqual({ MIG_W_UNTITLED: [CARD] });
      expectValid(result.matter);
    });

    it('flags the placeholder client of an untitled card as a placeholder', () => {
      const result = mapCard(makeCtx(), card({ title: '' }), deps());
      expect(matterData(result)['needsReview']).toContain('client_placeholder');
      expect(matterData(result)['needsReview']).not.toContain('client_from_title');
    });
  });

  describe('status', () => {
    it.each([
      [LANE.enquiries, 'lead', undefined],
      [LANE.drafting, 'open', 'draft'],
      [LANE.signed, 'open', 'safe_custody'],
    ])('places a card in lane %s as %s at stage %s', (swimlaneId, status, stageId) => {
      const data = matterData(mapCard(makeCtx(), card({ swimlaneId }), deps()));
      expect(data['status']).toBe(status);
      expect(data['stageId']).toBe(stageId);
      expect(data).not.toHaveProperty('closedAt');
    });

    it("takes a column's own matter type", () => {
      const result = mapCard(
        makeCtx(),
        card({ swimlaneId: LANE.administration, title: 'Estate of Fictional Person' }, `workflows/${ESTATES}/cards/E1`),
        deps({ plan: estates }),
      );
      const template = domain.systemTemplate('system-admin');
      expect(matterData(result)).toMatchObject({
        type: 'admin',
        status: 'open',
        stageId: 'assets_collected',
        templateId: template?.id,
        templateVersion: template?.version,
        labels: ['board:Estates'],
      });
      expectValid(result.matter);
    });

    it('opens a card whose column is gone, for review', () => {
      const ctx = makeCtx();
      const result = mapCard(ctx, card({ swimlaneId: 'ffffffff-0000-4000-8000-000000000000' }), deps());
      expect(matterData(result)).toMatchObject({
        status: 'open',
        type: 'will',
        needsReview: ['swimlane_unknown', 'client_from_title'],
      });
      expect(matterData(result)).not.toHaveProperty('stageId');
      expect(warned(ctx)).toEqual({ MIG_W_SWIMLANE_UNKNOWN: [CARD] });
      expectValid(result.matter);
    });

    it('closes a card in the closed column without a closing record, for review', () => {
      const result = mapCard(makeCtx(), card({ swimlaneId: LANE.closed }), deps());
      expect(matterData(result)).toMatchObject({
        status: 'closed',
        stageId: 'closed',
        closedAt: UPDATED,
        costsDisclosure: { status: 'not_required' },
        conflictCheck: { status: 'clear', reason: 'Opened before Materia (imported)' },
        needsReview: ['closed_without_closing_record', 'client_from_title'],
      });
      expect(matterData(result)).not.toHaveProperty('archivedAt');
      expectValid(result.matter);
    });

    it('archives an archived card, closed and archived at its last update', () => {
      const result = mapCard(makeCtx(), card({ archived: true, swimlaneId: LANE.drafting }), deps());
      expect(matterData(result)).toMatchObject({
        status: 'archived',
        stageId: 'draft',
        closedAt: UPDATED,
        archivedAt: UPDATED,
        costsDisclosure: { status: 'not_required' },
        needsReview: ['closed_without_closing_record', 'client_from_title'],
      });
      expectValid(result.matter);
    });

    it('archives an archived lead too, with its conflict check clear', () => {
      const data = matterData(mapCard(makeCtx(), card({ archived: true, swimlaneId: LANE.enquiries }), deps()));
      expect(data).toMatchObject({ status: 'archived', conflictCheck: { status: 'clear' } });
    });

    it("archives the fixture's card updated before it was created at its created time", () => {
      const ctx = makeCtx();
      const path = `workflows/${WILLS}/cards/WillsCardAuto0000004`;
      const result = mapCard(ctx, { path, data: fixture(path) } as ExportRecord, deps());
      const created = new Date('2025-03-01T00:00:00.000Z');
      expect(matterData(result)).toMatchObject({
        status: 'archived',
        createdAt: created,
        updatedAt: created,
        closedAt: created,
        archivedAt: created,
        externalRef: '1234',
      });
      expect(warned(ctx)).toMatchObject({ MIG_W_UPDATED_BEFORE_CREATED: [path] });
    });
  });

  describe('client contact', () => {
    it.each([
      ['Jane Smith - will', { kind: 'person', givenNames: 'Jane', familyName: 'Smith' }],
      ['Jane Mary Smith – EPOA', { kind: 'person', givenNames: 'Jane Mary', familyName: 'Smith' }],
      ['Jane Smith : will and EPOA', { kind: 'person', givenNames: 'Jane', familyName: 'Smith' }],
      ['Jane Smith | will', { kind: 'person', givenNames: 'Jane', familyName: 'Smith' }],
      ['Jane-Anne Smith', { kind: 'person', givenNames: 'Jane-Anne', familyName: 'Smith' }],
      ['Estate of Fictional Person', { kind: 'organisation', orgName: 'Estate of Fictional Person' }],
      ['estate of A. Person - probate', { kind: 'organisation', orgName: 'estate of A. Person' }],
    ])('names the client of "%s" from the title', (title, expected) => {
      const result = mapCard(makeCtx(), card({ title }), deps());
      const [client] = result.records;
      expect(client?.entity).toBe('contacts');
      expect(client?.data).toMatchObject(expected);
      expect(matterData(result)['needsReview']).toEqual(['client_from_title']);
      expect(matterData(result)['clientContactIds']).toEqual([docId(client?.path ?? '')]);
      if (client) expectValid(client);
    });

    it('ends the name at a colon written with no space before it', () => {
      const [client] = mapCard(makeCtx(), card({ title: 'Jane Smith: will and EPOA' }), deps()).records;
      expect(client?.data).toMatchObject({ kind: 'person', givenNames: 'Jane', familyName: 'Smith' });
    });

    it('finds the matter by its client name', () => {
      const data = matterData(mapCard(makeCtx(), card({ title: 'Jane Smith - will' }), deps()));
      expect(data['search']).toEqual(expect.arrayContaining(['smith']));
    });

    it('gives every matter one "Client (imported)" placeholder under the placeholder policy', () => {
      const ctx = withDefaults({ clientContact: 'placeholder' });
      const result = mapCard(ctx, card(), deps());
      const [client] = result.records;
      expect(client?.legacyPath).toBe(`${CARD}#client`);
      expect(client?.data).toMatchObject({ kind: 'organisation', orgName: 'Client (imported)' });
      expect(client?.data).not.toHaveProperty('givenNames');
      expect(matterData(result)['needsReview']).toEqual(['client_placeholder']);
      expect(matterData(result)['search']).toEqual(
        domain.matterSearchTokens({ number: NUMBER, title: 'Jane Smith - will', clientNames: ['Client (imported)'] }),
      );
      expectValid(result.matter);
      if (client) expectValid(client);
    });
  });

  describe('client party', () => {
    it("adds the client's party row, so the parties tab and clientContactIds agree", () => {
      const ctx = makeCtx();
      const result = mapCard(ctx, card(), deps());
      const [client, party] = result.records;
      const contactId = docId(client?.path ?? '');
      const matterId = migId(CARD);
      expect(party).toEqual({
        entity: 'parties',
        path: `orgs/org1/matters/${matterId}/parties/${domain.partyDocId('client', contactId)}`,
        legacyPath: `${CARD}#client-party`,
        data: {
          contactId,
          role: 'client',
          addedFrom: 'migration',
          orgId: 'org1',
          matterId,
          deletedAt: null,
          createdAt: CREATED,
          createdBy: UID,
          updatedAt: UPDATED,
          updatedBy: UID,
          schemaVersion: 1,
          migration: { runId: 'run1', legacyPath: `${CARD}#client-party`, loadedAt: AS_OF },
        },
      });
      expect(party?.path).toBe(`orgs/org1/matters/${matterId}/parties/client-${contactId}`);
      expect(matterData(result)['clientContactIds']).toEqual([contactId]);
      expect(domain.PartySchema.parse(party?.data)).toEqual(party?.data);
      expect(warned(ctx)).toEqual({});
    });

    it('adds the party row for a placeholder client too', () => {
      const result = mapCard(withDefaults({ clientContact: 'placeholder' }), card(), deps());
      const [client, party] = result.records;
      expect(party?.entity).toBe('parties');
      expect(party?.data).toMatchObject({ contactId: docId(client?.path ?? ''), role: 'client' });
      if (party) expectValid(party);
    });

    it('is the one party row per matter, keyed by the card', () => {
      const other = `workflows/${WILLS}/cards/WillsCardAuto0000010`;
      const first = mapCard(makeCtx(), card(), deps()).records[1];
      const second = mapCard(makeCtx(), card({}, other), deps()).records[1];
      expect(first?.path).not.toBe(second?.path);
      expect(second?.legacyPath).toBe(`${other}#client-party`);
      expect(second?.path.startsWith(`orgs/org1/matters/${migId(other)}/parties/client-`)).toBe(true);
    });
  });

  describe('assignee', () => {
    it.each(['', null, undefined, UID, `  ${UID} `])('keeps the user responsible with no note (%j)', (assignee) => {
      const ctx = makeCtx();
      const result = mapCard(ctx, card({ assignee }), deps());
      expect(matterData(result)['responsibleUid']).toBe(UID);
      expect(recordAt(result, `${CARD}#original-assignee`)).toBeUndefined();
      expect(warned(ctx)).toEqual({});
    });

    it("makes the user responsible for someone else's card, with a note naming them", () => {
      const ctx = makeCtx();
      const result = mapCard(ctx, card({ assignee: COLLEAGUE }), deps());
      expect(matterData(result)['responsibleUid']).toBe(UID);
      const note = recordAt(result, `${CARD}#original-assignee`);
      expect(note?.entity).toBe('notes');
      expect(note?.path).toBe(`orgs/org1/matters/${migId(CARD)}/notes/${migId(`${CARD}#original-assignee`)}`);
      expect(note?.data).toMatchObject({
        bodyMd: '**Assignee (imported)**\n\nThis matter was assigned to Jordan Ellis in the legacy app.',
        pinned: false,
        createdAt: CREATED,
        updatedAt: CREATED,
        createdBy: UID,
      });
      expect(warned(ctx)).toEqual({ MIG_W_ASSIGNEE_FOREIGN: [CARD] });
      if (note) expectValid(note);
    });

    it.each([DEPARTED, 'NeverExportedLegacyUid000099'])(
      'names an assignee with no profile (%s) "a former colleague"',
      (assignee) => {
        const note = recordAt(mapCard(makeCtx(), card({ assignee }), deps()), `${CARD}#original-assignee`);
        expect(note?.data?.['bodyMd']).toBe(
          '**Assignee (imported)**\n\nThis matter was assigned to a former colleague in the legacy app.',
        );
      },
    );

    it('reassigns without a note under reassign_silently, still warning', () => {
      const ctx = makeCtx({ profile: { ...profile, foreignAssignees: 'reassign_silently' } });
      const result = mapCard(ctx, card({ assignee: COLLEAGUE }), deps());
      expect(matterData(result)['responsibleUid']).toBe(UID);
      expect(result.records.filter((record) => record.entity === 'notes')).toEqual([]);
      expect(warned(ctx)).toEqual({ MIG_W_ASSIGNEE_FOREIGN: [CARD] });
    });
  });

  describe('referrer', () => {
    it('links the referrer through the referrer map', () => {
      const ctx = makeCtx();
      const data = matterData(mapCard(ctx, card({ referrerId: REFERRER }), deps()));
      expect(data['referrerContactId']).toBe(REFERRER_CONTACT);
      expect(data).not.toHaveProperty('referralSource');
      expect(warned(ctx)).toEqual({});
    });

    it('reports a referrer that is not exported', () => {
      const ctx = makeCtx();
      const data = matterData(mapCard(ctx, card({ referrerId: '7e7e0000-0000-4000-8000-0000000000ff' }), deps()));
      expect(data).not.toHaveProperty('referrerContactId');
      expect(warned(ctx)).toEqual({ MIG_W_REFERRER_MISSING: [CARD] });
    });

    it.each(['', '  ', null, undefined])('reads %j as no referrer', (referrerId) => {
      const ctx = makeCtx();
      expect(matterData(mapCard(ctx, card({ referrerId }), deps()))).not.toHaveProperty('referrerContactId');
      expect(warned(ctx)).toEqual({});
    });
  });

  describe('labels', () => {
    it("adds the board's label to the card's mapped labels, sorted", () => {
      const ctx = makeCtx();
      const data = matterData(mapCard(ctx, card({ labelIds: [LABEL.referral] }), deps()));
      expect(data['labels']).toEqual(['board:Wills & powers', 'referral']);
      expect(warned(ctx)).toEqual({});
    });

    it('drops labels the profile maps to null, ids the board no longer defines (reported) and non-ids', () => {
      const ctx = makeCtx();
      const data = matterData(
        mapCard(
          ctx,
          card({
            labelIds: [LABEL.urgent, 'deadbeef-0000-4000-8000-000000000000', 42, LABEL.referral, LABEL.referral],
          }),
          deps(),
        ),
      );
      expect(data['labels']).toEqual(['board:Wills & powers', 'referral']);
      expect(warned(ctx)).toEqual({ MIG_W_LABEL_UNKNOWN: [CARD] });
    });

    it('reads labelIds that are not a list as none', () => {
      expect(matterData(mapCard(makeCtx(), card({ labelIds: 'Urgent' }), deps()))['labels']).toEqual([
        'board:Wills & powers',
      ]);
    });
  });

  describe('conflict check and costs disclosure', () => {
    it('imports a lead with its conflict check pending and its disclosure required', () => {
      const data = matterData(mapCard(makeCtx(), card({ swimlaneId: LANE.enquiries }), deps()));
      expect(data).toMatchObject({ conflictCheck: { status: 'pending' }, costsDisclosure: { status: 'required' } });
    });

    it('keeps every conflict check pending under the pending policy', () => {
      const ctx = withDefaults({ conflictCheck: 'pending' });
      for (const swimlaneId of [LANE.drafting, LANE.closed]) {
        expect(matterData(mapCard(ctx, card({ swimlaneId }), deps()))['conflictCheck']).toEqual({
          status: 'pending',
        });
      }
    });

    it('requires no disclosure under the not_required policy', () => {
      const ctx = withDefaults({ costsDisclosure: 'not_required' });
      expect(matterData(mapCard(ctx, card(), deps()))['costsDisclosure']).toEqual({ status: 'not_required' });
    });
  });

  describe('description', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const mention = (uid: string, name: string) =>
      `<span class="mention" data-index="0" data-denotation-char="@" data-id="${uid}" data-value="${name}">\uFEFF` +
      `<span contenteditable="false"><span class="ql-mention-denotation-char">@</span>${name}</span>\uFEFF</span>`;

    it('becomes a pinned note, with embedded images moved to documents', () => {
      const ctx = makeCtx();
      const description =
        `<p>Initial call booked. Ask ${mention(COLLEAGUE, 'Jordan Ellis')} and ${mention(UID, 'Alex Rivers')} about the trust.</p>` +
        `<p><img src="data:image/png;base64,${png}"></p>`;
      const result = mapCard(ctx, card({ description }), deps());
      const image = recordAt(result, `${CARD}#description-image/1`);
      expect(image?.entity).toBe('documents');
      expect(image?.data).toMatchObject({ name: 'Description image 1.png', createdBy: UID });
      expect(image?.copy).toMatchObject({ mime: 'image/png', content: { encoding: 'base64', data: png } });
      const note = recordAt(result, `${CARD}#description`);
      expect(note?.data).toMatchObject({
        bodyMd:
          '**Description (imported)**\n\n' +
          `Initial call booked. Ask @Jordan Ellis (imported) and @[${UID}] about the trust.\n` +
          '[Image moved to Documents: Description image 1.png]',
        mentions: { uids: [UID], matterIds: [] },
        pinned: true,
        createdAt: CREATED,
        updatedAt: UPDATED,
        createdBy: UID,
      });
      // The image document comes before the note that names it.
      expect(result.records.map((record) => record.legacyPath)).toEqual([
        `${CARD}#client`,
        `${CARD}#client-party`,
        `${CARD}#description-image/1`,
        `${CARD}#description`,
      ]);
      for (const record of result.records) expectValid(record);
      expect(warned(ctx)).toEqual({ MIG_W_INLINE_IMAGE_EXTRACTED: [CARD] });
    });

    it.each(['', '<p><br></p>', null])('makes no note of an empty description (%j)', (description) => {
      const result = mapCard(makeCtx(), card({ description }), deps());
      expect(recordAt(result, `${CARD}#description`)).toBeUndefined();
    });

    it('records the sanitising warnings against the card', () => {
      const ctx = makeCtx();
      const description =
        '<p>See <a href="https://example.com/brief">the brief</a><img src="https://tracker.example.com/pixel.gif"><script>alert(1)</script></p>';
      const note = recordAt(mapCard(ctx, card({ description }), deps()), `${CARD}#description`);
      expect(note?.data?.['bodyMd']).toBe('**Description (imported)**\n\nSee [the brief](https://example.com/brief)');
      expect(warned(ctx)).toEqual({ MIG_W_HTML_UNSAFE_REMOVED: [CARD], MIG_W_REMOTE_IMAGE_DROPPED: [CARD] });
    });
  });

  describe('fee', () => {
    it('adds the fee notes and review codes, and keeps the raw fee and billing', () => {
      const ctx = makeCtx();
      const fee = { id: 'fee4', billingType: 'folio', value: 0, hasDisbursements: true, disbursements: 150 };
      const billable = { status: 'billed', billingTotal: 2200, billingDate: '2025-03-31', applyTrust: true };
      const result = mapCard(ctx, card({ fee, billable }), deps());
      expect(matterData(result)).toMatchObject({
        fee: { arrangement: 'hourly', history: [] },
        legacy: { fee },
        legacyBilling: {
          status: 'billed',
          billingTotal: 2200,
          billingDate: '2025-03-31',
          applyTrust: true,
          billingTotalCents: 220000,
        },
        needsReview: ['client_from_title', 'fee_disbursements'],
      });
      const folio = recordAt(result, `${CARD}#fee-folio`);
      const disbursements = recordAt(result, `${CARD}#fee-disbursements`);
      expect(folio?.data).toMatchObject({
        bodyMd: expect.stringContaining('billed by folio'),
        createdAt: CREATED,
        updatedAt: CREATED,
        createdBy: UID,
      });
      expect(disbursements?.data?.['bodyMd']).toContain('disbursements of $150.00');
      expect(warned(ctx)).toEqual({ MIG_W_FEE_FOLIO: [CARD], MIG_W_FEE_DISBURSEMENTS: [CARD] });
      expectValid(result.matter);
    });

    it('imports a card with no fee as hourly, for review, with no legacy fee', () => {
      const ctx = makeCtx();
      const data = matterData(mapCard(ctx, card({ fee: null }), deps()));
      expect(data).toMatchObject({
        fee: { arrangement: 'hourly', history: [] },
        needsReview: ['client_from_title', 'fee_type_missing'],
      });
      expect(data).not.toHaveProperty('legacy');
      expect(data).not.toHaveProperty('legacyBilling');
      expect(warned(ctx)).toEqual({ MIG_W_FEE_TYPE_MISSING: [CARD] });
    });
  });

  it('keeps the legacy reference as the external reference, which search finds', () => {
    const data = matterData(mapCard(makeCtx(), card({ matterReference: '  HV-2025-001 ' }), deps()));
    expect(data['externalRef']).toBe('HV-2025-001');
    expect(data['search']).toEqual(
      domain.matterSearchTokens({
        number: NUMBER,
        title: 'Jane Smith - will',
        clientNames: ['Jane Smith'],
        externalRef: 'HV-2025-001',
      }),
    );
    for (const matterReference of ['', null, 42]) {
      expect(matterData(mapCard(makeCtx(), card({ matterReference }), deps()))).not.toHaveProperty('externalRef');
    }
  });

  it.each([
    [0, 'none'],
    [1, 'high'],
    [2, 'medium'],
    [3, 'low'],
  ])('maps priority %s to %s', (priority, expected) => {
    expect(matterData(mapCard(makeCtx(), card({ priority }), deps()))['priority']).toBe(expected);
  });

  it('gives no template for a matter type without a system template', () => {
    const plan: WorkflowPlan = {
      ...wills,
      mapping: { ...wills.mapping, mode: 'matters', matterType: 'retired' as MatterType, swimlanes: [] },
      lanes: new Map(),
    };
    const data = matterData(mapCard(makeCtx(), card(), deps({ plan })));
    expect(data).not.toHaveProperty('templateId');
    expect(data).not.toHaveProperty('templateVersion');
  });

  it('lists linked cards as {workflowId}/{cardId}, the bare-id legacy form on its own board', () => {
    const result = mapCard(
      makeCtx(),
      card({
        linkedCardIds: [
          { cardId: 'WillsCardAuto0000002', workflowId: WILLS },
          { cardId: 'SharedCardAuto000001', workflowId: '0b6f1c2e-5d4a-4c3b-9a8e-444444444444' },
          'WillsCardAuto0000001',
          { cardId: 'WillsCardAuto0000003' },
          { workflowId: WILLS },
          '',
        ],
      }),
      deps(),
    );
    expect(result.links).toEqual([
      `${WILLS}/WillsCardAuto0000002`,
      '0b6f1c2e-5d4a-4c3b-9a8e-444444444444/SharedCardAuto000001',
      `${WILLS}/WillsCardAuto0000001`,
      `${WILLS}/WillsCardAuto0000003`,
    ]);
    // The run resolves them once every matter has its id.
    expect(matterData(result)['relatedMatterIds']).toEqual([]);
  });

  it('brings its comments, checklists, history and attachments, in that order', () => {
    const ctx = makeCtx();
    const attachmentPath = `${CARD}/attachments/a77a0000-0000-4000-8000-000000000001`;
    const object: StorageObject = { name: `${attachmentPath}.pdf`, size: 100, contentType: 'application/pdf' };
    const result = mapCard(
      ctx,
      card({
        comments: [{ id: 'c1', uid: COLLEAGUE, comment: '<p>Called.</p>', date: '2025-01-12T05:00:00.000Z' }],
        checklists: [{ id: 'l1', title: 'Intake', items: [{ id: 'i1', name: 'Send letter', checked: false }] }],
        history: [{ id: 'h1', action: { name: 'Created card' }, uid: UID, date: '2025-01-10T00:30:00.000Z' }],
      }),
      deps({
        attachments: [
          {
            path: attachmentPath,
            data: {
              originalFileName: 'fictional-file.pdf',
              storagePath: object.name,
              mimeType: 'application/pdf',
              sizeBytes: 100,
              uploadedBy: UID,
              uploadedAt: '2025-02-01T00:00:00.000Z',
              createdOn: '2025-02-01T00:00:00.000Z',
            },
          } as ExportRecord,
        ],
        objects: new Map([[object.name, object]]),
      }),
    );
    expect(result.records.map((record) => [record.entity, record.legacyPath])).toEqual([
      ['contacts', `${CARD}#client`],
      ['parties', `${CARD}#client-party`],
      ['notes', `${CARD}#comment/c1`],
      ['tasks', `${CARD}#checklist/l1/item/i1`],
      ['activity', `${CARD}#history/h1`],
      ['documents', attachmentPath],
    ]);
    for (const record of result.records) {
      expect(record.path.startsWith(`orgs/org1/contacts/`) || record.path.startsWith(`${result.matter.path}/`)).toBe(
        true,
      );
      expectValid(record);
    }
    expect(warned(ctx)).toEqual({});
  });

  it('dates a card whose createdOn is not a date from its updatedOn, with a warning', () => {
    const ctx = makeCtx();
    const data = matterData(
      mapCard(ctx, card({ createdOn: 'not a date', updatedOn: { $timestamp: '2025-02-01T00:00:00Z' } }), deps()),
    );
    expect(data).toMatchObject({
      createdAt: new Date('2025-02-01T00:00:00Z'),
      updatedAt: new Date('2025-02-01T00:00:00Z'),
    });
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [CARD] });
  });

  it('maps a card with no data as an untitled matter', () => {
    const ctx = makeCtx();
    const result = mapCard(ctx, { path: CARD, data: null } as ExportRecord, deps());
    expect(matterData(result)).toMatchObject({ title: UNTITLED_MATTER, status: 'open', createdAt: AS_OF });
    expectValid(result.matter);
  });

  it('maps every fixture card on a matters board to valid records', () => {
    const ctx = makeCtx();
    const plans = new Map([
      [WILLS, wills],
      [ESTATES, estates],
    ]);
    const cards = docs.filter((doc) => /^workflows\/[^/]+\/cards\/[^/]+$/.test(doc.path));
    const attachments = docs.filter((doc) => /\/attachments\//.test(doc.path));
    const { objects } = loadLegacyFixtures();
    const byName = new Map(objects.map((object) => [object.name, object]));
    let mapped = 0;
    for (const doc of cards) {
      const plan = plans.get(doc.path.split('/')[1] ?? '');
      if (!plan) continue;
      const result = mapCard(ctx, { path: doc.path, data: doc.data } as ExportRecord, {
        ...deps({ plan, objects: byName }),
        referrers: new Map([
          [REFERRER, REFERRER_CONTACT],
          ['7e7e0000-0000-4000-8000-000000000002', 'referrerContact0002'],
        ]),
        attachments: attachments
          .filter((a) => a.path.startsWith(`${doc.path}/`))
          .map((a) => ({ path: a.path, data: a.data }) as ExportRecord),
      });
      expectValid(result.matter);
      for (const record of result.records) expectValid(record);
      mapped++;
    }
    expect(mapped).toBe(8);
    const summary = ctx.warnings.summary();
    expect(summary.MIG_W_SWIMLANE_UNKNOWN.paths).toEqual([`workflows/${WILLS}/cards/WillsCardAuto0000005`]);
    expect(summary.MIG_W_ASSIGNEE_FOREIGN.paths).toEqual([`workflows/${WILLS}/cards/WillsCardAuto0000002`]);
    expect(summary.MIG_W_REFERRER_MISSING.paths).toEqual([`workflows/${WILLS}/cards/WillsCardAuto0000003`]);
    expect(summary.MIG_W_LABEL_UNKNOWN.paths).toEqual([`workflows/${WILLS}/cards/WillsCardAuto0000001`]);
    expect(summary.MIG_W_ATTACHMENT_OVERSIZE.count).toBe(1);
    expect(summary.MIG_W_ATTACHMENT_OBJECT_MISSING.count).toBe(1);
  });
});
