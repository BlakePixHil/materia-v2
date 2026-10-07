import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import {
  CLERK_DEFAULT_DRAFTING_STYLE,
  CLERK_DISCLOSURE_VERSION,
  clerkDraftType,
  type ClerkDraftType,
  type RewriteClerkDraftResult,
  type Role,
  type SaveClerkDraftResult,
  type StartClerkDraftResult,
} from '@materia/domain';

import {
  DRAFT_QUEUE,
  DraftRunTaskSchema,
  draftRunDeps,
  recipientBlock,
  redraftDefinition,
  rewriteDraftDefinition,
  saveDraftDefinition,
  startDraftDefinition,
} from './callables';
import { draftingVars, recipientLines, runDraft, type DraftRunDeps } from './run';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../core/flags';
import { createLog } from '../../core/log';
import { docxPart, docxText, doyleSources } from '../../docs/testing';
import { MemoryFiles } from '../../documents/testing';
import { memoryFirestore } from '../../orgs/testing';
import { FakeClock, FakeKms, FakeTaskQueue, fakePorts } from '../../ports/fakes';
import { createContextBuilder } from '../context/build-context';
import { firestoreContextSource } from '../context/firestore-source';
import { charEstimateCounter } from '../context/ports';
import { FakeChunkSearch, FakeDocumentText } from '../context/testing';
import { anthropicKeyPath } from '../keyring';
import { FAKE_DRAFT_PARAGRAPHS, FAKE_REWRITE, FakeClerkModel, type FakeStep } from '../providers/fake';

/**
 * Unit tests for Clerk drafting's backend (AI-10): the seed's Doyle estate (Harbour & Vine Legal)
 * on the in-memory Firestore, with the fake Clerk model. Every firm, person and matter is fictional.
 */

type Data = Record<string, unknown>;

const ORG = 'org-a';
const MATTERS = `orgs/${ORG}/matters`;
const DRAFTS = `${MATTERS}/m1/clerkDrafts`;
const CANARY = 'PRIV-CANARY-5150';
const FLAGS = { 'clerk.enabled': true, 'clerk.features.drafting': true };
const at = new Date('2026-09-01T00:00:00.000Z');
const meta = { createdAt: at, createdBy: 'user-owner', updatedAt: at, updatedBy: 'user-owner', schemaVersion: 1 };
const sources = doyleSources();
const LETTER = FAKE_DRAFT_PARAGRAPHS.join('\n\n');

