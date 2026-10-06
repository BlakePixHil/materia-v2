import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  SUGGESTION_CALLABLES,
  type AcceptManySuggestionsResult,
  type AcceptSuggestionResult,
  type Role,
} from '@materia/domain';

import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { createLog } from '../../src/core/log';
import { systemClock } from '../../src/ports/container';
import { proposeSuggestions, type ProposeOptions } from '../../src/suggestions/propose';

/**
 * AI-07 through the emulators: Clerk suggestions proposed server-side (`proposeSuggestions`, as a
 * Clerk feature would), then accepted, edited, dismissed and bulk accepted through the deployed
 * `suggestions-*` callables with real claims. One test per kind with a handler (each through its
 * domain logic: the triggers, recompute and audit run for real), the kinds without one refused,
 * stale detection, dedupe across runs, the audit's human actor with `via: 'clerk'`, two people
 * accepting at once, a closed matter, permissions and privilege. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-suggest';
const PASSWORD = 'fictional-password-ai07';
const MATTER_ID = 'm-suggest';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const CLOSED_ID = 'm-suggest-closed';

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let second: FirebaseApp;
let secondAuth: Auth;

const uidOf = (role: Role) => `sg-${role}`;
const OPTIONS: ProposeOptions = {
  privileged: false,
  promptId: 'suggest-matter',
  promptVersion: '1.0.0',
  model: 'claude-sonnet-5-5',
};

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active', displayName: `Fictional ${role}` });
}

async function signInAs(role: Role, which: Auth = auth) {
  await signOut(which);
  await signInWithEmailAndPassword(which, `${uidOf(role)}@example.test`, PASSWORD);
}

function call<T>(name: string, data: Record<string, unknown>, app: FirebaseApp = client) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(app, 'australia-southeast1'),
    name,
  )({ requestId: randomUUID(), matterId: MATTER_ID, ...data }).then((result) => result.data);
}
const accept = (data: Record<string, unknown>, app?: FirebaseApp) =>
  call<AcceptSuggestionResult>(SUGGESTION_CALLABLES.accept, data, app);

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const detailsOf = (error: FunctionsError) => (error.details ?? {}) as Record<string, unknown>;
const data = async (path: string) => (await db.doc(path).get()).data() ?? {};

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const log = createLog({ fn: 'suggestions-integration' }, () => undefined);
async function propose(proposals: unknown[], options: Partial<ProposeOptions> = {}, matterId = MATTER_ID) {
  return proposeSuggestions({ db, orgId: ORG, clock: systemClock, log }, matterId, proposals, {
    ...OPTIONS,
    ...options,
  });
}
/** Proposes one suggestion and returns its id. */
async function proposeOne(proposal: unknown, options: Partial<ProposeOptions> = {}, matterId = MATTER_ID) {
  const result = await propose([proposal], options, matterId);
  const id = result.created[0]?.id;
  if (!id) throw new Error(`not proposed: ${JSON.stringify(result.skipped)}`);
  return id;
}
const suggestionDoc = (id: string, matterId = MATTER_ID) => data(`orgs/${ORG}/matters/${matterId}/suggestions/${id}`);

const stamp = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const matterDoc = (number: string, status: string) => ({
  ...stamp,
  number,
  title: 'Estate of Fictional Thornbury',
  type: 'probate',
  status,
  jurisdiction: 'VIC',
  responsibleUid: uidOf('lawyer'),
  teamUids: [],
  clientContactIds: ['c-sg-client'],
  privileged: false,
  openTaskCount: 0,
  deletedAt: null,
  estate: { grantNo: 'G-0001' },
  conflictCheck: { status: 'clear' },
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
});
const contact = (firstName: string) => ({
  ...stamp,
  kind: 'person',
  firstName,
  lastName: 'Fictional',
  deletedAt: null,
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
});

