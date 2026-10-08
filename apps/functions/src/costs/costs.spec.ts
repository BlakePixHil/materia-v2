import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import type { Role } from '@materia/domain';

import {
  generateDisclosureDefinition,
  markDisclosureSentDefinition,
  setDisclosureWaiverDefinition,
} from './disclosure';
import { disclosureRemindersAllOrgs, disclosureRemindersForOrg } from './nightly';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import { systemTemplateDocx } from '../docs/system-templates';
import { docxText, doyleSources } from '../docs/testing';
import { MemoryFiles } from '../documents/testing';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeTaskQueue, fakePorts } from '../ports/fakes';

/** Unit tests for the costs disclosure functions (BILL-06). Every firm, person, matter and amount is fictional. */

const ORG = 'org-a';
const MATTERS = `orgs/${ORG}/matters`;
const M1 = `${MATTERS}/m1`;
const at = new Date('2026-09-01T00:00:00.000Z');
const meta = { createdAt: at, createdBy: 'user-owner', updatedAt: at, updatedBy: 'user-owner', schemaVersion: 1 };
const FLAG = { 'billing.costsDisclosure': true };

type Data = Record<string, unknown>;

const sources = doyleSources();

const required = (extra: Data = {}) => ({
  status: 'required',
  requirement: 'full',
  bandId: 'full',
  rulesVersion: 'vic-v1',
  basisEstimateCents: 440_000,
  requiredSince: '2026-09-28',
  history: [],
  ...extra,
});

const matter = (extra: Data = {}) => ({
  ...meta,
  createdAt: new Date('2026-07-20T01:00:00.000Z'),
  number: 'HV-2026-0001',
  title: 'Estate of Margaret Doyle',
  type: 'probate',
  jurisdiction: 'VIC',
  status: 'open',
  privileged: false,
  responsibleUid: 'user-lawyer',
  clientContactIds: ['c-catherine-doyle'],
  deceased: { contactId: 'c-margaret-doyle', dateOfDeath: '2026-07-17', domicile: 'VIC' },
  fee: { arrangement: 'fixed', amountCents: 440_000, revision: 0, history: [] },
  costsDisclosure: required(),
  deletedAt: null,
  ...extra,
});

function world(initial: Record<string, Data> = {}, flags: Data = FLAG) {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  const contacts = Object.fromEntries(
    Object.entries(sources.contacts).map(([id, contact]) => [
      `orgs/${ORG}/contacts/${id}`,
      { ...meta, ...contact, deletedAt: null },
    ]),
  );
  const member = (role: Role, displayName: string, extra: Data = {}) => ({
    ...meta,
    role,
    status: 'active',
    displayName,
    ...extra,
  });
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      ...meta,
      name: 'Harbour & Vine Legal',
      abn: '00000000001',
      timezone: 'Australia/Melbourne',
      flags,
    },
    [`orgs/${ORG}/settings/letterhead`]: { ...meta, ...sources.letterhead },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer', 'Jordan Price', {
      title: 'Senior Associate',
      email: 'lawyer@harbourvine.example',
      defaultRateCents: 45_000,
    }),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal', 'Daniel Kim'),
    [`orgs/${ORG}/members/user-owner`]: member('owner', 'Alex Morgan'),
    [M1]: matter(),
    ...contacts,
    ...initial,
  });
  const files = new MemoryFiles('demo-materia.appspot.com');
  // 10:00 on 6 October 2026 in Melbourne.
  const clock = new FakeClock(new Date('2026-10-05T23:00:00.000Z'));
  const tasks = new FakeTaskQueue();
  const ports = fakePorts({ tasks });
  const log = createLog({ fn: 'test' }, () => undefined);
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = <T>(def: unknown, data: Data, role: Role = 'lawyer') =>
    runCallable(
      def as CallableDefinition<never, T>,
      {
        data: { requestId: randomUUID(), matterId: 'm1', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(),
    );
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const disclosure = (path = M1) => doc(path)?.['costsDisclosure'] as Data;
  const under = (prefix: string) =>
    [...store.docs.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, data]): Data => ({ path, ...(data as Data) }));
  const audits = () => under(`orgs/${ORG}/audit/`);
  const notifications = () => under(`orgs/${ORG}/notifications/`);
  return { ...store, files, clock, tasks, ports, log, call, doc, disclosure, under, audits, notifications };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

interface Generated {
  documentId: string;
  name: string;
  templateId: string;
  missing: string[];
}