async function world(options: { script?: FakeStep[]; flags?: Data; settings?: Data } = {}) {
  const kms = new FakeKms();
  const sealed = await kms.encrypt('sk-ant-fictional-drafts-unit-test-0000', anthropicKeyPath(ORG));
  const contacts = Object.fromEntries(
    Object.entries(sources.contacts).map(([id, contact]) => [
      `orgs/${ORG}/contacts/${id}`,
      { ...meta, ...contact, deletedAt: null },
    ]),
  );
  const member = (displayName: string, role: Role, extra: Data = {}) => ({
    ...meta,
    status: 'active',
    role,
    displayName,
    ...extra,
  });
  const matter = (extra: Data = {}) => ({
    ...meta,
    number: 'HV-2026-0001',
    title: 'Estate of Margaret Doyle',
    type: 'probate',
    jurisdiction: 'VIC',
    status: 'active',
    privileged: false,
    responsibleUid: 'user-lawyer',
    teamUids: [],
    clientContactIds: ['c-catherine-doyle'],
    deceased: { contactId: 'c-margaret-doyle', dateOfDeath: '2026-07-17', domicile: 'VIC' },
    fee: { arrangement: 'fixed', amountCents: 440_000 },
    deletedAt: null,
    ...extra,
  });
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      ...meta,
      name: 'Harbour & Vine Legal',
      abn: '00000000001',
      timezone: 'Australia/Melbourne',
      flags: options.flags ?? FLAGS,
      settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION, ...options.settings } },
    },
    [anthropicKeyPath(ORG)]: {
      provider: 'anthropic',
      uid: null,
      status: 'valid',
      scopes: [],
      encryptedApiKey: sealed.ciphertext,
      kmsKeyVersion: sealed.keyVersion,
      last4: '0000',
    },
    [`orgs/${ORG}/settings/letterhead`]: { ...meta, ...sources.letterhead },
    [`orgs/${ORG}/members/user-lawyer`]: member('Jordan Price', 'lawyer', {
      title: 'Senior Associate',
      email: 'lawyer@harbourvine.example',
    }),
    [`orgs/${ORG}/members/user-paralegal`]: member('Daniel Kim', 'paralegal', { title: 'Paralegal' }),
    [`orgs/${ORG}/members/user-owner`]: member('Alex Morgan', 'owner', { title: 'Principal' }),
    [`${MATTERS}/m1`]: matter(),
    [`${MATTERS}/m2`]: matter({ number: 'HV-2026-0002', type: 'fp', title: 'Doyle family provision claim' }),
    [`${MATTERS}/m3`]: matter({ number: 'HV-2026-0003', status: 'archived' }),
    [`${MATTERS}/m1/parties/p-executor`]: {
      ...meta,
      contactId: 'c-catherine-doyle',
      role: 'executor',
      deletedAt: null,
    },
    [`${MATTERS}/m1/parties/p-beneficiary`]: {
      ...meta,
      contactId: 'c-thomas-doyle',
      role: 'beneficiary',
      share: 'Whole of the residue',
      deletedAt: null,
    },
    [`${MATTERS}/m1/parties/p-gone`]: { ...meta, contactId: 'c-peter-hale', role: 'executor', deletedAt: at },
    [`orgs/${ORG}/contacts/c-no-address`]: { ...meta, kind: 'person', givenNames: 'Ari', familyName: 'Vance' },
    [`${MATTERS}/m1/parties/p-no-address`]: { ...meta, contactId: 'c-no-address', role: 'beneficiary' },
    [`${MATTERS}/m1/notes/n-advice`]: {
      ...meta,
      bodyMd: `Advice to the executor on the claim risk. ${CANARY}`,
      mentions: { uids: [], matterIds: [] },
      pinned: false,
      privileged: true,
      source: 'manual',
    },
    [`${MATTERS}/m1/notes/n-call`]: {
      ...meta,
      bodyMd: 'Called the bank about the estate accounts.',
      mentions: { uids: [], matterIds: [] },
      pinned: false,
      privileged: false,
      source: 'manual',
    },
    ...contacts,
  });

  clearFlagCaches();
  const clock = new FakeClock(new Date('2026-10-05T23:00:00.000Z'));
  const model = new FakeClerkModel(options.script ?? []);
  const tasks = new FakeTaskQueue();
  const ports = fakePorts({ clerkModel: model, clerkKms: kms, tasks, clock });
  const files = new MemoryFiles('demo-materia.appspot.com');
  const log = createLog({ fn: 'test' }, () => undefined);
  const context = createContextBuilder({
    source: firestoreContextSource(store.db),
    chunks: new FakeChunkSearch([]),
    documentText: new FakeDocumentText({}),
    tokens: charEstimateCounter,
  });
  const deps: DraftRunDeps = { ...draftRunDeps(store.db, ports, log, clock), context };
  const callableDeps = (): CallableDeps => ({
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
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      callableDeps(),
    );
  const start = (data: Data, role: Role = 'lawyer') =>
    call<StartClerkDraftResult>(startDraftDefinition, { matterId: 'm1', ...data }, role);
  const rewrite = (data: Data, role: Role = 'lawyer') =>
    call<RewriteClerkDraftResult>(
      rewriteDraftDefinition(() => ({ gateway: deps.gateway, context })),
      { matterId: 'm1', ...data },
      role,
    );
  const save = (data: Data, role: Role = 'lawyer') =>
    call<SaveClerkDraftResult>(
      saveDraftDefinition(() => files),
      { matterId: 'm1', ...data },
      role,
    );
  const redraft = (data: Data, role: Role = 'lawyer') => call(redraftDefinition, { matterId: 'm1', ...data }, role);
  /** Runs the next queued draft, as Cloud Tasks would. */
  const runNext = async (attempt = 0) => {
    const job = tasks.queued.shift();
    if (!job) throw new Error('nothing queued');
    expect(job.queue).toBe(DRAFT_QUEUE);
    return runDraft(deps, DraftRunTaskSchema.parse(job.payload), attempt);
  };
  const draft = (id: string) => store.docs.get(`${DRAFTS}/${id}`) as Data;
  /** What the model was sent: the system prompt and every block, as text. */
  const sent = (index = 0) => JSON.stringify(model.requests[index] ?? {});
  const audits = () =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, data]) => data);
  return { store, clock, model, tasks, files, deps, call, start, rewrite, save, redraft, runNext, draft, sent, audits };
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; details: Data }> {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected the call to fail');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const type = (id: string) => clerkDraftType(id) as ClerkDraftType;

beforeEach(() => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
});