const task = (title: string, dueDate = '2026-12-01') => ({
  kind: 'task',
  payload: { title, dueDate, priority: 'medium' },
  citations: [{ documentId: 'd-sg-1', page: 1, quote: 'Valuation to follow' }],
  rationale: 'The will mentions real property',
});

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'suggestions-integration-admin');
  db = getAdminFirestore(admin);
  setRemoteFlagLoader(async () => ({}));
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('sg-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Suggest Practice',
    timezone: 'Australia/Melbourne',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000 },
    flags: { 'clerk.features.suggestions': true },
  });
  clearFlagCaches();
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role);
  await db.doc(`orgs/${ORG}/contacts/c-sg-client`).set(contact('Ada'));
  await db.doc(`orgs/${ORG}/contacts/c-sg-witness`).set(contact('Ben'));
  await db.doc(MATTER).set(matterDoc('SG-2026-0001', 'open'));
  await db.doc(`orgs/${ORG}/matters/${CLOSED_ID}`).set(matterDoc('SG-2026-0002', 'closed'));
  await db.doc(`${MATTER}/parties/client-c-sg-client`).set({
    ...stamp,
    contactId: 'c-sg-client',
    role: 'client',
    addedFrom: 'manual',
    orgId: ORG,
    matterId: MATTER_ID,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  for (const [id, privileged] of [
    ['d-sg-1', false],
    ['d-sg-2', false],
  ] as const) {
    await db.doc(`${MATTER}/documents/${id}`).set({
      ...stamp,
      orgId: ORG,
      matterId: MATTER_ID,
      name: `Scan ${id}`,
      category: 'other',
      privileged,
      tags: [],
      version: 1,
      versions: [],
      scan: { status: 'clean' },
      ingest: { status: 'done' },
      source: 'upload',
      encrypted: false,
      accessRestricted: false,
      search: [],
      deletedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'suggestions-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
  second = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'suggestions-integration-second');
  secondAuth = getAuth(second);
  connectAuthEmulator(secondAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(second, 'australia-southeast1'), '127.0.0.1', 5001);
  await signInAs('lawyer');
});

afterAll(async () => {
  setRemoteFlagLoader();
  await signOut(auth);
  await signOut(secondAuth);
  await deleteApp(client);
  await deleteApp(second);
  await deleteAdminApp(admin);
});

describe('accepting each kind with a handler', () => {
  it('task: creates the task (counted by tasks-onWrite), resolves the suggestion, audits the person via clerk', async () => {
    const id = await proposeOne(task('Request date-of-death valuation'));
    const result = await accept({ suggestionId: id });
    expect(result).toMatchObject({ suggestionId: id, status: 'accepted' });
    expect(result.resultRef).toMatch(new RegExp(`^${MATTER}/tasks/`));
    expect(await data(result.resultRef)).toMatchObject({
      title: 'Request date-of-death valuation',
      dueDate: '2026-12-01',
      status: 'todo',
      source: 'clerk',
      createdBy: uidOf('lawyer'),
    });
    expect(await suggestionDoc(id)).toMatchObject({
      status: 'accepted',
      resolvedBy: uidOf('lawyer'),
      resultRef: result.resultRef,
    });
    const matter = await poll(
      () => data(MATTER),
      (m) => (m['openTaskCount'] as number) >= 1,
    );
    expect(matter['openTaskCount']).toBeGreaterThanOrEqual(1);

    const audits = await db
      .collection(`orgs/${ORG}/audit`)
      .where('action', '==', 'suggestion.accepted')
      .where('entity.id', '==', id)
      .get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0]?.data()).toMatchObject({
      actor: { uid: uidOf('lawyer') },
      source: 'callable',
      data: { via: 'clerk', kind: 'task', suggestionId: id, resultRef: result.resultRef, status: 'accepted' },
    });
  });

  it('deadline: a manual deadline through the domain schema', async () => {
    const id = await proposeOne({
      kind: 'deadline',
      payload: { title: 'Send the estate account to beneficiaries', dueDate: '2026-12-15' },
    });
    const result = await accept({ suggestionId: id });
    expect(result.resultRef).toMatch(new RegExp(`^${MATTER}/deadlines/`));
    expect(await data(result.resultRef)).toMatchObject({
      title: 'Send the estate account to beneficiaries',
      kind: 'internal',
      status: 'upcoming',
      assigneeUid: uidOf('lawyer'),
    });
  });

  it('event: recorded through deadlines-upsertEvent’s logic, which recomputes', async () => {
    const before = (await data(MATTER))['recomputeVersion'] ?? 0;
    const id = await proposeOne({
      kind: 'event',
      payload: { kind: 'will_located', date: '2026-08-01', label: 'Original will in safe custody' },
    });
    const result = await accept({ suggestionId: id });
    expect(result.resultRef).toMatch(new RegExp(`^${MATTER}/events/`));
    expect(await data(result.resultRef)).toMatchObject({ kind: 'will_located', date: '2026-08-01' });
    expect((await data(MATTER))['recomputeVersion']).toBe((before as number) + 1);
    const recorded = await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'matter.event_recorded').get();
    expect(recorded.docs.some((doc) => doc.get('actor.uid') === uidOf('lawyer'))).toBe(true);
  });

  it('key_fact: a plain fact patches the matter; the grant date goes through its event', async () => {
    const plain = await proposeOne({ kind: 'key_fact', payload: { field: 'grantNo', value: 'G-2026-0042' } });
    expect((await accept({ suggestionId: plain })).resultRef).toBe(MATTER);
    expect(((await data(MATTER))['estate'] as Record<string, unknown>)['grantNo']).toBe('G-2026-0042');

    const dated = await proposeOne({ kind: 'key_fact', payload: { field: 'grantDate', value: '2026-09-01' } });
    const result = await accept({ suggestionId: dated });
    expect(result.resultRef).toMatch(new RegExp(`^${MATTER}/events/`));
    expect(await data(result.resultRef)).toMatchObject({ kind: 'grant_issued', date: '2026-09-01' });
    expect(((await data(MATTER))['estate'] as Record<string, unknown>)['grantDate']).toBe('2026-09-01');
  });

  it('note: created through notes-create’s logic, source clerk, privileged with the suggestion', async () => {
    const id = await proposeOne({ kind: 'note', payload: { bodyMd: 'Executor confirmed the bank account details.' } });
    const result = await accept({ suggestionId: id });
    expect(await data(result.resultRef)).toMatchObject({
      bodyMd: 'Executor confirmed the bank account details.',
      source: 'clerk',
      privileged: false,
      createdBy: uidOf('lawyer'),
    });
    const privileged = await proposeOne(
      { kind: 'note', payload: { bodyMd: 'Summary of counsel’s advice.' } },
      { privileged: true },
    );
    expect(await suggestionDoc(privileged)).toMatchObject({ privileged: true });
    const noted = await accept({ suggestionId: privileged });
    expect((await data(noted.resultRef))['privileged']).toBe(true);
  });

  it('party: added through matters-upsertParty’s logic', async () => {
    const id = await proposeOne({ kind: 'party', payload: { contactId: 'c-sg-witness', role: 'witness' } });
    const result = await accept({ suggestionId: id });
    expect(result.resultRef).toBe(`${MATTER}/parties/witness-c-sg-witness`);
    expect(await data(result.resultRef)).toMatchObject({ contactId: 'c-sg-witness', role: 'witness' });
  });

  it('document_meta: renames and recategorises the document', async () => {
    const id = await proposeOne({
      kind: 'document_meta',
      payload: { documentId: 'd-sg-2', category: 'will', title: 'Will of Fictional Thornbury' },
    });
    await accept({ suggestionId: id });
    expect(await data(`${MATTER}/documents/d-sg-2`)).toMatchObject({
      category: 'will',
      name: 'Will of Fictional Thornbury',
      updatedBy: uidOf('lawyer'),
    });
  });

  it('time_entry: a draft entry of the person accepting, source clerk, priced and counted into WIP', async () => {
    const payload = { date: '2026-10-05', minutes: 30, narrative: 'Call with the executor' };
    const id = await proposeOne({ kind: 'time_entry', payload });
    const result = await accept({ suggestionId: id });
    expect(result.resultRef).toMatch(new RegExp(`^${MATTER}/timeEntries/`));
    expect(await data(result.resultRef)).toMatchObject({
      ...payload,
      uid: uidOf('lawyer'),
      status: 'draft',
      source: 'clerk',
      billable: true,
      units: 5,
      amountCents: 15000,
      createdBy: uidOf('lawyer'),
    });
    const matter = await poll(
      () => data(MATTER),
      (m) => typeof m['wipCents'] === 'number' && m['wipCents'] > 0,
    );
    expect(matter['wipCents']).toBe(15000);
    // The same time again is already recorded.
    expect((await propose([{ kind: 'time_entry', payload }])).skipped).toEqual([
      expect.objectContaining({ reason: 'exists' }),
    ]);
    const error = await failure(
      accept({
        suggestionId: await proposeOne({
          kind: 'time_entry',
          payload: { ...payload, minutes: 12, taskId: 'no-such-task' },
        }),
      }),
    );
    expect(detailsOf(error)).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('edited: applies the edit (status edited) and returns field errors for a bad one', async () => {
    const id = await proposeOne(task('Call the valuer'));
    const bad = await failure(accept({ suggestionId: id, editedPayload: { title: '', dueDate: 'soon' } }));
    expect(detailsOf(bad)).toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'edited_payload' });
    expect(Object.keys(detailsOf(bad)['fields'] as object).sort()).toEqual(['dueDate', 'title']);
    const result = await accept({ suggestionId: id, editedPayload: { title: 'Call the valuer on Monday' } });
    expect(result.status).toBe('edited');
    expect(await data(result.resultRef)).toMatchObject({ title: 'Call the valuer on Monday' });
    expect(await suggestionDoc(id)).toMatchObject({
      status: 'edited',
      appliedPayload: { title: 'Call the valuer on Monday' },
    });
  });
});

