import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { DUPLICATE_THRESHOLD, type Role } from '@materia/domain';

import { createDefinition, normaliseContact } from './create';
import { contactReferences, deleteDefinition } from './delete';
import { findDuplicatesDefinition, MAX_MATCHES } from './find-duplicates';
import {
  continueMerge,
  mergeDefinition,
  mergedContactFields,
  REPOINT_IN_CALL,
  REPOINT_PER_TASK,
  repointMatter,
  type ContinueMergeTask,
} from './merge';
import { maintainDerived, onWriteDefinition } from './on-write';
import { matterIdOfParty, staleDerived } from './shared';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

const enqueue = vi.hoisted(() => vi.fn(async (...args: unknown[]) => void args));
vi.mock('../core/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/tasks')>()),
  enqueue,
}));

/** Unit tests for the contacts functions (CORE-01). All people and practices are fictional. */

const ORG = 'org-a';
const C = `orgs/${ORG}/contacts`;
const M = `orgs/${ORG}/matters`;
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };

const person = (given: string, family: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  kind: 'person',
  givenNames: given,
  familyName: family,
  emails: [],
  phones: [],
  addresses: [],
  tags: [],
  isReferrer: false,
  search: [],
  dedupeKey: '',
  sortName: '',
  ...extra,
});
const matter = (title: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  title,
  clientContactIds: ['c-other'],
  ...extra,
});
const party = (matterId: string, contactId: string, role: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId,
  contactId,
  role,
  ...extra,
});

function world(initial: Record<string, Record<string, unknown>> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', retentionYears: 7 },
    ...initial,
  });
  const clock = new FakeClock(new Date('2026-10-04T01:00:00.000Z'));
  const logs: string[] = [];
  const log = createLog({ fn: 'test' }, (_severity, message) => logs.push(message));
  const ctx = <T>(input: T, role: Role = 'owner', uid = 'user-owner') => ({
    input,
    uid,
    orgId: ORG,
    role,
    token: {},
    requestId: randomUUID(),
    log,
    clock,
    db: store.db,
    ports: fakePorts(),
    auth: () => {
      throw new Error('no auth in these tests');
    },
  });
  const doc = (path: string) => store.docs.get(path);
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => fakePorts(),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  return { ...store, clock, log, logs, ctx, doc, deps };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a failure');
};

beforeEach(() => {
  clearRetentionCache();
  enqueue.mockClear();
});