describe('clerk-startDraft and clerk-runDraft', () => {
  it('creates a private draft, then streams Clerk’s letter into it server-side', async () => {
    const w = await world();
    const { draftId } = await w.start({
      typeId: 'grant-notification',
      recipients: [{ partyId: 'p-beneficiary' }],
      instructions: 'Mention that we expect to distribute before Christmas.',
    });
    expect(w.draft(draftId)).toMatchObject({
      typeId: 'grant-notification',
      title: 'Grant notification to beneficiaries: Thomas Doyle',
      ownerUid: 'user-lawyer',
      status: 'drafting',
      bodyMd: '',
      recipients: [
        {
          partyId: 'p-beneficiary',
          contactId: 'c-thomas-doyle',
          role: 'beneficiary',
          name: 'Thomas Doyle',
          address: '13 Example Street\nTorquay VIC 3220',
        },
      ],
      includePrivileged: false,
      deletedAt: null,
    });
    // The editor listens to the draft at once; nothing has been asked of the model yet.
    expect(w.model.requests).toHaveLength(0);
    const job = structuredClone(w.tasks.queued[0]);
    expect(job?.options.dedupeKey).toMatch(new RegExp(`^clerk-draft-${ORG}-${draftId}-`));

    expect(await w.runNext()).toBe('drafted');
    const done = w.draft(draftId);
    expect(done).toMatchObject({
      status: 'ready',
      bodyMd: LETTER,
      generatedMd: LETTER,
      provenance: [{ origin: 'clerk', length: LETTER.length }],
      // The Doyle estate has no grant yet: Clerk is told, and leaves placeholders.
      missingFacts: ['date of the grant', 'kind of grant'],
      privileged: false,
      promptId: 'drafting@1.0.0',
      truncated: false,
    });
    const request = w.model.requests[0];
    expect(request?.system).toContain('## Drafting a letter');
    expect(request?.system).toContain(CLERK_DEFAULT_DRAFTING_STYLE.split('\n')[0]);
    expect(request?.effort).toBe('medium');
    const user = w.sent();
    expect(user).toContain('Letter type: Grant notification to beneficiaries, to a third party (not our client).');
    expect(user).toContain('Thomas Doyle (beneficiary on the matter), at 13 Example Street, Torquay VIC 3220');
    expect(user).toContain('Not on the matter: date of the grant; kind of grant');
    expect(user).toContain('Mention that we expect to distribute before Christmas.');

    // A redelivered task finds the draft finished and does nothing.
    if (job) w.tasks.queued.push(job);
    expect(await w.runNext()).toBe('skipped');
    expect(w.model.requests).toHaveLength(1);
  });

  it('offers only the types that fit the matter, and the general letter needs instructions', async () => {
    const w = await world();
    expect(await failure(w.start({ typeId: 'larke-v-nugus' }))).toMatchObject({
      code: 'invalid-argument',
      details: { reason: 'draft_type' },
    });
    expect(await failure(w.start({ typeId: 'no-such-letter' }))).toMatchObject({ details: { reason: 'draft_type' } });
    expect((await w.start({ typeId: 'larke-v-nugus', matterId: 'm2' })).draftId).toBeTruthy();
    expect(await failure(w.start({ typeId: 'letter' }))).toMatchObject({
      details: { reason: 'instructions_required' },
    });
    expect(await failure(w.start({ typeId: 'letter', matterId: 'm3', instructions: 'Hello' }))).toMatchObject({
      details: { reason: 'matter_archived' },
    });
  });

  it('takes recipients from the matter’s parties or as typed, and refuses anyone not on the matter', async () => {
    const w = await world();
    const { draftId } = await w.start({
      typeId: 'bank-balance-request',
      recipients: [
        { name: 'Surfcoast Community Bank', address: 'PO Box 1\nTorquay VIC 3228' },
        { partyId: 'p-no-address' },
      ],
    });
    expect(w.draft(draftId)).toMatchObject({
      title: 'Bank balance request: Surfcoast Community Bank and Ari Vance',
      recipients: [
        { name: 'Surfcoast Community Bank', address: 'PO Box 1\nTorquay VIC 3228' },
        { partyId: 'p-no-address', name: 'Ari Vance', address: null },
      ],
    });
    for (const partyId of ['p-gone', 'p-elsewhere'])
      expect(await failure(w.start({ typeId: 'bank-balance-request', recipients: [{ partyId }] }))).toMatchObject({
        details: { reason: 'recipient' },
      });
  });

  it('leaves privileged material out of a letter to a third party unless the lawyer allows it (rule 6)', async () => {
    const w = await world();
    const third = await w.start({ typeId: 'bank-balance-request' });
    await w.runNext();
    expect(w.sent(0)).not.toContain(CANARY);
    expect(w.draft(third.draftId)['privileged']).toBe(false);

    const allowed = await w.start({ typeId: 'bank-balance-request', includePrivileged: true });
    await w.runNext();
    expect(w.sent(1)).toContain(CANARY);
    expect(w.draft(allowed.draftId)).toMatchObject({ includePrivileged: true, privileged: true });

    // A letter to the client may draw on it.
    const client = await w.start({ typeId: 'client-update', recipients: [{ partyId: 'p-executor' }] });
    await w.runNext();
    expect(w.sent(2)).toContain(CANARY);
    expect(w.draft(client.draftId)['privileged']).toBe(true);

    // A paralegal can't allow it, and never sees it.
    const paralegal = await w.start({ typeId: 'bank-balance-request', includePrivileged: true }, 'paralegal');
    await w.runNext();
    expect(w.sent(3)).not.toContain(CANARY);
    expect(w.draft(paralegal.draftId)).toMatchObject({ includePrivileged: false, privileged: false });
  });

  it('follows the firm’s house style when one is set', async () => {
    const w = await world({ settings: { draftingStyle: 'Sign off with "Kind regards". Fictional style.' } });
    await w.start({ typeId: 'bank-balance-request' });
    await w.runNext();
    expect(w.model.requests[0]?.system).toContain('Sign off with "Kind regards". Fictional style.');
    expect(w.model.requests[0]?.system).not.toContain(CLERK_DEFAULT_DRAFTING_STYLE.split('\n')[0]);
  });

  it('stops when asked, keeping what Clerk wrote', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request', instructions: '[fake:slow]' });
    const running = w.runNext();
    while (!w.draft(draftId)['bodyMd']) await sleep(5);
    await w.store.db.doc(`${DRAFTS}/${draftId}`).update({ stopRequested: true });
    expect(await running).toBe('drafted');
    const stopped = w.draft(draftId);
    expect(stopped['status']).toBe('stopped');
    expect(String(stopped['bodyMd'])).toMatch(/^Dear /);
    expect(stopped['provenance']).toEqual([{ origin: 'clerk', length: String(stopped['bodyMd']).length }]);
  });

  it('ends the draft with the reason when Clerk refuses, is switched off or the run was interrupted', async () => {
    const refused = await world();
    const a = await refused.start({ typeId: 'bank-balance-request', instructions: '[fake:refuse]' });
    expect(await refused.runNext()).toBe('failed');
    expect(refused.draft(a.draftId)).toMatchObject({ status: 'error', error: { code: 'CLERK_REFUSED' } });

    const off = await world();
    const b = await off.start({ typeId: 'bank-balance-request' });
    await off.store.db.doc(`orgs/${ORG}`).update({ 'settings.clerk.features': { drafting: false } });
    expect(await off.runNext()).toBe('failed');
    expect(off.draft(b.draftId)).toMatchObject({
      status: 'error',
      error: { code: 'CLERK_DISABLED', switch: 'org.settings.clerk.features.drafting' },
    });

    const interrupted = await world();
    const c = await interrupted.start({ typeId: 'bank-balance-request' });
    expect(await interrupted.runNext(1)).toBe('failed');
    expect(interrupted.draft(c.draftId)).toMatchObject({ status: 'error', error: { code: 'CLERK_UNAVAILABLE' } });
    expect(interrupted.model.requests).toHaveLength(0);
  });

  it('says at once when drafting is switched off, without creating a draft', async () => {
    const w = await world({ flags: { ...FLAGS, 'clerk.features.drafting': false } });
    expect(await failure(w.start({ typeId: 'bank-balance-request' }))).toMatchObject({
      details: { code: 'CLERK_DISABLED', switch: 'clerk.features.drafting' },
    });
    const org = await world({ settings: { features: { drafting: false } } });
    expect(await failure(org.start({ typeId: 'bank-balance-request' }))).toMatchObject({
      details: { code: 'CLERK_DISABLED', switch: 'org.settings.clerk.features.drafting' },
    });
    expect([...w.store.docs.keys(), ...org.store.docs.keys()].some((path) => path.startsWith(DRAFTS))).toBe(false);
  });
});