describe('kinds without a handler', () => {
  it.each([
    ['chronology', { date: '2026-01-02', datePrecision: 'day', title: 'Will signed', detail: 'At the firm' }],
    [
      'order',
      {
        courtEventId: 'ce-1',
        orderNo: '1',
        text: 'File affidavits',
        requiresAction: true,
        responsiblePartyRole: 'plaintiff',
        status: 'pending',
      },
    ],
    ['evidence', { documentId: 'd-sg-1', supports: 'us', strength: 2 }],
  ])('%s is rejected with SUGGESTION_UNSUPPORTED', async (kind, payload) => {
    const id = await proposeOne({ kind, payload });
    const error = await failure(accept({ suggestionId: id }));
    expect(detailsOf(error)).toMatchObject({ code: 'SUGGESTION_UNSUPPORTED', kind });
    expect((await suggestionDoc(id))['status']).toBe('proposed');
  });
});

describe('re-validation', () => {
  it('a matter changed after the suggestion makes it stale; accepting against the new basis applies it', async () => {
    const id = await proposeOne(task('Lodge the inventory'));
    await db.doc(MATTER).update({ status: 'on_hold' });
    try {
      const error = await failure(accept({ suggestionId: id }));
      expect(detailsOf(error)).toMatchObject({
        code: 'SUGGESTION_STALE',
        changed: [{ key: 'matter.status', label: 'Matter status' }],
      });
      expect(await suggestionDoc(id)).toMatchObject({
        status: 'stale',
        staleReview: { changed: ['matter.status'], basis: detailsOf(error)['basis'] },
      });
      const tasks = await db.collection(`${MATTER}/tasks`).where('title', '==', 'Lodge the inventory').get();
      expect(tasks.size).toBe(0);
      const result = await accept({ suggestionId: id, expectedBasis: detailsOf(error)['basis'] });
      expect(result.status).toBe('accepted');
    } finally {
      await db.doc(MATTER).update({ status: 'open' });
    }
  });

  it('a cited document that became privileged hides the suggestion from a paralegal', async () => {
    const id = await proposeOne({
      ...task('Review the advice'),
      citations: [{ documentId: 'd-sg-1', quote: 'Advice' }],
    });
    await db.doc(`${MATTER}/documents/d-sg-1`).update({ privileged: true });
    try {
      await signInAs('paralegal');
      expect(detailsOf(await failure(accept({ suggestionId: id })))['code']).toBe('NOT_FOUND');
      expect(await suggestionDoc(id)).toMatchObject({ privileged: true, status: 'stale' });
    } finally {
      await db.doc(`${MATTER}/documents/d-sg-1`).update({ privileged: false });
      await signInAs('lawyer');
    }
  });

  it('a closed matter is refused with MATTER_CLOSED', async () => {
    await db.doc(`orgs/${ORG}/matters/${CLOSED_ID}`).update({ status: 'open' });
    const id = await proposeOne(task('Close the trust account'), {}, CLOSED_ID);
    await db.doc(`orgs/${ORG}/matters/${CLOSED_ID}`).update({ status: 'closed' });
    const error = await failure(accept({ matterId: CLOSED_ID, suggestionId: id }));
    expect(detailsOf(error)['code']).toBe('MATTER_CLOSED');
  });

  it('only roles that could do it by hand accept: readonly can’t accept a task', async () => {
    const id = await proposeOne(task('Prepare the affidavit of assets'));
    await signInAs('readonly');
    try {
      expect(detailsOf(await failure(accept({ suggestionId: id })))['code']).toBe('PERMISSION_DENIED');
    } finally {
      await signInAs('lawyer');
    }
    expect((await suggestionDoc(id))['status']).toBe('proposed');
  });
});