describe('contacts-onWrite', () => {
  const trigger = (w: ReturnType<typeof world>, path: string) => {
    const snap = w.doc(path) ? { ref: { path }, data: () => w.doc(path) } : undefined;
    const change = { before: undefined, after: snap } as unknown as TriggerChange;
    const ctx = {
      eventId: 'e1',
      time: new Date(),
      params: { orgId: ORG, contactId: path.split('/').at(-1) },
      log: w.log,
      clock: w.clock,
      db: w.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return maintainDerived(change, ctx);
  };

  it('writes search, dedupeKey and sortName when they are stale, then is a no-op (no loop)', async () => {
    const w = world({ [`${C}/c1`]: person('Zoë', "O'Hara", { dateOfBirth: '1950-02-03', updatedBy: 'user-x' }) });
    expect(await trigger(w, `${C}/c1`)).toBe('updated');
    const stored = w.doc(`${C}/c1`);
    expect(stored).toMatchObject({
      dedupeKey: 'person:ohara zoe|1950-02-03',
      sortName: 'zoe ohara',
      updatedBy: 'user-x',
    });
    expect(stored?.['search']).toEqual(expect.arrayContaining(['oh', 'ohara', 'zo', 'zoe']));
    expect(await trigger(w, `${C}/c1`)).toBe('unchanged');
  });

  it('follows a name change and ignores deletes', async () => {
    const w = world({ [`${C}/c1`]: person('Ada', 'Quill') });
    await trigger(w, `${C}/c1`);
    await w.db.doc(`${C}/c1`).update({ familyName: 'Quillon' });
    expect(await trigger(w, `${C}/c1`)).toBe('updated');
    expect(w.doc(`${C}/c1`)?.['sortName']).toBe('ada quillon');
    expect(await trigger(w, `${C}/missing`)).toBe('deleted');
    expect(onWriteDefinition).toMatchObject({
      name: 'contacts-onWrite',
      document: 'orgs/{orgId}/contacts/{contactId}',
    });
  });

  it('renames a client or the deceased on the matters naming them, leaving a destroyed one alone (SEC-07d)', async () => {
    const matter = (extra: Record<string, unknown>) => ({
      ...meta,
      number: 'M-2026-0001',
      title: 'Estate of Fictional Wren',
      clientContactIds: ['c1', 'c2'],
      clientNames: ['Ada Quill', 'Ben Lark'],
      deletedAt: null,
      ...extra,
    });
    const w = world({
      [`${C}/c1`]: person('Ada', 'Quillon'),
      [`${C}/c2`]: person('Ben', 'Lark'),
      [`${M}/m1`]: matter({}),
      [`${M}/m2`]: matter({ clientContactIds: ['c2'], clientNames: ['Ben Lark'], deceased: { contactId: 'c1' } }),
      [`${M}/m3`]: matter({ clientContactIds: ['c2'], clientNames: ['Ben Lark'] }),
      [`${M}/m4`]: { ...meta, clientContactIds: ['c1'], clientNames: ['Ada Quill'], destroyedAt: new Date() },
    });
    const change = (before: Record<string, unknown>) =>
      ({
        before: { ref: { path: `${C}/c1` }, data: () => before },
        after: { ref: { path: `${C}/c1` }, data: () => w.doc(`${C}/c1`) },
      }) as unknown as TriggerChange;
    const ctx = {
      eventId: 'e1',
      time: new Date(),
      params: { orgId: ORG, contactId: 'c1' },
      log: w.log,
      clock: w.clock,
      db: w.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;

    await onWriteDefinition.handler(change(person('Ada', 'Quill')), ctx);
    expect(w.doc(`${M}/m1`)?.['clientNames']).toEqual(['Ada Quillon', 'Ben Lark']);
    expect(w.doc(`${M}/m1`)?.['search']).toEqual(expect.arrayContaining(['quillon']));
    // The deceased's name is in the search; the clients' names are not theirs.
    expect(w.doc(`${M}/m2`)?.['search']).toEqual(expect.arrayContaining(['quillon']));
    expect(w.doc(`${M}/m2`)?.['clientNames']).toEqual(['Ben Lark']);
    expect(w.doc(`${M}/m3`)?.['search']).toBeUndefined();
    expect(w.doc(`${M}/m4`)?.['clientNames']).toEqual(['Ada Quill']);

    // A write that leaves the name alone touches no matter.
    await w.db.doc(`${M}/m1`).update({ clientNames: ['stale'] });
    await onWriteDefinition.handler(change(person('Ada', 'Quillon')), ctx);
    expect(w.doc(`${M}/m1`)?.['clientNames']).toEqual(['stale']);
  });

  it('reports exactly which derived fields are stale', () => {
    expect(staleDerived({ kind: 'organisation', orgName: 'Acme', search: ['ac', 'acm', 'acme'] } as never)).toEqual({
      dedupeKey: 'org:acme',
      sortName: 'acme',
    });
  });
});

describe('contacts-create', () => {
  const contact = {
    kind: 'person' as const,
    givenNames: '  Ada ',
    familyName: 'Quill',
    emails: [
      { type: 'personal' as const, address: 'ada.quill@example.test' },
      { type: 'work' as const, address: 'ADA.QUILL@example.test' },
    ],
    phones: [
      { type: 'mobile' as const, number: '+61412345678' },
      { type: 'home' as const, number: '+61412345678' },
    ],
    addresses: [],
    tags: ['client', ' client '],
    isReferrer: false,
  };

  it('writes the contact with meta, the request id and its derived fields', async () => {
    const w = world();
    const ctx = w.ctx({ requestId: randomUUID(), contact }, 'paralegal', 'user-para');
    const { contactId } = await createDefinition.handler(ctx as never);
    const stored = w.doc(`${C}/${contactId}`);
    expect(stored).toMatchObject({
      kind: 'person',
      givenNames: 'Ada',
      familyName: 'Quill',
      emails: [{ type: 'personal', address: 'ada.quill@example.test' }],
      phones: [{ type: 'mobile', number: '+61412345678' }],
      tags: ['client'],
      createdBy: 'user-para',
      updatedBy: 'user-para',
      schemaVersion: 1,
      _requestId: ctx.requestId,
      dedupeKey: 'person:ada quill|',
      sortName: 'ada quill',
    });
    expect(stored?.['search']).toContain('quill');
    expect(stored).not.toHaveProperty('mergedInto');
  });

  it('re-validates phone numbers and requires a name, with field paths', () => {
    expect(() => normaliseContact({ ...contact, phones: [{ type: 'mobile', number: '+6100000' }] } as never)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        details: { fields: { 'contact.phones.0.number': expect.any(Array) } },
      }),
    );
    expect(() => normaliseContact({ ...contact, givenNames: ' ', familyName: undefined } as never)).toThrow(
      expect.objectContaining({ details: { fields: { 'contact.familyName': ['Enter a name'] } } }),
    );
    expect(() => normaliseContact({ ...contact, kind: 'organisation', orgName: '' } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('is limited to contact.edit roles and needs a requestId (wrapper)', async () => {
    const w = world();
    const call = (role: Role, data: Record<string, unknown>) =>
      runCallable(createDefinition, { data, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } }, w.deps());
    const denied = (await failureOf(call('readonly', { requestId: randomUUID(), contact }))) as HttpsError;
    expect(denied.details).toMatchObject({ code: 'PERMISSION_DENIED' });
    const noId = (await failureOf(call('lawyer', { contact }))) as HttpsError;
    expect(noId.details).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // Server-owned fields are not accepted from the client.
    const sneaky = (await failureOf(
      call('lawyer', { requestId: randomUUID(), contact: { ...contact, mergedInto: 'c-x', sortName: 'a' } }),
    )) as HttpsError;
    expect(sneaky.details).toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(call('lawyer', { requestId: randomUUID(), contact })).resolves.toEqual({
      contactId: expect.any(String),
    });
  });
});

describe('contacts-findDuplicates', () => {
  const seeded = () =>
    world({
      [`${C}/c-john`]: person('John', 'Smith', {
        dateOfBirth: '1950-01-02',
        emails: [{ type: 'personal', address: 'john.smith@example.test' }],
        phones: [{ type: 'mobile', number: '+61412000001' }],
      }),
      [`${C}/c-jon`]: person('Jon', 'Smith', { dateOfBirth: '1950-01-02' }),
      [`${C}/c-jane`]: person('Jane', 'Smith', { dateOfBirth: '1972-06-30' }),
      [`${C}/c-deleted`]: person('John', 'Smith', { dateOfBirth: '1950-01-02', deletedAt: new Date() }),
      [`${C}/c-merged`]: person('John', 'Smith', { dateOfBirth: '1950-01-02', mergedInto: 'c-john' }),
      [`${C}/c-acme`]: {
        ...person('', ''),
        kind: 'organisation',
        orgName: 'Acme Holdings Pty Ltd',
        abn: '51824753556',
      },
    });

  it('returns live contacts at or above the threshold, best first, with display details', async () => {
    const w = seeded();
    const { matches } = await findDuplicatesDefinition.handler(
      w.ctx({
        kind: 'person',
        givenNames: 'John',
        familyName: 'Smith',
        dateOfBirth: '1950-01-02',
        emails: [],
        phones: [],
      }) as never,
    );
    expect(matches.map((m) => m.contactId)).toEqual(['c-john', 'c-jon']);
    expect(matches[0]).toMatchObject({
      displayName: 'John Smith',
      dateOfBirth: '1950-01-02',
      email: 'john.smith@example.test',
      phone: '+61412000001',
      reasons: expect.arrayContaining(['name', 'dateOfBirth']),
    });
    expect(matches.every((m) => m.score >= DUPLICATE_THRESHOLD)).toBe(true);
    expect(matches[0]?.score).toBeGreaterThanOrEqual(matches[1]?.score ?? 0);
    expect(matches[1]).not.toHaveProperty('email');
  });

  it('matches organisations by ABN and returns nothing for an empty probe', async () => {
    const w = seeded();
    const org = await findDuplicatesDefinition.handler(
      w.ctx({ kind: 'organisation', orgName: 'Acme Holdings', abn: '51 824 753 556', emails: [], phones: [] }) as never,
    );
    expect(org.matches.map((m) => m.contactId)).toEqual(['c-acme']);
    const none = await findDuplicatesDefinition.handler(w.ctx({ kind: 'person', emails: [], phones: [] }) as never);
    expect(none.matches).toEqual([]);
  });

  it(`returns at most ${MAX_MATCHES}`, async () => {
    const many: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 8; i++) many[`${C}/c-${i}`] = person('Ada', 'Quill', { dateOfBirth: '1960-01-01' });
    const w = world(many);
    const { matches } = await findDuplicatesDefinition.handler(
      w.ctx({ kind: 'person', givenNames: 'Ada', familyName: 'Quill', emails: [], phones: [] }) as never,
    );
    expect(matches).toHaveLength(MAX_MATCHES);
  });
});

describe('contacts-merge', () => {
  const KEEP = 'c-keep';
  const MERGE = 'c-merge';
  const mergeWorld = (extra: Record<string, Record<string, unknown>> = {}) =>
    world({
      [`${C}/${KEEP}`]: person('Ada', 'Quill', {
        emails: [{ type: 'personal', address: 'ada@example.test' }],
        phones: [{ type: 'mobile', number: '+61412000001' }],
        addresses: [
          {
            type: 'residential',
            line1: '1 Example St',
            suburb: 'Geelong',
            state: 'VIC',
            postcode: '3220',
            country: 'AU',
          },
        ],
        tags: ['client'],
      }),
      [`${C}/${MERGE}`]: person('Ada', 'Quil', {
        dateOfBirth: '1960-01-01',
        preferredName: 'Addy',
        notes: 'Prefers email',
        isReferrer: true,
        emails: [
          { type: 'work', address: 'ADA@example.test' },
          { type: 'work', address: 'ada.work@example.test' },
        ],
        phones: [
          { type: 'mobile', number: '+61412000001' },
          { type: 'work', number: '+61352000002' },
        ],
        addresses: [
          { type: 'postal', line1: '1  example st', suburb: 'Geelong', state: 'VIC', postcode: '3220', country: 'AU' },
          { type: 'postal', line1: 'PO Box 9', suburb: 'Geelong', state: 'VIC', postcode: '3220', country: 'AU' },
        ],
        tags: ['Client', 'beneficiary'],
      }),
      [`${C}/c-other`]: person('Other', 'Person'),
      [`${M}/m1`]: matter('Estate of Fictional One', {
        clientContactIds: [MERGE, KEEP, 'c-other'],
        referrerContactId: MERGE,
        deceased: { contactId: MERGE, dateOfDeath: '2026-01-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
      }),
      [`${M}/m2`]: matter('Will of Fictional Two', { testator: { contactId: MERGE } }),
      [`${M}/m3`]: matter('Unrelated matter'),
      [`${M}/m1/parties/p-keep-exec`]: party('m1', KEEP, 'executor'),
      [`${M}/m1/parties/p-merge-ben`]: party('m1', MERGE, 'beneficiary'),
      [`${M}/m1/parties/p-merge-exec`]: party('m1', MERGE, 'executor'),
      [`${M}/m2/parties/p-merge-test`]: party('m2', MERGE, 'testator'),
      [`orgs/${ORG}/safeCustody/sc1`]: { ...meta, testatorContactId: MERGE, packetNo: 'SC-0001' },
      // Another org's party that happens to use the same contact id: never touched.
      [`orgs/org-b/matters/mb/parties/pb`]: party('mb', MERGE, 'executor', { orgId: 'org-b' }),
      ...extra,
    });

  it('folds the merged contact into the kept one and leaves a tombstone', async () => {
    const w = mergeWorld();
    const result = await mergeDefinition.handler(
      w.ctx({ requestId: randomUUID(), keepId: KEEP, mergeId: MERGE }) as never,
    );
    expect(result).toEqual({ repointed: 6, queued: false });
    const keep = w.doc(`${C}/${KEEP}`);
    expect(keep).toMatchObject({
      givenNames: 'Ada',
      familyName: 'Quill',
      preferredName: 'Addy',
      dateOfBirth: '1960-01-01',
      notes: 'Prefers email',
      isReferrer: true,
      tags: ['client', 'beneficiary'],
      updatedBy: 'user-owner',
      sortName: 'addy quill',
      dedupeKey: 'person:ada quill|1960-01-01',
    });
    expect((keep?.['emails'] as { address: string }[]).map((e) => e.address)).toEqual([
      'ada@example.test',
      'ada.work@example.test',
    ]);
    expect((keep?.['phones'] as { number: string }[]).map((p) => p.number)).toEqual(['+61412000001', '+61352000002']);
    expect((keep?.['addresses'] as { line1: string }[]).map((a) => a.line1)).toEqual(['1 Example St', 'PO Box 9']);
    expect(w.doc(`${C}/${MERGE}`)).toMatchObject({ mergedInto: KEEP, deletedBy: 'user-owner' });
    expect(w.doc(`${C}/${MERGE}`)?.['deletedAt']).toBeDefined();
  });

  it('re-points parties, matters (client, referrer, deceased, testator) and safe custody in the org', async () => {
    const w = mergeWorld();
    const ctx = w.ctx({ requestId: randomUUID(), keepId: KEEP, mergeId: MERGE });
    await mergeDefinition.handler(ctx as never);
    expect(w.doc(`${M}/m1`)).toMatchObject({
      clientContactIds: [KEEP, 'c-other'],
      referrerContactId: KEEP,
      deceased: { contactId: KEEP, dateOfDeath: '2026-01-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
      updatedBy: 'user-owner',
      _requestId: ctx.requestId,
    });
    expect(w.doc(`${M}/m2`)).toMatchObject({ testator: { contactId: KEEP } });
    expect(w.doc(`${M}/m3`)).toMatchObject({ updatedBy: 'seed' });
    expect(w.doc(`orgs/${ORG}/safeCustody/sc1`)).toMatchObject({ testatorContactId: KEEP });
    expect(w.doc(`orgs/org-b/matters/mb/parties/pb`)).toMatchObject({ contactId: MERGE });
    // Both contacts on m1 in different roles: both rows stay, both point at the kept contact.
    expect(w.doc(`${M}/m1/parties/p-merge-ben`)).toMatchObject({ contactId: KEEP, role: 'beneficiary' });
    expect(w.doc(`${M}/m1/parties/p-merge-ben`)).not.toHaveProperty('deletedAt');
    expect(w.doc(`${M}/m1/parties/p-keep-exec`)).toMatchObject({ contactId: KEEP, role: 'executor' });
    // The same role twice would be a duplicate row: it is re-pointed and soft-deleted.
    expect(w.doc(`${M}/m1/parties/p-merge-exec`)).toMatchObject({ contactId: KEEP, deletedBy: 'user-owner' });
    expect(w.doc(`${M}/m2/parties/p-merge-test`)).toMatchObject({ contactId: KEEP });
  });

  it('writes a contact.merged audit entry', async () => {
    const w = mergeWorld();
    const ctx = w.ctx({ requestId: randomUUID(), keepId: KEEP, mergeId: MERGE });
    await mergeDefinition.handler(ctx as never);
    const entries = [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[1]).toMatchObject({
      action: 'contact.merged',
      entity: { path: `${C}/${KEEP}`, collection: 'contacts', id: KEEP },
      requestId: ctx.requestId,
      data: { keepId: KEEP, mergeId: MERGE, repointed: 6, queued: false, resumed: false },
      source: 'callable',
    });
  });

  it('is re-runnable: a second call resumes the re-pointing without merging twice', async () => {
    const w = mergeWorld();
    await mergeDefinition.handler(w.ctx({ requestId: randomUUID(), keepId: KEEP, mergeId: MERGE }) as never);
    // A reference added to the tombstone afterwards (say, by an offline client) is picked up.
    await w.db.doc(`${M}/m3/parties/p-late`).set(party('m3', MERGE, 'witness'));
    const again = await mergeDefinition.handler(
      w.ctx({ requestId: randomUUID(), keepId: KEEP, mergeId: MERGE }) as never,
    );
    expect(again).toEqual({ repointed: 1, queued: false });
    expect(w.doc(`${M}/m3/parties/p-late`)).toMatchObject({ contactId: KEEP });
    expect(w.doc(`${C}/${KEEP}`)?.['tags']).toEqual(['client', 'beneficiary']);
  });

  it('refuses a missing, merged-elsewhere or different-kind contact', async () => {
    const w = mergeWorld({
      [`${C}/c-tomb`]: person('Old', 'Record', { mergedInto: 'c-other', deletedAt: new Date() }),
      [`${C}/c-org`]: { ...person('', ''), kind: 'organisation', orgName: 'Acme' },
    });
    const run = (keepId: string, mergeId: string) =>
      failureOf(mergeDefinition.handler(w.ctx({ requestId: randomUUID(), keepId, mergeId }) as never));
    expect((await run('c-missing', MERGE)).code).toBe('NOT_FOUND');
    expect((await run(KEEP, 'c-missing')).code).toBe('NOT_FOUND');
    expect((await run('c-tomb', MERGE)).code).toBe('NOT_FOUND');
    expect(await run(KEEP, 'c-tomb')).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'already_merged' },
    });
    expect(await run(KEEP, 'c-org')).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'kind_mismatch' },
    });
  });

  it('is limited to contact.merge roles and needs two different contacts (wrapper)', async () => {
    const w = mergeWorld();
    const call = (role: Role, data: Record<string, unknown>) =>
      runCallable(mergeDefinition, { data, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } }, w.deps());
    for (const role of ['lawyer', 'paralegal', 'readonly'] as const) {
      const error = (await failureOf(
        call(role, { requestId: randomUUID(), keepId: KEEP, mergeId: MERGE }),
      )) as HttpsError;
      expect(error.details).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    const same = (await failureOf(
      call('admin', { requestId: randomUUID(), keepId: KEEP, mergeId: KEEP }),
    )) as HttpsError;
    expect(same.details).toMatchObject({ code: 'INVALID_ARGUMENT', fields: { mergeId: expect.any(Array) } });
  });

  it('re-points 600 references: 200 in the call, the rest through queued tasks', async () => {
    const extra: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 600; i++) {
      const matterId = `fan-${String(Math.floor(i / 3)).padStart(3, '0')}`;
      extra[`${M}/${matterId}/parties/p-${String(i).padStart(3, '0')}`] = party(matterId, 'c-big', `role-${i % 3}`);
    }
    const w = world({ [`${C}/c-keep`]: person('Ada', 'Quill'), [`${C}/c-big`]: person('Ada', 'Quil'), ...extra });
    const ctx = w.ctx({ requestId: randomUUID(), keepId: 'c-keep', mergeId: 'c-big' });
    const result = await mergeDefinition.handler(ctx as never);
    expect(result).toEqual({ repointed: REPOINT_IN_CALL, queued: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [queueName, firstTask] = enqueue.mock.calls[0] as [string, ContinueMergeTask, { dedupeKey: string }];
    expect(queueName).toBe('contacts-continueMerge');
    expect(firstTask).toEqual({
      orgId: ORG,
      keepId: 'c-keep',
      mergeId: 'c-big',
      uid: 'user-owner',
      requestId: ctx.requestId,
      round: 1,
    });

    // Drain the queue synchronously, as Cloud Tasks would.
    const queue: ContinueMergeTask[] = [firstTask];
    const totals: number[] = [];
    while (queue.length) {
      const task = queue.shift() as ContinueMergeTask;
      const page = await continueMerge(task, {
        db: w.db,
        log: w.log,
        clock: w.clock,
        enqueueNext: async (next) => void queue.push(next),
      });
      totals.push(page.repointed);
    }
    expect(totals).toEqual([REPOINT_PER_TASK, 0]);
    const parties = [...w.docs.entries()].filter(([path]) => path.includes('/parties/p-'));
    expect(parties).toHaveLength(600);
    expect(parties.every(([, data]) => data['contactId'] === 'c-keep')).toBe(true);
    expect(parties.every(([, data]) => data['_requestId'] === ctx.requestId)).toBe(true);
  });
});