describe('clerk-redraft', () => {
  it('drafts the whole letter again with new instructions, and an older queued run skips', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request' });
    const first = structuredClone(w.tasks.queued[0]);
    await w.runNext();
    await w.store.db.doc(`${DRAFTS}/${draftId}`).update({
      bodyMd: `${LETTER}\n\nEdited.`,
      provenance: [
        { origin: 'clerk', length: LETTER.length },
        { origin: 'person', length: 9 },
      ],
    });

    await w.redraft({ draftId, instructions: 'Ask for statements for the last three months too.' });
    expect(w.draft(draftId)).toMatchObject({
      status: 'drafting',
      bodyMd: '',
      provenance: [],
      instructions: 'Ask for statements for the last three months too.',
    });
    // The first run's task, delivered late, belongs to the earlier draft.
    if (first) expect(await runDraft(w.deps, DraftRunTaskSchema.parse(first.payload))).toBe('skipped');
    expect(await w.runNext()).toBe('drafted');
    expect(w.draft(draftId)).toMatchObject({ status: 'ready', bodyMd: LETTER });
    expect(w.sent(1)).toContain('Ask for statements for the last three months too.');
  });

  it('waits while Clerk is drafting, and keeps other people’s drafts private', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request' });
    expect(await failure(w.redraft({ draftId }))).toMatchObject({ code: 'aborted', details: { reason: 'drafting' } });
    await w.runNext();
    expect(await failure(w.redraft({ draftId }, 'owner'))).toMatchObject({ code: 'not-found' });
  });
});

