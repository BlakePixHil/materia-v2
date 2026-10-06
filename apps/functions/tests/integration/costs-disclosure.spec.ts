import { randomUUID } from 'node:crypto';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import type { DisclosureResult, GenerateDisclosureResult, Role, UpdateFeeResult } from '@materia/domain';

import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { createLog } from '../../src/core/log';
import { cachedMemberLookup } from '../../src/core/members';
import {
  generateDisclosureDefinition,
  markDisclosureSentDefinition,
  setDisclosureWaiverDefinition,
} from '../../src/costs/disclosure';
import { disclosureRemindersForOrg } from '../../src/costs/nightly';
import { docxText } from '../../src/docs/testing';
import { storageFiles } from '../../src/documents/files';
import { updateDefinition } from '../../src/fees/update';
import { fakePorts } from '../../src/ports/fakes';

/**
 * BILL-06 against the emulators' Firestore and Storage: a matter's short-form disclosure is
 * generated into its documents and recorded as sent; revising the fee past the band makes it
 * update-required with a task and a notification for the responsible lawyer; the updated (full)
 * disclosure quotes the earlier estimate and, once sent, completes the task. A lawyer records that
 * none is needed; the nightly run reminds about one left unsent for 7 days, once. The callables'
 * own pipelines run in this process, so the Functions emulator starts no workers. Fictional only.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = `${PROJECT_ID}.appspot.com`;
const ORG = 'org-costs-disclosure';
const MATTER_ID = 'm-cd';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;

let admin: App;
let db: Firestore;

const uidOf = (role: Role) => `bill6-${role}`;
const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};

function call<T>(definition: unknown, role: Role, data: Record<string, unknown>): Promise<T> {
  const clock = { now: () => new Date() };
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts(),
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  return runCallable(
    definition as CallableDefinition<never, T>,
    {
      data: { requestId: randomUUID(), matterId: MATTER_ID, ...data },
      auth: { uid: uidOf(role), token: { orgId: ORG, role } },
    },
    deps,
  );
}
const files = () => storageFiles(BUCKET);
const generate = () => call<GenerateDisclosureResult>(generateDisclosureDefinition(files), 'lawyer', {});
const markSent = (sentOn: string) =>
  call<DisclosureResult>(markDisclosureSentDefinition, 'lawyer', { sentOn, method: 'email' });
const reviseFee = (amountCents: number) =>
  call<UpdateFeeResult>(updateDefinition, 'lawyer', {
    fee: { arrangement: 'fixed', amountCents },
    reason: 'The application is contested',
  });
const data = async (path: string) => (await db.doc(path).get()).data() ?? {};
const disclosure = async (path = MATTER) => (await data(path))['costsDisclosure'] as Record<string, unknown>;
const melbourneToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const daysBefore = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const matter = (number: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Estate of Fictional Wren ${number}`,
  type: 'probate',
  jurisdiction: 'VIC',
  status: 'open',
  privileged: false,
  clientContactIds: ['c-wren'],
  responsibleUid: uidOf('lawyer'),
  fee: { arrangement: 'fixed', amountCents: 200_000, revision: 0, history: [] },
  costsDisclosure: {
    status: 'required',
    requirement: 'short_form',
    bandId: 'standard-form',
    rulesVersion: 'vic-v1',
    basisEstimateCents: 200_000,
    requiredSince: melbourneToday(),
    history: [],
  },
  wipCents: 0,
  deletedAt: null,
  ...meta,
  ...extra,
});

beforeAll(async () => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'costs-disclosure-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Harbour & Vine Legal',
    abn: '00000000001',
    timezone: 'Australia/Melbourne',
    billing: { disclosureChangePct: 10 },
    flags: { 'billing.costsDisclosure': true, 'billing.feeBudgets': true },
  });
  for (const [role, displayName] of [
    ['lawyer', 'Jordan Price'],
    ['paralegal', 'Daniel Kim'],
  ] as const) {
    await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({
      role,
      status: 'active',
      displayName,
      email: `${uidOf(role)}@example.test`,
      defaultRateCents: 45_000,
      rates: [],
    });
  }
  await db.doc(`orgs/${ORG}/contacts/c-wren`).set({
    kind: 'person',
    givenNames: 'Avery',
    familyName: 'Wren',
    emails: [],
    phones: [],
    addresses: [],
    deletedAt: null,
    ...meta,
  });
  await db.doc(MATTER).set(matter('M-2026-0601'));
});

afterAll(async () => {
  clearFlagCaches();
  await deleteAdminApp(admin);
});

describe('costs disclosure (BILL-06)', () => {
  it('generates the short form, records it sent, needs an update after a big rise, and sends the update', async () => {
    const first = await generate();
    expect(first.templateId).toBe('system-costs-disclosure-short');
    expect(await data(`${MATTER}/documents/${first.documentId}`)).toMatchObject({
      category: 'correspondence',
      tags: ['costs-disclosure'],
    });
    const file = await files().read(`${MATTER}/documents/${first.documentId}/v1`);
    expect(docxText(file as Buffer)).toContain('Costs disclosure (short form)');
    expect(await disclosure()).toMatchObject({ documentId: first.documentId });

    expect(await markSent(melbourneToday())).toEqual({ matterId: MATTER_ID, status: 'sent' });
    expect(await disclosure()).toMatchObject({
      status: 'sent',
      sentEstimateCents: 200_000,
      sentBandId: 'standard-form',
    });

    // $2,000 to $4,000: a new band and a 100% rise.
    await reviseFee(400_000);
    const due = await disclosure();
    expect(due).toMatchObject({ status: 'update_required', requirement: 'full', updateReasons: ['band', 'increase'] });
    const taskId = String(due['taskId']);
    expect(await data(`${MATTER}/tasks/${taskId}`)).toMatchObject({
      title: 'Send an updated costs disclosure',
      status: 'todo',
      assigneeUid: uidOf('lawyer'),
    });
    const notes = await db
      .collection(`orgs/${ORG}/notifications`)
      .where('matterId', '==', MATTER_ID)
      .where('kind', '==', 'costs_disclosure')
      .get();
    expect(notes.docs.map((d) => d.data()['recipientUid'])).toEqual([uidOf('lawyer')]);

    const second = await generate();
    expect(second.templateId).toBe('system-costs-disclosure');
    expect(second.name).toMatch(/^Updated costs disclosure /);
    const updated = await files().read(`${MATTER}/documents/${second.documentId}/v1`);
    expect(docxText(updated as Buffer)).toContain('We previously estimated your total legal costs at $2,000.00.');

    expect(await markSent(melbourneToday())).toEqual({ matterId: MATTER_ID, status: 'updated' });
    expect(await data(`${MATTER}/tasks/${taskId}`)).toMatchObject({ status: 'done' });
    const sent = await disclosure();
    expect(sent).toMatchObject({ status: 'updated', sentEstimateCents: 400_000, sentBandId: 'full' });
    expect(sent).not.toHaveProperty('taskId');
    expect((sent['history'] as { action: string }[]).map((e) => e.action)).toEqual([
      'generated',
      'sent',
      'update_required',
      'generated',
      'sent',
    ]);
    const audits = await db.collection(`orgs/${ORG}/audit`).where('entity.path', '==', MATTER).get();
    expect(audits.docs.map((d) => d.data()['action'])).toEqual(
      expect.arrayContaining([
        'matter.disclosure_generated',
        'matter.disclosure_sent',
        'matter.disclosure_update_required',
      ]),
    );
  });

  it('lets a lawyer, not a paralegal, record that none is needed', async () => {
    const path = `orgs/${ORG}/matters/m-waive`;
    await db.doc(path).set(matter('M-2026-0602'));
    const waive = (role: Role) =>
      call<DisclosureResult>(setDisclosureWaiverDefinition, role, {
        matterId: 'm-waive',
        waiver: { reason: 'commercial_or_government' },
      });
    await expect(waive('paralegal')).rejects.toMatchObject({ code: 'permission-denied' });
    expect(await waive('lawyer')).toEqual({ matterId: 'm-waive', status: 'waived' });
    expect(await disclosure(path)).toMatchObject({ status: 'waived', waiver: { reason: 'commercial_or_government' } });
  });

  it('reminds once about a disclosure left unsent for 7 days', async () => {
    const since = daysBefore(melbourneToday(), 8);
    const path = `orgs/${ORG}/matters/m-late`;
    await db.doc(path).set(
      matter('M-2026-0603', {
        costsDisclosure: { ...matter('x').costsDisclosure, requiredSince: since },
      }),
    );
    const log = createLog({ fn: 'test' }, () => undefined);
    const clock = { now: () => new Date() };
    const first = await disclosureRemindersForOrg(db, ORG, clock, log, fakePorts());
    expect(first?.reminded).toContain('m-late');
    expect(await data(`${path}/tasks/costs-disclosure-due-${since}`)).toMatchObject({
      title: 'Send the costs disclosure',
      status: 'todo',
    });
    const again = await disclosureRemindersForOrg(db, ORG, clock, log, fakePorts());
    expect(again?.reminded).not.toContain('m-late');
  });
});
