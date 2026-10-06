import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import {
  hashString,
  suggestionAcceptanceRates,
  type AcceptManySuggestionsResult,
  type AcceptSuggestionResult,
  type Role,
} from '@materia/domain';

import { acceptDefinition, acceptManyDefinition } from './accept';
import { dismissDefinition } from './dismiss';
import { expireSuggestions } from './expire';
import { notifyNewSuggestions, type SuggestionNoticeOptions } from './notify';
import { proposeSuggestions, type ProposeOptions } from './propose';
import {
  handledSuggestionKinds,
  registerSuggestionHandler,
  suggestionHandler,
  unregisterSuggestionHandler,
} from './registry';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { clearStaleFactCitations } from '../matters/fact-citations';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts, FakeTaskQueue } from '../ports/fakes';

/** Unit tests for Clerk suggestions (AI-07). Every org, person, matter and record is fictional. */

const ORG = 'org-s';
const M = `orgs/${ORG}/matters`;
const NOW = new Date('2026-10-05T00:00:00.000Z');
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const member = (role: Role) => ({ ...meta, role, status: 'active', displayName: `Fictional ${role}` });
const matter = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  number: 'SG-2026-0001',
  title: 'Estate of Fictional Marlow',
  type: 'probate',
  status: 'open',
  jurisdiction: 'VIC',
  responsibleUid: 'user-lawyer',
  clientContactIds: ['c-client'],
  privileged: false,
  deletedAt: null,
  estate: { grantNo: 'G-1' },
  ...extra,
});
const OPTIONS: ProposeOptions = {
  privileged: false,
  promptId: 'suggest-tasks',
  promptVersion: '1.2.0',
  model: 'claude-sonnet-5-5',
};

type Data = Record<string, unknown>;

function world(
  initial: Record<string, Data> = {},
  flags: Record<string, unknown> = { 'clerk.features.suggestions': true },
) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Ridge Legal', timezone: 'Australia/Melbourne', flags },
    [`orgs/${ORG}/members/user-owner`]: member('owner'),
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal'),
    [`orgs/${ORG}/members/user-readonly`]: member('readonly'),
    [`orgs/${ORG}/contacts/c-client`]: { ...meta, kind: 'person', firstName: 'Ada', lastName: 'Fictional' },
    [`orgs/${ORG}/contacts/c-witness`]: { ...meta, kind: 'person', firstName: 'Ben', lastName: 'Fictional' },
    [`${M}/m1`]: matter(),
    [`${M}/m1/parties/client-c-client`]: { ...meta, contactId: 'c-client', role: 'client', orgId: ORG, matterId: 'm1' },
    [`${M}/m1/documents/d1`]: { ...meta, name: 'Scan 001', category: 'other', privileged: false, version: 1 },
    [`${M}/m-closed`]: matter({ status: 'closed' }),
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const ports = fakePorts();
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
  const call = <T>(def: CallableDefinition<never, T>, data: Data, role: Role = 'lawyer') =>
    runCallable(
      def,
      {
        data: { requestId: randomUUID(), matterId: 'm1', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(),
    );
  const accept = (data: Data, role: Role = 'lawyer') =>
    call<AcceptSuggestionResult>(acceptDefinition as never, data, role);
  const acceptMany = (data: Data, role: Role = 'lawyer') =>
    call<AcceptManySuggestionsResult>(acceptManyDefinition as never, data, role);
  const dismiss = (data: Data, role: Role = 'lawyer') => call(dismissDefinition as never, data, role);
  const log = createLog({ fn: 'test' }, () => undefined);
  const propose = (proposals: unknown[], options: Partial<ProposeOptions> = {}, matterId = 'm1') =>
    proposeSuggestions({ db: store.db, orgId: ORG, clock, log }, matterId, proposals, { ...OPTIONS, ...options });
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const under = (path: string) =>
    [...store.docs.entries()]
      .filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1)
      .map(([p, data]): Data & { id: string } => ({ ...data, id: p.split('/').at(-1) as string }));
  const suggestion = (id: string, matterId = 'm1') => doc(`${M}/${matterId}/suggestions/${id}`) as Data;
  const tasks = new FakeTaskQueue();
  const logs: { message: string; entry: Data }[] = [];
  const noticeLog = createLog({ fn: 'test' }, (_s, message, entry) => void logs.push({ message, entry }));
  const notice = (
    created: Awaited<ReturnType<typeof propose>>['created'],
    options: SuggestionNoticeOptions = {},
    matterId = 'm1',
  ) =>
    notifyNewSuggestions(
      { db: store.db, orgId: ORG, clock, log: noticeLog, ports: { tasks } },
      matterId,
      created,
      options,
    );
  const notifications = () => under(`orgs/${ORG}/notifications`);
  return {
    store,
    clock,
    accept,
    acceptMany,
    dismiss,
    propose,
    doc,
    under,
    suggestion,
    log,
    notice,
    notifications,
    tasks,
    logs,
  };
}