describe('clerk-rewriteDraft', () => {
  it('rewrites the selected passage with the text around it, and counts the rewrite', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request' });
    await w.runNext();
    const [before, selection, after] = [
      FAKE_DRAFT_PARAGRAPHS.slice(0, 2).join('\n\n'),
      FAKE_DRAFT_PARAGRAPHS[2],
      FAKE_DRAFT_PARAGRAPHS[3],
    ];
    const result = await w.rewrite({ draftId, selection, before, after, instruction: 'Make it shorter.' });
    expect(result).toEqual({ text: FAKE_REWRITE, privileged: false });
    const request = w.model.requests[1];
    expect(request?.system).toContain('## Rewriting part of a letter');
    expect(request?.effort).toBe('low');
    expect(w.sent(1)).toContain(`<passage>\\n${selection}\\n</passage>`);
    expect(w.sent(1)).toContain('Make it shorter.');
    expect(w.draft(draftId)['rewrites']).toBe(1);
  });

  it('waits while Clerk is drafting, and only for the draft’s owner', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request' });
    expect(await failure(w.rewrite({ draftId, selection: 'Dear Sir' }))).toMatchObject({
      details: { reason: 'drafting' },
    });
    await w.runNext();
    expect(await failure(w.rewrite({ draftId, selection: 'Dear Sir' }, 'paralegal'))).toMatchObject({
      code: 'not-found',
    });
  });
});

