import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { intakeFormSchema, intakeToCreateMatterInput, type CreateMatterResult, type Role } from '@materia/domain';

import { createMatterDefinition, intakeEvents, intakeFeeAndDisclosure, intakeParties } from './create';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the CORE-05 intake extension of matters-createMatter. Everyone here is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters`;
const C = `orgs/${ORG}/contacts`;
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const person = (given: string, family: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  kind: 'person',
  givenNames: given,
  familyName: family,
  ...extra,
});
const member = (role: Role) => ({ ...meta, role, status: 'active' });

function world({ templates = false } = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Bayside Legal',
      retentionYears: 7,
      timezone: 'Australia/Melbourne',
      flags: { 'templates.system': templates },
    },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal'),
    [`${C}/c-ada`]: person('Ada', 'Quill'),
    [`${C}/c-bertram`]: person('Bertram', 'Quill', { dateOfBirth: '1941-02-03' }),
    [`${C}/c-cora`]: person('Cora', 'Vane'),
    [`${C}/c-dora`]: person('Dora', 'Quill'),
    [`${C}/c-gone`]: person('Gone', 'Away', { deletedAt: new Date('2026-01-01T00:00:00Z') }),
    [`orgs/${ORG}/conflictChecks/chk-1`]: { ...meta, subjects: [], hits: [] },
  });
  // 11:00 on 4 October 2026 in Melbourne.
  const clock = new FakeClock(new Date('2026-10-04T01:00:00.000Z'));
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
  const call = (data: Record<string, unknown>, role: Role = 'lawyer') =>
    runCallable(
      createMatterDefinition,
      { data, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(),
    ) as Promise<CreateMatterResult>;
  const under = (matterId: string, sub: string) =>
    [...store.docs.entries()]
      .filter(([path]) => path.startsWith(`${M}/${matterId}/${sub}/`))
      .map(([path, data]): Record<string, unknown> & { id: string } => ({
        ...data,
        id: path.split('/').at(-1) as string,
      }));
  const paths = () => [...store.docs.keys()];
  return { ...store, call, under, paths, doc: (path: string) => store.docs.get(path) };
}

const form = intakeFormSchema({ today: () => '2026-10-04' as never });
const probateForm = (details: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  form.parse({
    type: { type: 'probate' },
    clients: { clientContactIds: ['c-ada'] },
    details: {
      type: 'probate',
      deceasedContactId: 'c-bertram',
      dateOfDeath: '2026-08-01',
      domicile: 'VIC',
      willExists: true,
      willDate: '2019-03-14',
      ...details,
    },
    parties: {
      parties: [
        { contactId: 'c-ada', role: 'executor' },
        { contactId: 'c-dora', role: 'beneficiary', share: 'Residue' },
      ],
    },
    fees: { fee: { arrangement: 'fixed', amountCents: 330000 } },
    conflict: { checkId: 'chk-1', status: 'clear' },
    review: { title: 'Estate of Bertram Quill', responsibleUid: 'user-lawyer' },
    ...extra,
  });
const intake = (f = probateForm()) => intakeToCreateMatterInput(f, randomUUID()) as unknown as Record<string, unknown>;

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpsError).details as Record<string, unknown>;
  }
  throw new Error('expected a failure');
};

beforeEach(() => {
  clearRetentionCache();
  setRemoteFlagLoader(async () => ({}));
});
afterEach(() => clearFlagCaches());

describe('matters-createMatter intake (CORE-05)', () => {
  it('creates the matter, every party row, the date of death event, fee, disclosure and conflict link', async () => {
    const w = world();
    const { matterId, status } = await w.call(intake());
    expect(status).toBe('open');
    const matter = w.doc(`${M}/${matterId}`);
    expect(matter).toMatchObject({
      fee: { arrangement: 'fixed', amountCents: 330000, history: [] },
      costsDisclosure: { status: 'required', estimateCents: 330000 },
      conflictCheck: { status: 'clear', resultId: 'chk-1', checkedBy: 'user-lawyer' },
      deceased: { contactId: 'c-bertram', dateOfDeath: '2026-08-01' },
      facts: { willDate: '2019-03-14' },
      estate: { grantType: 'probate' },
      openTaskCount: 0,
    });
    expect(
      w
        .under(matterId, 'parties')
        .map((p) => p.id)
        .sort(),
    ).toEqual(['beneficiary-c-dora', 'client-c-ada', 'deceased-c-bertram', 'executor-c-ada']);
    expect(w.doc(`${M}/${matterId}/parties/beneficiary-c-dora`)).toMatchObject({
      share: 'Residue',
      orgId: ORG,
      matterId,
    });
    expect(w.under(matterId, 'events')).toEqual([
      expect.objectContaining({ kind: 'date_of_death', date: '2026-08-01', label: 'Date of death' }),
    ]);
    expect(w.under(matterId, 'tasks')).toEqual([]);
  });

  it('with an unknown date of death: no event, one death certificate task (also with the template on)', async () => {
    const off = world();
    const a = await off.call(intake(probateForm({ dateOfDeath: 'unknown' })));
    expect(off.doc(`${M}/${a.matterId}`)?.['deceased']).toEqual({
      contactId: 'c-bertram',
      domicile: 'VIC',
      lastAddress: '',
    });
    expect(off.under(a.matterId, 'events')).toEqual([]);
    expect(off.under(a.matterId, 'tasks')).toEqual([
      expect.objectContaining({
        id: 'tpl-obtain_death_certificate',
        title: 'Obtain the death certificate',
        templateTaskKey: 'obtain_death_certificate',
        assigneeUid: 'user-paralegal',
      }),
    ]);
    expect(off.doc(`${M}/${a.matterId}`)).toMatchObject({ openTaskCount: 1 });

    clearFlagCaches(); // the flag is cached per org id, which both worlds share
    const on = world({ templates: true });
    const b = await on.call(intake(probateForm({ dateOfDeath: 'unknown' })));
    const tasks = on.under(b.matterId, 'tasks');
    expect(tasks.filter((t) => t.id === 'tpl-obtain_death_certificate')).toHaveLength(1);
    // The probate template's own task (due 14 days after the stage is entered).
    expect(on.doc(`${M}/${b.matterId}/tasks/tpl-obtain_death_certificate`)).toMatchObject({
      source: 'template',
      dueDate: '2026-10-18',
    });
    expect(on.doc(`${M}/${b.matterId}/tasks/tpl-notify_centrelink`)).toMatchObject({ duePending: 'date_of_death' });
    expect(on.doc(`${M}/${b.matterId}`)).toMatchObject({ openTaskCount: tasks.length, stageId: 'instructions' });
  });

  it('adds the death certificate task an administration template lacks', async () => {
    const w = world({ templates: true });
    const f = probateForm({ type: 'admin', dateOfDeath: 'unknown' }, { type: { type: 'admin' } });
    const { matterId } = await w.call(intake(f));
    expect(w.doc(`${M}/${matterId}/tasks/tpl-obtain_death_certificate`)).toMatchObject({ source: 'manual' });
    expect(w.doc(`${M}/${matterId}/tasks/tpl-notify_centrelink`)).toMatchObject({ duePending: 'date_of_death' });
  });

  it('refuses a date of death in the future or before the date of birth on the contact', async () => {
    const w = world();
    const base = intake();
    const withDeath = (dateOfDeath: string) => ({
      ...base,
      matter: {
        ...(base['matter'] as object),
        deceased: { contactId: 'c-bertram', dateOfDeath, domicile: 'VIC', lastAddress: '' },
        facts: {},
      },
    });
    expect(await failureOf(w.call(withDeath('2026-10-05')))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      fields: { 'matter.deceased.dateOfDeath': ['The date of death cannot be in the future'] },
    });
    expect(await failureOf(w.call(withDeath('1941-02-02')))).toMatchObject({
      fields: { 'matter.deceased.dateOfDeath': ['The date of death cannot be before the date of birth'] },
    });
    await expect(w.call(withDeath('1941-02-03'))).resolves.toMatchObject({ status: 'open' });
  });

  it('a conflict creates a lead', async () => {
    const w = world();
    const f = probateForm(
      {},
      { conflict: { checkId: 'chk-1', status: 'conflict', reason: 'Acted for the other side' } },
    );
    expect((await w.call(intake(f))).status).toBe('lead');
  });

  it('an invalid party contact writes nothing at all', async () => {
    const w = world();
    const before = w.paths().sort();
    const f = probateForm();
    const input = {
      ...intake(f),
      parties: [
        { contactId: 'c-dora', role: 'executor' },
        { contactId: 'c-gone', role: 'beneficiary' },
        { contactId: 'c-nobody', role: 'witness' },
      ],
    };
    expect(await failureOf(w.call(input))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      fields: {
        'parties.1.contactId': ['Choose an existing contact'],
        'parties.2.contactId': ['Choose an existing contact'],
      },
    });
    expect(w.paths().sort()).toEqual(before);
  });

  it('refuses a not-required disclosure the estimate needs, and computes one when none is given', async () => {
    const w = world();
    expect(await failureOf(w.call({ ...intake(), costsDisclosure: { status: 'not_required' } }))).toMatchObject({
      fields: { 'costsDisclosure.status': ['This estimate needs a costs disclosure'] },
    });
    const { costsDisclosure: _omit, ...rest } = intake();
    void _omit;
    const { matterId } = await w.call({ ...rest, fee: { arrangement: 'fixed', amountCents: 50000 } });
    expect(w.doc(`${M}/${matterId}`)?.['costsDisclosure']).toEqual({ status: 'not_required', estimateCents: 50000 });
  });

  it('refuses an events date of death that disagrees with the deceased', async () => {
    const w = world();
    expect(
      await failureOf(w.call({ ...intake(), events: [{ kind: 'date_of_death', date: '2026-08-02' }] })),
    ).toMatchObject({
      fields: { 'events.0.date': ['Must match the date of death'] },
    });
    const { matterId } = await w.call({
      ...intake(),
      events: [
        { kind: 'date_of_death', date: '2026-08-01' },
        { kind: 'will_located', date: '2026-08-20' },
        { kind: 'will_located', date: '2026-08-20' },
      ],
    });
    expect(
      w
        .under(matterId, 'events')
        .map((e) => e['kind'])
        .sort(),
    ).toEqual(['date_of_death', 'will_located']);
  });
});

describe('intake helpers', () => {
  const matter = {
    clientContactIds: ['c-ada'],
    deceased: { contactId: 'c-bertram', domicile: 'VIC', lastAddress: '' },
  } as never;

  it('intakeParties dedupes by row id and keeps the first share', () => {
    expect(
      intakeParties(matter, [
        { contactId: 'c-ada', role: 'client', share: 'Half' },
        { contactId: 'c-ada', role: 'executor' },
        { contactId: 'c-ada', role: 'executor', notes: 'Also a beneficiary' },
      ]),
    ).toEqual([
      { contactId: 'c-ada', role: 'client', share: 'Half' },
      { contactId: 'c-bertram', role: 'deceased' },
      { contactId: 'c-ada', role: 'executor', inputIndex: 1, notes: 'Also a beneficiary' },
    ]);
  });

  it('intakeEvents needs a known date of death for a date of death event', () => {
    expect(() => intakeEvents(matter, [{ kind: 'date_of_death', date: '2026-08-01' as never }])).toThrow(
      'Invalid matter',
    );
    expect(intakeEvents(matter)).toEqual([]);
  });

  it('intakeFeeAndDisclosure needs a fee and keeps a given disclosure', () => {
    expect(() => intakeFeeAndDisclosure({ matter: {} } as never)).toThrow('Invalid matter');
    expect(
      intakeFeeAndDisclosure({
        matter: {
          fee: { arrangement: 'hourly', history: [] },
          costsDisclosure: { status: 'sent', sentOn: '2026-10-01' },
        },
      } as never),
    ).toEqual({
      fee: { arrangement: 'hourly', history: [] },
      costsDisclosure: { status: 'sent', sentOn: '2026-10-01' },
    });
    expect(intakeFeeAndDisclosure({ matter: {}, fee: { arrangement: 'hourly' } } as never).costsDisclosure).toEqual({
      status: 'required',
    });
  });
});