describe('merge helpers', () => {
  it('repointMatter replaces and de-duplicates, and returns null when nothing points at the contact', () => {
    expect(repointMatter({ clientContactIds: ['a', 'b'] }, 'a', 'b')).toEqual({ clientContactIds: ['b'] });
    expect(repointMatter({ clientContactIds: ['x'], testator: { contactId: 'y' } }, 'a', 'b')).toBeNull();
  });

  it('mergedContactFields keeps the kept values and fills the gaps', () => {
    const fields = mergedContactFields({ givenNames: 'Ada', notes: 'Keep me' }, {
      givenNames: 'Adeline',
      familyName: 'Quill',
      notes: 'Not me',
    } as never);
    expect(fields).toMatchObject({
      familyName: 'Quill',
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: false,
    });
    expect(fields).not.toHaveProperty('givenNames');
    expect(fields).not.toHaveProperty('notes');
  });

  it('matterIdOfParty only accepts this org’s matter parties', () => {
    expect(matterIdOfParty(`orgs/${ORG}/matters/m1/parties/p1`, ORG)).toBe('m1');
    expect(matterIdOfParty(`orgs/org-b/matters/m1/parties/p1`, ORG)).toBeNull();
    expect(matterIdOfParty(`orgs/${ORG}/parties/p1`, ORG)).toBeNull();
  });

  it('re-reads and retries a page when a matter changed between the read and the write', async () => {
    const w = world({ [`${M}/m1`]: { title: 'Fictional estate', clientContactIds: ['b', 'c-other'] } });
    const batch = w.db.batch.bind(w.db);
    // The first commit finds the matter changed (its lastUpdateTime precondition fails).
    vi.spyOn(w.db, 'batch').mockImplementationOnce(() =>
      Object.assign(batch(), {
        commit: async () => {
          throw Object.assign(new Error('Fictional stale write'), { code: 9 });
        },
      }),
    );
    const task = { orgId: ORG, keepId: 'a', mergeId: 'b', uid: 'u', requestId: 'r', round: 1 };
    await expect(continueMerge(task, { db: w.db, log: w.log, enqueueNext: vi.fn() })).resolves.toEqual({
      repointed: 1,
      more: false,
    });
    expect(w.doc(`${M}/m1`)).toMatchObject({ clientContactIds: ['a', 'c-other'] });
    expect(w.logs).toContain('a matter changed while re-pointing, retrying');
  });

  it('stops a runaway task chain', async () => {
    const w = world();
    const enqueueNext = vi.fn(async () => undefined);
    const task = { orgId: ORG, keepId: 'a', mergeId: 'b', uid: 'u', requestId: 'r', round: 1000 };
    // Nothing to re-point: done, nothing queued.
    await expect(continueMerge(task, { db: w.db, log: w.log, enqueueNext })).resolves.toEqual({
      repointed: 0,
      more: false,
    });
    expect(enqueueNext).not.toHaveBeenCalled();
  });
});