describe('clerk-saveDraft', () => {
  const edited = `${LETTER}\n\nWe enclose a copy of the death certificate.`;
  const provenance = [
    { origin: 'clerk', length: LETTER.length },
    { origin: 'person', length: edited.length - LETTER.length },
  ];

  it('merges the letter into the firm’s letterhead and files it as a draft, never sending it', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'grant-notification', recipients: [{ partyId: 'p-beneficiary' }] });
    await w.runNext();
    w.tasks.queued.length = 0;
    const result = await w.save({ draftId, bodyMd: edited, provenance });
    expect(result).toMatchObject({
      name: 'Grant notification to beneficiaries Thomas Doyle.docx',
      missing: [],
      toConfirm: 1,
    });

    const record = w.store.docs.get(`${MATTERS}/m1/documents/${result.documentId}`) as Data & { storagePath: string };
    expect(record).toMatchObject({
      source: 'clerk_draft',
      category: 'correspondence',
      privileged: false,
      generatedFrom: { templateId: 'system-letterhead', version: 1 },
      createdBy: 'user-lawyer',
    });
    expect(record['tags']).toContain('clerk-draft');
    const file = (await w.files.read(record.storagePath)) as Buffer;
    const text = docxText(file);
    expect(text).toContain('Thomas Doyle\n13 Example Street\nTorquay VIC 3220');
    expect(text).toContain('Our reference: HV-2026-0001');
    expect(text).toContain('Please let us know the balance of each account');
    expect(text).toContain('We enclose a copy of the death certificate.');
    expect(text).toContain('Yours sincerely');
    expect(text).toContain('Jordan Price');
    // Who wrote what is kept for audit, never on the letter.
    expect(docxPart(file)).not.toMatch(/provenance|origin/);
    expect(docxText(file, 'word/header1.xml')).toContain('Harbour & Vine Legal');
    expect(docxPart(file)).toMatchSnapshot('document.xml');

    expect(w.tasks.queued.map((job) => job.queue)).toEqual(['documents-render']);
    expect(w.draft(draftId)).toMatchObject({
      status: 'saved',
      bodyMd: edited,
      provenance,
      documentIds: [result.documentId],
    });
    expect(w.audits()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'document.generated' }),
        expect.objectContaining({
          action: 'clerk.draft_saved',
          data: expect.objectContaining({
            typeId: 'grant-notification',
            clerkChars: LETTER.length,
            personChars: edited.length - LETTER.length,
            placeholders: 1,
          }),
        }),
      ]),
    );
  });

  it('puts a placeholder where a recipient’s address is missing', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request', recipients: [{ partyId: 'p-no-address' }] });
    await w.runNext();
    const result = await w.save({ draftId, bodyMd: LETTER, provenance: [] });
    const record = w.store.docs.get(`${MATTERS}/m1/documents/${result.documentId}`) as { storagePath: string };
    expect(docxText((await w.files.read(record.storagePath)) as Buffer)).toContain(
      'Ari Vance\n[[TO CONFIRM: address for Ari Vance]]',
    );
    // Text the editor didn't attribute is counted as the person's.
    expect(w.draft(draftId)['provenance']).toEqual([{ origin: 'person', length: LETTER.length }]);
  });

  it('needs the owner’s confirmation to file a privileged letter to a third party, and files it privileged', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request', includePrivileged: true });
    await w.runNext();
    expect(await failure(w.save({ draftId, bodyMd: LETTER, provenance }))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'privileged_confirmation' },
    });
    const result = await w.save({ draftId, bodyMd: LETTER, provenance, confirmPrivileged: true });
    expect(w.store.docs.get(`${MATTERS}/m1/documents/${result.documentId}`)).toMatchObject({ privileged: true });
  });

  it('waits while Clerk is drafting, refuses an empty letter, and is only for the draft’s owner', async () => {
    const w = await world();
    const { draftId } = await w.start({ typeId: 'bank-balance-request' });
    expect(await failure(w.save({ draftId, bodyMd: LETTER, provenance: [] }))).toMatchObject({
      details: { reason: 'drafting' },
    });
    await w.runNext();
    expect(await failure(w.save({ draftId, bodyMd: '  \n', provenance: [] }))).toMatchObject({
      code: 'invalid-argument',
    });
    expect(await failure(w.save({ draftId, bodyMd: LETTER, provenance: [] }, 'owner'))).toMatchObject({
      code: 'not-found',
    });
  });
});