describe('costs-generateDisclosure', () => {
  let files: MemoryFiles;
  const def = generateDisclosureDefinition(() => files);
  const setup = (initial: Record<string, Data> = {}, flags: Data = FLAG) => {
    const w = world(initial, flags);
    files = w.files;
    return w;
  };
  const text = async (w: ReturnType<typeof world>, documentId: string) =>
    docxText((await w.files.read(`${M1}/documents/${documentId}/v1`)) as Buffer);

  it('merges the full disclosure for the band, files it under correspondence and keeps its id', async () => {
    const w = setup();
    const result = await w.call<Generated>(def, {});
    expect(result).toMatchObject({
      matterId: 'm1',
      name: 'Costs disclosure 6 October 2026.docx',
      templateId: 'system-costs-disclosure',
    });
    expect(w.doc(`${M1}/documents/${result.documentId}`)).toMatchObject({
      category: 'correspondence',
      tags: ['costs-disclosure'],
      source: 'generated',
      generatedFrom: { templateId: 'system-costs-disclosure' },
    });
    expect(w.disclosure()).toMatchObject({
      status: 'required',
      documentId: result.documentId,
      history: [
        {
          by: 'user-lawyer',
          action: 'generated',
          status: 'required',
          requirement: 'full',
          documentId: result.documentId,
        },
      ],
    });
    expect(w.audits()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'matter.disclosure_generated',
          data: expect.objectContaining({ updated: false }),
        }),
      ]),
    );
    const merged = await text(w, result.documentId);
    expect(merged).toContain('Catherine Doyle');
    expect(merged).toContain('Add your firm’s statement of the client’s rights');
    expect(merged).not.toContain('Illustrative');
    expect(merged).not.toContain('Updated costs disclosure');
    expect(merged).toMatchSnapshot();
  });

  it('uses the short form below $3,000', async () => {
    const w = setup({
      [M1]: matter({
        fee: { arrangement: 'fixed', amountCents: 200_000, history: [] },
        costsDisclosure: required({ requirement: 'short_form', bandId: 'standard-form', basisEstimateCents: 200_000 }),
      }),
    });
    const result = await w.call<Generated>(def, {});
    expect(result.templateId).toBe('system-costs-disclosure-short');
    const merged = await text(w, result.documentId);
    expect(merged).toContain('Costs disclosure (short form)');
    expect(merged).toContain('$2,000.00');
    expect(merged).toMatchSnapshot();
  });

  it('after one was given, generates an updated disclosure quoting the earlier estimate', async () => {
    const w = setup({
      [M1]: matter({
        fee: { arrangement: 'fixed', amountCents: 520_000, history: [] },
        costsDisclosure: required({
          status: 'update_required',
          basisEstimateCents: 520_000,
          sentOn: '2026-08-01',
          sentEstimateCents: 440_000,
          updateReasons: ['increase'],
          requiredSince: '2026-10-01',
        }),
      }),
    });
    const result = await w.call<Generated>(def, {});
    expect(result.name).toBe('Updated costs disclosure 6 October 2026.docx');
    const merged = await text(w, result.documentId);
    expect(merged).toContain('This updates the costs disclosure we gave you earlier.');
    expect(merged).toContain('We previously estimated your total legal costs at $4,400.00.');
  });

  it('uses the firm’s own published template where it replaces the built-in one', async () => {
    const own = systemTemplateDocx('system-costs-disclosure').data;
    const template = {
      ...meta,
      name: 'Our costs disclosure',
      kind: 'costs_disclosure',
      matterTypes: [],
      replaces: 'system-costs-disclosure',
      storagePath: `orgs/${ORG}/docTemplates/dt-own/v1.docx`,
      fields: [],
      version: 1,
      versions: [
        {
          version: 1,
          storagePath: `orgs/${ORG}/docTemplates/dt-own/v1.docx`,
          fileName: 'Our costs disclosure.docx',
          sizeBytes: own.length,
          sha256: '1'.repeat(64),
          fields: [],
          warnings: [],
          uploadedAt: at,
          uploadedBy: 'user-owner',
        },
      ],
      published: true,
      publishedVersion: 1,
      deletedAt: null,
    };
    const w = setup({
      [`orgs/${ORG}/docTemplates/dt-own`]: template,
      // Not published, deleted, or for another type: never used.
      [`orgs/${ORG}/docTemplates/dt-draft`]: { ...template, published: false },
      [`orgs/${ORG}/docTemplates/dt-gone`]: { ...template, deletedAt: at },
      [`orgs/${ORG}/docTemplates/dt-will`]: { ...template, matterTypes: ['will'] },
    });
    w.files.put(`orgs/${ORG}/docTemplates/dt-own/v1.docx`, own);
    for (const id of ['dt-draft', 'dt-gone', 'dt-will']) w.files.put(`orgs/${ORG}/docTemplates/${id}/v1.docx`, own);
    expect((await w.call<Generated>(def, {})).templateId).toBe('dt-own');
  });

  it('is for billing roles, behind the flag, on live matters', async () => {
    const w = setup();
    expect(await failure(w.call(def, {}, 'paralegal'))).toMatchObject({ code: 'permission-denied' });
    expect(await failure(w.call(def, { matterId: 'nope' }))).toMatchObject({ code: 'not-found' });
    w.docs.set(M1, matter({ status: 'archived' }));
    expect(await failure(w.call(def, {}))).toMatchObject({ details: { reason: 'matter_archived' } });
    const off = setup({}, {});
    expect(await failure(off.call(def, {}))).toMatchObject({ details: { code: 'FEATURE_DISABLED' } });
  });
});