describe('contacts-delete', () => {
  const deleteWorld = () =>
    world({
      [`${C}/c-used`]: person('Ada', 'Quill'),
      [`${C}/c-free`]: person('Free', 'Person'),
      [`${C}/c-gone`]: person('Gone', 'Person', { deletedAt: new Date() }),
      [`${C}/c-ghost`]: person('Ghost', 'Party'),
      [`${M}/m1`]: matter('Estate of Fictional One', { clientContactIds: ['c-used'] }),
      [`${M}/m2`]: matter('Will of Fictional Two', { referrerContactId: 'c-used' }),
      [`${M}/m3`]: matter('Deleted matter', { clientContactIds: ['c-free'], deletedAt: new Date() }),
      [`${M}/m4`]: matter('Probate of Fictional Four'),
      [`${M}/m4/parties/p1`]: party('m4', 'c-used', 'executor'),
      [`${M}/m4/parties/p2`]: party('m4', 'c-free', 'witness', { deletedAt: new Date() }),
      [`${M}/m3/parties/p3`]: party('m3', 'c-ghost', 'witness'),
      [`orgs/${ORG}/safeCustody/sc1`]: { ...meta, testatorContactId: 'c-used', packetNo: 'SC-0001' },
    });

  it('refuses while referenced, listing the matters, roles and safe custody packets', async () => {
    const w = deleteWorld();
    const error = await failureOf(
      deleteDefinition.handler(w.ctx({ requestId: randomUUID(), contactId: 'c-used' }, 'lawyer') as never),
    );
    expect(error).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'contact_referenced', contactId: 'c-used' },
    });
    expect(error.details?.['references']).toEqual(
      expect.arrayContaining([
        { matterId: 'm4', matterTitle: 'Probate of Fictional Four', role: 'executor' },
        { matterId: 'm1', matterTitle: 'Estate of Fictional One', role: 'client' },
        { matterId: 'm2', matterTitle: 'Will of Fictional Two', role: 'referrer' },
        { matterId: '', matterTitle: 'SC-0001', role: 'safe_custody', safeCustodyId: 'sc1' },
      ]),
    );
    expect(w.doc(`${C}/c-used`)).not.toHaveProperty('deletedAt');
  });

  it('soft deletes when only deleted matters and party rows reference the contact', async () => {
    const w = deleteWorld();
    expect(await contactReferences(w.db, ORG, 'c-ghost')).toEqual([]);
    const ctx = w.ctx({ requestId: randomUUID(), contactId: 'c-free' }, 'lawyer', 'user-lawyer');
    await expect(deleteDefinition.handler(ctx as never)).resolves.toEqual({ deleted: true });
    expect(w.doc(`${C}/c-free`)).toMatchObject({
      deletedBy: 'user-lawyer',
      updatedBy: 'user-lawyer',
      _requestId: ctx.requestId,
    });
  });

  it('is a no-op for an already deleted contact and NOT_FOUND for a missing one', async () => {
    const w = deleteWorld();
    await expect(
      deleteDefinition.handler(w.ctx({ requestId: randomUUID(), contactId: 'c-gone' }) as never),
    ).resolves.toEqual({ deleted: true });
    expect(
      (await failureOf(deleteDefinition.handler(w.ctx({ requestId: randomUUID(), contactId: 'c-none' }) as never)))
        .code,
    ).toBe('NOT_FOUND');
  });

  it('is limited to contact.delete roles (wrapper)', async () => {
    const w = deleteWorld();
    const error = (await failureOf(
      runCallable(
        deleteDefinition,
        {
          data: { requestId: randomUUID(), contactId: 'c-free' },
          auth: { uid: 'p', token: { orgId: ORG, role: 'paralegal' } },
        },
        w.deps(),
      ),
    )) as HttpsError;
    expect(error.details).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