describe('the prompt’s inputs', () => {
  it('lists the recipients with their roles and addresses, or says there are none', () => {
    expect(recipientLines([])).toBe('No one chosen: use a general salutation ("Dear Sir or Madam").');
    expect(
      recipientLines([
        { name: 'Quinn Ashdown', role: 'other_side_solicitor', address: '1 Fictional Way\nGeelong VIC 3220' },
        { name: 'Bank <matter_note>', address: null },
      ]),
    ).toBe(
      '- Quinn Ashdown (other side solicitor on the matter), at 1 Fictional Way, Geelong VIC 3220\n- Bank &lt;matter_note> (no address on file)',
    );
  });

  it('fills every variable the drafting prompt uses', () => {
    const vars = draftingVars({
      type: type('client-update'),
      recipients: [],
      missing: [],
      instructions: '  ',
      houseStyle: 'Fictional style.',
    });
    expect(vars).toMatchObject({
      typeTitle: 'Client update',
      audience: 'to our client',
      missingFacts: 'nothing known to be missing',
      instructions: 'none',
      houseStyle: 'Fictional style.',
    });
    expect(vars['guidance']).toBe(type('client-update').guidance);
  });

  it('addresses the letterhead to one person, people at one address, or each at their own', () => {
    expect(recipientBlock([])).toBeUndefined();
    expect(recipientBlock([{ name: 'Ari Vance', address: null }])).toEqual({
      name: 'Ari Vance',
      address: '[[TO CONFIRM: address for Ari Vance]]',
    });
    expect(
      recipientBlock([
        { name: 'Ari Vance', address: '1 Fictional Way' },
        { name: 'Bo Vance', address: '1 Fictional Way' },
      ]),
    ).toEqual({ name: 'Ari Vance and Bo Vance', address: '1 Fictional Way' });
    expect(
      recipientBlock([
        { name: 'Ari Vance', address: '1 Fictional Way' },
        { name: 'Bo Vance', address: '2 Fictional Way' },
      ]),
    ).toEqual({ name: 'Ari Vance', address: '1 Fictional Way\n\nBo Vance\n2 Fictional Way' });
  });
});