describe('dedupe and concurrency', () => {
  it('dedupe prevents duplicates across runs, and against existing domain records', async () => {
    const first = await propose([task('Write to the bank'), task('Write to the bank')]);
    expect(first.created).toHaveLength(1);
    const second = await propose([task('Write to the bank')]);
    expect(second.created).toHaveLength(0);
    expect(second.skipped[0]?.reason).toBe('duplicate');
    // Accepted: the task now exists, so a later run is skipped as `exists`.
    await accept({ suggestionId: first.created[0]?.id });
    const third = await propose([task('Write to the bank')]);
    expect(third.skipped[0]?.reason).toBe('exists');
    const all = await db
      .collection(`${MATTER}/suggestions`)
      .where('dedupeKey', '==', first.created[0]?.dedupeKey)
      .get();
    expect(all.size).toBe(1);
  });

  it('two people accepting at once: exactly one applies, the other gets ALREADY_RESOLVED', async () => {
    const id = await proposeOne(task('Notify the State Revenue Office'));
    await signInAs('owner', secondAuth);
    const results = await Promise.allSettled([accept({ suggestionId: id }), accept({ suggestionId: id }, second)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(detailsOf(failed[0]?.reason as FunctionsError)['code']).toBe('ALREADY_RESOLVED');
    const tasks = await db.collection(`${MATTER}/tasks`).where('title', '==', 'Notify the State Revenue Office').get();
    expect(tasks.size).toBe(1);
  });
});

describe('dismiss, bulk accept and metrics', () => {
  it('dismisses with a reason; a dismissed one can’t be accepted', async () => {
    const id = await proposeOne(task('Order a title search'));
    await call(SUGGESTION_CALLABLES.dismiss, { suggestionId: id, reason: 'Already done' });
    expect(await suggestionDoc(id)).toMatchObject({ status: 'dismissed', dismissReason: 'Already done' });
    expect(detailsOf(await failure(accept({ suggestionId: id })))).toMatchObject({
      code: 'ALREADY_RESOLVED',
      status: 'dismissed',
    });
  });

  it('acceptMany returns a result per item', async () => {
    const result = await propose([task('Bulk one'), task('Bulk two')]);
    const ids = result.created.map((c) => c.id);
    const bulk = await call<AcceptManySuggestionsResult>(SUGGESTION_CALLABLES.acceptMany, {
      suggestionIds: [...ids, 'no-such-suggestion'],
    });
    expect(bulk).toMatchObject({ accepted: 2, failed: 1 });
    expect(bulk.results.map((r) => (r.ok ? r.status : r.code))).toEqual(['accepted', 'accepted', 'NOT_FOUND']);
  });

  it('counts outcomes per kind and prompt version in the org’s Clerk metrics', async () => {
    const metrics = await db.collection(`orgs/${ORG}/metrics`).get();
    const values = metrics.docs[0]?.get('values') as Record<string, number>;
    expect(values['suggestions.kind.task.accepted']).toBeGreaterThanOrEqual(3);
    expect(values['suggestions.prompt.suggest-matter@1.0.0.proposed']).toBeGreaterThan(10);
    expect(values['suggestions.dismissed']).toBeGreaterThanOrEqual(1);
  });
});