describe('costs-markDisclosureSent', () => {
  const def = markDisclosureSentDefinition;
  const TASK = `${M1}/tasks/costs-disclosure-due-2026-09-28`;
  const openTask = { ...meta, title: 'Send the costs disclosure', status: 'todo', source: 'rule', deletedAt: null };

  it('records it as sent, keeps what was disclosed, stops the reminders and completes the task', async () => {
    const w = world({
      [M1]: matter({
        costsDisclosure: required({
          documentId: 'd-disclosure',
          taskId: 'costs-disclosure-due-2026-09-28',
          remindedOn: '2026-10-05',
        }),
      }),
      [TASK]: openTask,
    });
    expect(await w.call(def, { sentOn: '2026-10-06', method: 'email' })).toEqual({ matterId: 'm1', status: 'sent' });
    const d = w.disclosure();
    expect(d).toMatchObject({
      status: 'sent',
      sentOn: '2026-10-06',
      sentMethod: 'email',
      sentEstimateCents: 440_000,
      sentBandId: 'full',
      documentId: 'd-disclosure',
      history: [{ action: 'sent', status: 'sent', note: 'email on 2026-10-06' }],
    });
    for (const key of ['requiredSince', 'remindedOn', 'taskId', 'updateReasons']) expect(d).not.toHaveProperty(key);
    expect(w.doc(TASK)).toMatchObject({ status: 'done', updatedBy: 'user-lawyer' });
    expect(w.audits()).toEqual([
      expect.objectContaining({
        action: 'matter.disclosure_sent',
        data: expect.objectContaining({ taskCompleted: true }),
      }),
    ]);
  });

  it('records an updated disclosure after one was given', async () => {
    const w = world({
      [M1]: matter({
        costsDisclosure: required({ status: 'update_required', sentOn: '2026-08-01', sentEstimateCents: 300_000 }),
      }),
    });
    expect(await w.call(def, { sentOn: '2026-10-06', method: 'post' })).toMatchObject({ status: 'updated' });
    expect(w.disclosure()).toMatchObject({ status: 'updated', sentOn: '2026-10-06', sentEstimateCents: 440_000 });
  });

  it('refuses a date after today, a waived disclosure and a document not on the matter', async () => {
    const w = world();
    expect(await failure(w.call(def, { sentOn: '2026-10-07', method: 'email' }))).toMatchObject({
      code: 'invalid-argument',
      details: { fields: { sentOn: ['The date it was sent can’t be after today'] } },
    });
    expect(await failure(w.call(def, { sentOn: '2026-10-06', method: 'email', documentId: 'd-nope' }))).toMatchObject({
      details: { fields: { documentId: ['That document isn’t on this matter'] } },
    });
    w.docs.set(M1, matter({ costsDisclosure: { status: 'waived', history: [] } }));
    expect(await failure(w.call(def, { sentOn: '2026-10-06', method: 'email' }))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'disclosure_waived' },
    });
    expect(await failure(w.call(def, { sentOn: '2026-10-06', method: 'email' }, 'paralegal'))).toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('costs-setDisclosureWaiver', () => {
  const def = setDisclosureWaiverDefinition;

  it('records that none is needed with the reason, completing the task; removing it assesses again', async () => {
    const TASK = `${M1}/tasks/costs-disclosure-due-2026-09-28`;
    const w = world({
      [M1]: matter({ costsDisclosure: required({ taskId: 'costs-disclosure-due-2026-09-28' }) }),
      [TASK]: { ...meta, title: 'Send the costs disclosure', status: 'todo', deletedAt: null },
    });
    expect(
      await w.call(def, { waiver: { reason: 'other', note: 'Instructed under the firm’s retainer with the bank' } }),
    ).toEqual({ matterId: 'm1', status: 'waived' });
    expect(w.disclosure()).toMatchObject({
      status: 'waived',
      waiver: { reason: 'other', note: 'Instructed under the firm’s retainer with the bank', by: 'user-lawyer' },
    });
    expect(w.disclosure()).not.toHaveProperty('requiredSince');
    expect(w.doc(TASK)).toMatchObject({ status: 'done' });
    // The same waiver again changes nothing.
    await w.call(def, { waiver: { reason: 'other', note: 'Instructed under the firm’s retainer with the bank' } });
    expect(w.audits().map((a) => a['action'])).toEqual(['matter.disclosure_waived']);

    expect(await w.call(def, { waiver: null })).toEqual({ matterId: 'm1', status: 'required' });
    expect(w.disclosure()).toMatchObject({ status: 'required', requiredSince: '2026-10-06', requirement: 'full' });
    expect(w.disclosure()).not.toHaveProperty('waiver');
    expect(w.audits().map((a) => a['action'])).toEqual([
      'matter.disclosure_waived',
      'matter.disclosure_waiver_removed',
    ]);
    expect((w.disclosure()['history'] as Data[]).map((e) => e['action'])).toEqual(['waived', 'waiver_removed']);
  });

  it('is for lawyers and above, and "other" needs a note', async () => {
    const w = world();
    expect(await failure(w.call(def, { waiver: { reason: 'sophisticated_client' } }, 'paralegal'))).toMatchObject({
      code: 'permission-denied',
    });
    expect(await failure(w.call(def, { waiver: { reason: 'other' } }))).toMatchObject({ code: 'invalid-argument' });
  });
});

describe('costs-disclosureNightly', () => {
  const run = (w: ReturnType<typeof world>) => disclosureRemindersForOrg(w.db, ORG, w.clock, w.log, w.ports);

  it('reminds the responsible lawyer once a disclosure has gone 7 days unsent', async () => {
    const w = world({
      [`${MATTERS}/m-new`]: matter({
        number: 'HV-2026-0002',
        costsDisclosure: required({ requiredSince: '2026-09-30' }),
      }),
      [`${MATTERS}/m-closed`]: matter({ number: 'HV-2026-0003', status: 'closed' }),
      [`${MATTERS}/m-gone`]: matter({ number: 'HV-2026-0004', deletedAt: at }),
      [`${MATTERS}/m-sent`]: matter({ number: 'HV-2026-0005', costsDisclosure: required({ status: 'sent' }) }),
      // From before BILL-06: no requiredSince, so it counts from the day the matter opened.
      [`${MATTERS}/m-old`]: matter({ number: 'HV-2026-0006', costsDisclosure: { status: 'required' } }),
    });
    expect((await run(w))?.reminded.sort()).toEqual(['m-old', 'm1']);
    expect(w.doc(`${M1}/tasks/costs-disclosure-due-2026-09-28`)).toMatchObject({
      title: 'Send the costs disclosure',
      status: 'todo',
      priority: 'high',
      assigneeUid: 'user-lawyer',
      dueDate: '2026-10-06',
      source: 'rule',
      group: 'Costs disclosure',
      createdBy: 'system',
    });
    expect(w.disclosure()).toMatchObject({
      remindedOn: '2026-10-06',
      taskId: 'costs-disclosure-due-2026-09-28',
      history: [{ by: 'system', action: 'reminded' }],
    });
    expect(w.disclosure(`${MATTERS}/m-old`)).toMatchObject({
      requiredSince: '2026-07-20',
      taskId: 'costs-disclosure-due-2026-07-20',
    });
    const sent = w.notifications().filter((n) => n['matterId'] === 'm1');
    expect(sent).toEqual([
      expect.objectContaining({
        kind: 'costs_disclosure',
        recipientUid: 'user-lawyer',
        title: 'Costs disclosure not yet sent: HV-2026-0001',
        link: '/matters/m1/overview',
      }),
    ]);
    expect(String(sent[0]?.['body'])).not.toContain('Doyle');

    // The next night: nothing new.
    expect((await run(w))?.reminded).toEqual([]);
    expect(w.notifications().filter((n) => n['matterId'] === 'm1')).toHaveLength(1);
  });

  it('does nothing while the flag is off, and goes through every org', async () => {
    const off = world({}, {});
    expect(await run(off)).toBeNull();
    expect(off.disclosure()).not.toHaveProperty('remindedOn');
    const on = world();
    expect(await disclosureRemindersAllOrgs(on.db, on.clock, on.log, on.ports)).toBe(1);
  });
});