async function failure(promise: Promise<unknown>): Promise<HttpsError & { details: Data }> {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError & { details: Data };
  }
  throw new Error('expected the call to fail');
}

const task = (title = 'Request date-of-death valuation', dueDate = '2026-10-12') => ({
  kind: 'task',
  payload: { title, dueDate, priority: 'medium' },
  citations: [{ documentId: 'd1', page: 1, quote: 'Valuation to follow' }],
  rationale: 'The will mentions real property',
});

beforeEach(() => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
});

describe('proposeSuggestions', () => {
  it('creates proposed suggestions with basis, expiry, prompt and the clerk actor', async () => {
    const w = world();
    const result = await w.propose([task()]);
    expect(result.skipped).toEqual([]);
    const [created] = result.created;
    const stored = w.suggestion(created?.id as string);
    expect(stored).toMatchObject({
      kind: 'task',
      status: 'proposed',
      orgId: ORG,
      matterId: 'm1',
      privileged: false,
      promptId: 'suggest-tasks',
      promptVersion: '1.2.0',
      createdBy: 'clerk',
      dedupeKey: 'task:request date-of-death valuation|2026-10-12',
    });
    expect(String(stored['basis'])).toMatch(/^[0-9a-f]{14}$/);
    expect(Object.keys(stored['basisParts'] as Data)).toEqual(
      expect.arrayContaining(['matter.status', 'document.d1.version', 'document.d1.privileged']),
    );
    const expires = (stored['expiresAt'] as { toDate(): Date }).toDate();
    expect(expires.toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('dedupes across runs, within a run and against dismissed ones', async () => {
    const w = world();
    const first = await w.propose([task(), task()]);
    expect(first.created).toHaveLength(1);
    expect(first.skipped).toEqual([{ index: 1, reason: 'duplicate', dedupeKey: expect.any(String) }]);
    const second = await w.propose([task(), task('Write to the bank')]);
    expect(second.created.map((c) => c.index)).toEqual([1]);
    expect(second.skipped[0]?.reason).toBe('duplicate');
    await w.dismiss({ suggestionId: second.created[0]?.id });
    expect((await w.propose([task('Write to the bank')])).skipped[0]?.reason).toBe('duplicate');
    expect(w.under(`${M}/m1/suggestions`)).toHaveLength(2);
  });

  it('skips what the domain already has', async () => {
    const w = world({
      [`${M}/m1/tasks/t1`]: {
        ...meta,
        title: 'Request date-of-death valuation',
        dueDate: '2026-10-12',
        status: 'todo',
      },
    });
    const result = await w.propose([
      task(),
      { kind: 'key_fact', payload: { field: 'grantNo', value: 'G-1' } },
      { kind: 'party', payload: { contactId: 'c-client', role: 'client' } },
      { kind: 'document_meta', payload: { documentId: 'd1', category: 'other' } },
      task('Request date-of-death valuation', '2026-10-13'),
    ]);
    expect(result.skipped.map((s) => [s.index, s.reason])).toEqual([
      [0, 'exists'],
      [1, 'exists'],
      [2, 'exists'],
      [3, 'exists'],
    ]);
    expect(result.created.map((c) => c.index)).toEqual([4]);
  });

  it('marks suggestions privileged from the context, the matter or a cited document', async () => {
    const w = world({
      [`${M}/m1/documents/d-priv`]: {
        ...meta,
        name: 'Advice',
        category: 'correspondence',
        privileged: true,
        version: 2,
      },
    });
    const result = await w.propose([
      task('From the context'),
      { ...task('Cites privileged'), citations: [{ documentId: 'd-priv', quote: 'Advice' }] },
    ]);
    expect(result.created.map((c) => c.privileged)).toEqual([false, true]);
    const again = await w.propose([task('Another')], { privileged: true });
    expect(again.created[0]?.privileged).toBe(true);
  });

  it('rejects invalid proposals, closed matters, and does nothing while the flag is off', async () => {
    const w = world();
    const invalid = await w.propose([
      { kind: 'task', payload: { title: '' } },
      { kind: 'nope', payload: {} },
    ]);
    expect(invalid.skipped.map((s) => s.reason)).toEqual(['invalid', 'invalid']);
    expect((await w.propose([task()], {}, 'm-closed')).skipped[0]?.reason).toBe('matter_unavailable');
    const off = world({}, {});
    clearFlagCaches();
    expect((await off.propose([task()])).skipped[0]?.reason).toBe('disabled');
  });
});

describe('notifyNewSuggestions (CORE-22a)', () => {
  it('tells the responsible lawyer once per batch, about the first suggestion, without its content', async () => {
    const w = world();
    const { created } = await w.propose([task(), task('Write to the bank')]);
    const ids = await w.notice(created);
    expect(ids).toEqual([`suggest-m1-${created[0]?.id}`]);
    expect(w.notifications()).toEqual([
      expect.objectContaining({
        id: `suggest-m1-${created[0]?.id}`,
        kind: 'suggestion',
        recipientUid: 'user-lawyer',
        suggestionId: created[0]?.id,
        matterId: 'm1',
        title: 'Clerk has 2 suggestions on SG-2026-0001',
        body: 'Task: review them before anything changes.',
        link: '/matters/m1/overview',
        channels: ['inapp'],
        readAt: null,
        createdBy: 'clerk',
      }),
    ]);
    expect(JSON.stringify(w.notifications())).not.toContain('valuation');
    // In-app only by default: nothing to deliver. A rerun rewrites the same notification.
    expect(w.tasks.queued).toEqual([]);
    await w.notice(created);
    expect(w.notifications()).toHaveLength(1);
    // Nothing new, nothing sent.
    expect(await w.notice([])).toEqual([]);
  });

  it('falls back to the uploader when the responsible lawyer can’t review it, never to a read-only member', async () => {
    const w = world({ [`${M}/m-ro`]: matter({ number: 'SG-2026-0002', responsibleUid: 'user-readonly' }) });
    const doc = { kind: 'document_meta', payload: { documentId: 'd9', category: 'will' } };
    const { created } = await w.propose([doc], {}, 'm-ro');
    expect(await w.notice(created, {}, 'm-ro')).toEqual([]);
    expect(w.logs.map((l) => l.entry['reason'])).toContain('no_recipient');
    expect(await w.notice(created, { fallbackUid: 'user-readonly' }, 'm-ro')).toEqual([]);
    await w.notice(created, { fallbackUid: 'user-paralegal' }, 'm-ro');
    expect(w.notifications()).toEqual([
      expect.objectContaining({
        recipientUid: 'user-paralegal',
        title: 'Clerk has a suggestion on SG-2026-0002',
        body: 'Document details: review it before anything changes.',
      }),
    ]);
  });

  it('sends a privileged suggestion only to someone who can see privileged material', async () => {
    const w = world({
      [`${M}/m-priv`]: matter({ number: 'SG-2026-0003', privileged: true, responsibleUid: 'user-paralegal' }),
    });
    const { created } = await w.propose([task()], {}, 'm-priv');
    expect(created[0]?.privileged).toBe(true);
    expect(await w.notice(created, { fallbackUid: 'user-readonly' }, 'm-priv')).toEqual([]);
    await w.notice(created, { fallbackUid: 'user-owner' }, 'm-priv');
    expect(w.notifications().map((n) => n['recipientUid'])).toEqual(['user-owner']);
  });

  it('leaves out inactive members and follows the recipient’s preferences', async () => {
    const w = world({
      [`orgs/${ORG}/members/user-lawyer`]: { ...member('lawyer'), status: 'suspended' },
      'users/user-owner': { prefs: { notifications: { kinds: { suggestion: { inapp: false } } } } },
    });
    const { created } = await w.propose([task()]);
    expect(await w.notice(created, { fallbackUid: 'user-owner' })).toEqual([]);
    expect(w.notifications()).toEqual([]);
  });
});

describe('suggestions-accept', () => {
  async function proposed(w: ReturnType<typeof world>, proposal: unknown) {
    const result = await w.propose([proposal]);
    const id = result.created[0]?.id;
    if (!id) throw new Error(`not created: ${JSON.stringify(result.skipped)}`);
    return id;
  }

  it('task: creates a clerk task through the domain schema and resolves the suggestion', async () => {
    const w = world();
    const id = await proposed(w, task());
    const result = await w.accept({ suggestionId: id });
    expect(result.status).toBe('accepted');
    expect(result.resultRef).toMatch(new RegExp(`^${M}/m1/tasks/`));
    expect(w.doc(result.resultRef)).toMatchObject({
      title: 'Request date-of-death valuation',
      dueDate: '2026-10-12',
      status: 'todo',
      source: 'clerk',
      countedOpen: false,
      createdBy: 'user-lawyer',
    });
    expect(w.suggestion(id)).toMatchObject({
      status: 'accepted',
      resolvedBy: 'user-lawyer',
      resultRef: result.resultRef,
    });
  });

  it('audits the person with via: clerk', async () => {
    const w = world();
    const id = await proposed(w, task());
    await w.accept({ suggestionId: id });
    const entry = w.under(`orgs/${ORG}/audit`).find((a) => a['action'] === 'suggestion.accepted');
    expect(entry).toMatchObject({
      actor: { uid: 'user-lawyer' },
      data: expect.objectContaining({ via: 'clerk', kind: 'task', suggestionId: id }),
    });
  });

  it('edited: applies the edited payload and returns field errors for a bad one', async () => {
    const w = world();
    const id = await proposed(w, task());
    const bad = await failure(w.accept({ suggestionId: id, editedPayload: { title: '', dueDate: '12/10/2026' } }));
    expect(bad.details['code']).toBe('INVALID_ARGUMENT');
    expect(Object.keys(bad.details['fields'] as Data).sort()).toEqual(['dueDate', 'title']);
    const result = await w.accept({
      suggestionId: id,
      editedPayload: { title: 'Request valuation', priority: 'high' },
    });
    expect(result.status).toBe('edited');
    expect(w.doc(result.resultRef)).toMatchObject({ title: 'Request valuation', priority: 'high' });
    expect(w.suggestion(id)).toMatchObject({ status: 'edited', appliedPayload: { title: 'Request valuation' } });
  });

  it('deadline: a manual internal deadline for the responsible lawyer', async () => {
    const w = world();
    const id = await proposed(w, {
      kind: 'deadline',
      payload: { title: 'Send estate account', dueDate: '2026-11-02' },
    });
    const result = await w.accept({ suggestionId: id }, 'paralegal');
    expect(w.doc(result.resultRef)).toMatchObject({
      title: 'Send estate account',
      kind: 'internal',
      status: 'upcoming',
      assigneeUid: 'user-lawyer',
      critical: false,
    });
  });

  it('key_fact: patches the matter fact', async () => {
    const w = world();
    const id = await proposed(w, { kind: 'key_fact', payload: { field: 'grantNo', value: 'G-2026-77' } });
    const result = await w.accept({ suggestionId: id });
    expect(result.resultRef).toBe(`${M}/m1`);
    expect((w.doc(`${M}/m1`)?.['estate'] as Data)['grantNo']).toBe('G-2026-77');
  });

  it('note: a clerk note, privileged when the suggestion is', async () => {
    const w = world();
    const id = await proposed(w, { kind: 'note', payload: { bodyMd: 'Executor confirmed the bank details.' } });
    const result = await w.accept({ suggestionId: id });
    expect(w.doc(result.resultRef)).toMatchObject({
      source: 'clerk',
      privileged: false,
      bodyMd: 'Executor confirmed the bank details.',
    });
    const privileged = await w.propose([{ kind: 'note', payload: { bodyMd: 'Advice summary.' } }], {
      privileged: true,
    });
    const noted = await w.accept({ suggestionId: privileged.created[0]?.id });
    expect(w.doc(noted.resultRef)?.['privileged']).toBe(true);
  });

  it('party: adds the contact in the role', async () => {
    const w = world();
    const id = await proposed(w, { kind: 'party', payload: { contactId: 'c-witness', role: 'witness' } });
    const result = await w.accept({ suggestionId: id });
    expect(result.resultRef).toBe(`${M}/m1/parties/witness-c-witness`);
    expect(w.doc(result.resultRef)).toMatchObject({ contactId: 'c-witness', role: 'witness' });
  });

  it('document_meta: renames and recategorises the document', async () => {
    const w = world();
    const id = await proposed(w, {
      kind: 'document_meta',
      payload: { documentId: 'd1', category: 'will', title: 'Will of Fictional Marlow' },
    });
    await w.accept({ suggestionId: id });
    expect(w.doc(`${M}/m1/documents/d1`)).toMatchObject({ category: 'will', name: 'Will of Fictional Marlow' });
  });

  it('rejects kinds without a handler', async () => {
    const w = world();
    const id = await proposed(w, {
      kind: 'evidence',
      payload: { documentId: 'd1', supports: 'us', strength: 2 },
    });
    expect((await failure(w.accept({ suggestionId: id }))).details).toMatchObject({
      code: 'SUGGESTION_UNSUPPORTED',
      kind: 'evidence',
    });
    expect(handledSuggestionKinds()).toEqual([
      'deadline',
      'document_meta',
      'event',
      'key_fact',
      'note',
      'party',
      'task',
      'time_entry',
    ]);
  });

  it('a registered handler makes a kind acceptable', async () => {
    const w = world();
    registerSuggestionHandler({
      kind: 'evidence',
      async apply(ctx) {
        await ctx.db.runTransaction(async (tx) => {
          await ctx.join.read(tx);
          ctx.join.write(tx, 'orgs/org-s/matters/m1/evidence/ev-fake');
        });
        return { resultRef: 'orgs/org-s/matters/m1/evidence/ev-fake' };
      },
    });
    try {
      const id = await proposed(w, {
        kind: 'evidence',
        payload: { documentId: 'd1', supports: 'us', strength: 2 },
      });
      expect((await w.accept({ suggestionId: id })).resultRef).toContain('ev-fake');
    } finally {
      unregisterSuggestionHandler('evidence');
    }
    expect(suggestionHandler('evidence')).toBeUndefined();
  });

  it('only roles that could do it by hand accept', async () => {
    const w = world();
    const id = await proposed(w, task());
    expect((await failure(w.accept({ suggestionId: id }, 'readonly'))).details['code']).toBe('PERMISSION_DENIED');
    expect(w.suggestion(id)['status']).toBe('proposed');
  });

  it('a stale basis marks it stale with the changes; accepting against the new basis applies it', async () => {
    const w = world();
    const id = await proposed(w, task());
    w.store.docs.set(`${M}/m1`, { ...w.doc(`${M}/m1`), status: 'on_hold' });
    const stale = await failure(w.accept({ suggestionId: id }));
    expect(stale.details).toMatchObject({
      code: 'SUGGESTION_STALE',
      changed: [{ key: 'matter.status', label: 'Matter status' }],
    });
    expect(w.suggestion(id)).toMatchObject({ status: 'stale', staleReview: { changed: ['matter.status'] } });
    expect(w.under(`${M}/m1/tasks`)).toHaveLength(0);
    const result = await w.accept({ suggestionId: id, expectedBasis: stale.details['basis'] });
    expect(result.status).toBe('accepted');
  });

  it('a cited document that became privileged hides it from a paralegal and makes it privileged', async () => {
    const w = world();
    const id = await proposed(w, task());
    w.store.docs.set(`${M}/m1/documents/d1`, { ...w.doc(`${M}/m1/documents/d1`), privileged: true });
    expect((await failure(w.accept({ suggestionId: id }, 'paralegal'))).details['code']).toBe('NOT_FOUND');
    expect(w.suggestion(id)).toMatchObject({ privileged: true, status: 'stale' });
    expect((await failure(w.accept({ suggestionId: id }, 'paralegal'))).details['code']).toBe('NOT_FOUND');
  });

  it('a closed matter is refused with MATTER_CLOSED', async () => {
    const w = world();
    const id = await proposed(w, task());
    w.store.docs.set(`${M}/m1`, { ...w.doc(`${M}/m1`), status: 'closed' });
    expect((await failure(w.accept({ suggestionId: id }))).details['code']).toBe('MATTER_CLOSED');
    expect(w.suggestion(id)['status']).toBe('proposed');
  });

  it('a resolved or expired suggestion is ALREADY_RESOLVED', async () => {
    const w = world();
    const id = await proposed(w, task());
    await w.accept({ suggestionId: id });
    expect((await failure(w.accept({ suggestionId: id }))).details).toMatchObject({
      code: 'ALREADY_RESOLVED',
      status: 'accepted',
    });
    const later = await proposed(w, task('Write to the bank'));
    w.clock.advance(15 * 86_400_000);
    expect((await failure(w.accept({ suggestionId: later }))).details).toMatchObject({ status: 'expired' });
  });

  it('acceptMany: per-item results', async () => {
    const w = world();
    const a = await proposed(w, task('One'));
    const b = await proposed(w, task('Two'));
    await w.dismiss({ suggestionId: b });
    const result = await w.acceptMany({ suggestionIds: [a, b, 'missing'] });
    expect(result).toMatchObject({ accepted: 1, failed: 2 });
    expect(result.results.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'ALREADY_RESOLVED', 'NOT_FOUND']);
  });

  it('is refused while the flag is off', async () => {
    const w = world({}, {});
    expect((await failure(w.accept({ suggestionId: 'x' }))).details['code']).toBe('FEATURE_DISABLED');
  });
});

describe('key fact citations (CORE-06a)', () => {
  const WILL_LINE = 'Signed by the will-maker on 3 May 2019.';
  const cite = (documentId = 'd1', extra: Data = {}) => ({
    documentId,
    version: 1,
    page: 2,
    quote: WILL_LINE,
    ...extra,
  });
  const fact = (field: string, value: string | number, citations: unknown[] = [cite()]) => ({
    kind: 'key_fact',
    payload: { field, value },
    citations,
    rationale: 'The will’s attestation clause dates it',
  });
  const record = (w: ReturnType<typeof world>, factId: string) => w.doc(`${M}/m1/factCitations/${factId}`);

  async function accepted(
    w: ReturnType<typeof world>,
    proposal: unknown,
    data: Data = {},
    options: Partial<ProposeOptions> = {},
  ) {
    const created = await w.propose([proposal], options);
    const id = created.created[0]?.id;
    if (!id) throw new Error(`not created: ${JSON.stringify(created.skipped)}`);
    await w.accept({ suggestionId: id, ...data });
    return id;
  }

  /** `matters-denormalise`'s clean-up for a write from `before` to the stored matter. */
  function cleanUp(w: ReturnType<typeof world>, before: Data) {
    const path = `${M}/m1`;
    const after = w.doc(path);
    const change = {
      before: { ref: { path }, data: () => before },
      after: after ? { ref: { path }, data: () => after } : undefined,
    } as unknown as TriggerChange;
    const ctx = {
      eventId: 'e1',
      time: NOW,
      params: { orgId: ORG, matterId: 'm1' },
      log: w.log,
      clock: w.clock,
      db: w.store.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return clearStaleFactCitations(change, ctx);
  }

  it('keeps what Clerk cited with the fact, in the accept’s transaction', async () => {
    const w = world();
    const id = await accepted(w, fact('willDate', '2019-05-03'));
    expect((w.doc(`${M}/m1`)?.['facts'] as Data)['willDate']).toBe('2019-05-03');
    expect(record(w, 'willDate')).toMatchObject({
      factId: 'willDate',
      value: '2019-05-03',
      // Stored with the current field names (`version` read as `docVersion`).
      citations: [{ kind: 'document', documentId: 'd1', docVersion: 1, page: 2, quote: WILL_LINE }],
      suggestionId: id,
      privileged: false,
      createdBy: 'user-lawyer',
      schemaVersion: 1,
    });
    expect(record(w, 'willDate')?.['citations']).toEqual([expect.not.objectContaining({ version: 1 })]);
  });

  it('keeps the citations of a date of death recorded as its event (CORE-10)', async () => {
    const w = world({
      [`${M}/m1`]: matter({ deceased: { contactId: 'c-client', domicile: 'VIC', lastAddress: '1 Example St' } }),
    });
    await accepted(w, fact('dateOfDeath', '2026-07-01'));
    expect((w.doc(`${M}/m1`)?.['deceased'] as Data)['dateOfDeath']).toBe('2026-07-01');
    expect(w.under(`${M}/m1/events`)).toEqual([expect.objectContaining({ kind: 'date_of_death', date: '2026-07-01' })]);
    expect(record(w, 'dateOfDeath')).toMatchObject({ value: '2026-07-01', citations: [{ page: 2 }] });
  });

  it('keeps none when the person changed the value first, or Clerk cited nothing', async () => {
    const w = world();
    await accepted(w, fact('grantNo', 'G-2026-77'), { editedPayload: { field: 'grantNo', value: 'G-2026-78' } });
    expect((w.doc(`${M}/m1`)?.['estate'] as Data)['grantNo']).toBe('G-2026-78');
    expect(record(w, 'grantNo')).toBeUndefined();
    await accepted(w, fact('willDate', '2019-05-03', []));
    expect(record(w, 'willDate')).toBeUndefined();
    // An edit that leaves the value as proposed keeps them.
    await accepted(w, fact('grossValue', 125_000_00), { editedPayload: { field: 'grossValue', value: 125_000_00 } });
    expect(record(w, 'grossValue')).toMatchObject({ value: 125_000_00 });
  });

  it('is privileged when the suggestion is, or a cited document is', async () => {
    const w = world({
      [`${M}/m1/documents/d-advice`]: { ...meta, name: 'Advice', category: 'other', privileged: true, version: 1 },
    });
    await accepted(w, fact('willDate', '2019-05-03'));
    expect(record(w, 'willDate')?.['privileged']).toBe(false);
    await accepted(w, fact('grantNo', 'G-2026-77', [cite('d1'), cite('d-advice')]));
    expect(record(w, 'grantNo')?.['privileged']).toBe(true);
    await accepted(w, fact('grossValue', 125_000_00), {}, { privileged: true });
    expect(record(w, 'grossValue')?.['privileged']).toBe(true);
  });

  it('is privileged when a cited document became privileged after Clerk proposed it', async () => {
    const w = world();
    const created = await w.propose([fact('willDate', '2019-05-03')]);
    const id = created.created[0]?.id ?? 'missing';
    w.store.docs.set(`${M}/m1/documents/d1`, { ...w.doc(`${M}/m1/documents/d1`), privileged: true });
    // The sources changed: reviewed, then accepted against the new basis.
    const stale = await failure(w.accept({ suggestionId: id }));
    expect(stale.details['code']).toBe('SUGGESTION_STALE');
    expect(record(w, 'willDate')).toBeUndefined();
    await w.accept({ suggestionId: id, expectedBasis: stale.details['basis'] });
    expect(record(w, 'willDate')).toMatchObject({ value: '2019-05-03', privileged: true });
  });

  it('writes nothing when the fact is refused', async () => {
    const w = world({ [`${M}/m1`]: matter({ type: 'will' }) });
    const created = await w.propose([fact('grantNo', 'G-2026-77')]);
    const id = created.created[0]?.id ?? 'missing';
    expect((await failure(w.accept({ suggestionId: id }))).details['code']).toBe('INVALID_ARGUMENT');
    expect(record(w, 'grantNo')).toBeUndefined();
    expect(w.suggestion(id)['status']).toBe('proposed');
  });

  it('a person’s edit of the fact clears its citations; other facts keep theirs', async () => {
    const w = world();
    await accepted(w, fact('grantNo', 'G-2026-77'));
    await accepted(w, fact('willDate', '2019-05-03'));
    const before = { ...w.doc(`${M}/m1`) } as Data;
    // As the Key facts card writes it: the whole estate object, with the new grant number.
    await w.store.db.doc(`${M}/m1`).update({ estate: { grantNo: 'G-2026-99' }, updatedBy: 'user-paralegal' });
    expect(await cleanUp(w, before)).toEqual(['grantNo']);
    expect(record(w, 'grantNo')).toBeUndefined();
    expect(record(w, 'willDate')).toBeDefined();
    // Clearing the fact clears them too.
    const again = { ...w.doc(`${M}/m1`) } as Data;
    await w.store.db.doc(`${M}/m1`).update({ facts: {} });
    expect(await cleanUp(w, again)).toEqual(['willDate']);
    expect(record(w, 'willDate')).toBeUndefined();
  });

  it('keeps citations whose value the fact has again, and ignores writes that change no fact', async () => {
    const w = world();
    await accepted(w, fact('grantNo', 'G-2026-77'));
    const stored = { ...w.doc(`${M}/m1`) } as Data;
    // An out-of-date event: the fact read differently before, but the matter has the cited value now.
    expect(await cleanUp(w, { ...stored, estate: { grantNo: 'G-1' } })).toEqual([]);
    expect(record(w, 'grantNo')).toBeDefined();
    await w.store.db.doc(`${M}/m1`).update({ title: 'Estate of Fictional Marlowe' });
    expect(await cleanUp(w, stored)).toEqual([]);
    expect(record(w, 'grantNo')).toBeDefined();
  });

  it('leaves a destroyed matter’s tombstone alone (CORE-19)', async () => {
    const w = world();
    await accepted(w, fact('grantNo', 'G-2026-77'));
    const before = { ...w.doc(`${M}/m1`) } as Data;
    w.store.docs.set(`${M}/m1`, { ...before, estate: {}, destroyedAt: NOW });
    expect(await cleanUp(w, before)).toEqual([]);
    expect(record(w, 'grantNo')).toBeDefined();
  });
});

describe('suggestions-dismiss and metrics', () => {
  it('dismisses with a reason, audits it and counts outcomes', async () => {
    const w = world();
    const result = await w.propose([task('One'), task('Two')]);
    const [one, two] = result.created.map((c) => c.id) as [string, string];
    await w.dismiss({ suggestionId: one, reason: 'Already done' });
    expect(w.suggestion(one)).toMatchObject({
      status: 'dismissed',
      dismissReason: 'Already done',
      resolvedBy: 'user-lawyer',
    });
    expect(w.under(`orgs/${ORG}/audit`).find((a) => a['action'] === 'suggestion.dismissed')).toMatchObject({
      data: expect.objectContaining({ via: 'clerk' }),
    });
    expect((await failure(w.dismiss({ suggestionId: one }))).details['code']).toBe('ALREADY_RESOLVED');
    await w.accept({ suggestionId: two });
    const values = w.doc(`orgs/${ORG}/metrics/clerk-2026-10`)?.['values'] as Record<string, number>;
    expect(values['suggestions.kind.task.accepted']).toBe(1);
    expect(values['suggestions.prompt.suggest-tasks@1.2.0.accepted']).toBe(1);
  });

  it('acceptance rates come out per kind and prompt version', () => {
    const rates = suggestionAcceptanceRates({
      'suggestions.accepted': 3,
      'suggestions.dismissed': 1,
      'suggestions.kind.task.accepted': 2,
      'suggestions.kind.task.edited': 1,
      'suggestions.kind.task.dismissed': 1,
      'suggestions.prompt.suggest-tasks@1.2.0.accepted': 3,
      'suggestions.proposed': 9,
    });
    expect(rates['all']?.rate).toBe(0.75);
    expect(rates['kind.task']?.rate).toBe(0.75);
    expect(rates['prompt.suggest-tasks@1.2.0']?.rate).toBe(1);
  });
});

describe('expireSuggestions', () => {
  it('expires open suggestions past expiresAt, once', async () => {
    const w = world();
    const result = await w.propose([task('One'), task('Two')]);
    const [one, two] = result.created.map((c) => c.id) as [string, string];
    await w.dismiss({ suggestionId: two });
    w.clock.advance(14 * 86_400_000 + 1);
    expect((await expireSuggestions(w.store.db, w.clock, w.log)).expired).toBe(1);
    expect(w.suggestion(one)).toMatchObject({ status: 'expired', resolvedBy: 'system' });
    expect(w.suggestion(two)['status']).toBe('dismissed');
    expect((await expireSuggestions(w.store.db, w.clock, w.log)).expired).toBe(0);
  });
});

it('hashString is stable', () => {
  expect(hashString('')).toBe(hashString(''));
  expect(hashString('a')).not.toBe(hashString('b'));
});
