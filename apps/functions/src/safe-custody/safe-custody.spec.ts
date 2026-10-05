import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import type { Role } from '@materia/domain';

import { confirmDestructionDefinition } from './confirm-destruction';
import { onTestatorWrite } from './on-contact-write';
import { receiptDefinition, receiptItems, stocktakeGroups, stocktakeReportDefinition } from './pdf';
import { receiveDefinition } from './receive';
import { recordMovementDefinition } from './record-movement';
import { updateDefinition } from './update';
import { verifyDefinition } from './verify';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { exportFileName, getExportUrlDefinition } from '../jobs/get-export-url';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts, type FakeJobRunner, type FakeSignedUrls } from '../ports/fakes';

/** Unit tests for the will safe-custody register (CORE-17). Every org, person and packet is fictional. */

const ORG = 'org-a';
const SC = `orgs/${ORG}/safeCustody`;
const C = `orgs/${ORG}/contacts`;
const M = `orgs/${ORG}/matters`;
// 11:00 on 5 October 2026 in Melbourne.
const NOW = new Date('2026-10-05T00:00:00.000Z');
const SIGNED_IN = NOW.getTime() / 1000 - 60;
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const member = (role: Role, status = 'active') => ({ ...meta, role, status, displayName: `Fictional ${role}` });
const person = (givenNames: string, familyName: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  kind: 'person',
  givenNames,
  familyName,
  emails: [],
  phones: [],
  addresses: [],
  tags: [],
  ...extra,
});
const document = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  name: 'Signed authority.pdf',
  privileged: false,
  scan: { status: 'clean' },
  version: 1,
  ...extra,
});
const AUTHORITY = { matterId: 'm-will', documentId: 'd-authority' };
const LOCATION = { site: 'Geelong', cabinet: 'Safe A', slot: '2' };
const WILL = { kind: 'will', date: '2019-02-14', description: 'Last will' };

type Data = Record<string, unknown>;

function world(initial: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', abn: '12345678901', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-owner`]: member('owner'),
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/user-lawyer2`]: member('lawyer'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal'),
    [`orgs/${ORG}/members/user-readonly`]: member('readonly'),
    [`orgs/${ORG}/members/user-gone`]: member('lawyer', 'removed'),
    [`${C}/c-wren`]: person('Ada', 'Wren', {
      addresses: [
        {
          type: 'residential',
          line1: '1 Fictional St',
          suburb: 'Geelong',
          state: 'VIC',
          postcode: '3220',
          country: 'AU',
        },
      ],
    }),
    [`${C}/c-old`]: person('Ada', 'Wren', { mergedInto: 'c-wren' }),
    [`${C}/c-firm`]: { ...meta, kind: 'organisation', orgName: 'Fictional Lakes Lawyers' },
    [`${M}/m-will`]: { ...meta, number: 'M-2026-0001', title: 'Will of Ada Wren', type: 'will', privileged: false },
    [`${M}/m-will/documents/d-authority`]: document(),
    [`${M}/m-will/documents/d-pending`]: document({ scan: { status: 'pending' } }),
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
  const call = <T>(
    def: unknown,
    data: Data,
    role: Role = 'lawyer',
    options: { uid?: string; authTime?: number } = {},
  ) =>
    runCallable(
      def as CallableDefinition<never, T>,
      {
        data: { requestId: randomUUID(), ...data },
        auth: {
          uid: options.uid ?? `user-${role}`,
          token: { orgId: ORG, role, auth_time: options.authTime ?? SIGNED_IN },
        },
      },
      deps(),
    );
  const receive = (data: Data = {}, role: Role = 'lawyer') =>
    call<{ id: string; packetNo: string }>(
      receiveDefinition,
      { testatorContactId: 'c-wren', items: [WILL], location: LOCATION, receivedOn: '2019-03-01', ...data },
      role,
    );
  const move = (id: string, data: Data, role: Role = 'lawyer', options: { uid?: string; authTime?: number } = {}) =>
    call<{ status: string; pendingConfirmation: boolean }>(recordMovementDefinition, { id, ...data }, role, options);
  const under = (path: string) =>
    [...store.docs.entries()]
      .filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1)
      .map(([p, data]): Data & { id: string } => ({ ...data, id: p.split('/').at(-1) as string }));
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  return { ...store, clock, ports, call, receive, move, under, doc };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

describe('safeCustody-receive', () => {
  it('numbers packets from the counter and records the packet held, with an in movement', async () => {
    const w = world();
    const first = await w.receive();
    const second = await w.receive({ items: [WILL, { kind: 'poa', description: 'Enduring POA' }] });
    expect([first.packetNo, second.packetNo]).toEqual(['SC-000001', 'SC-000002']);
    expect(w.doc(`orgs/${ORG}/counters/safe-custody`)).toMatchObject({ next: 3 });
    const packet = w.doc(`${SC}/${first.id}`);
    expect(packet).toMatchObject({
      packetNo: 'SC-000001',
      testatorContactId: 'c-wren',
      testatorName: 'Ada Wren',
      responsibleUid: 'user-lawyer',
      status: 'held',
      location: LOCATION,
      locationKey: 'geelong|safe a|00000002',
      pendingDestruction: null,
    });
    expect(packet?.['search']).toEqual(expect.arrayContaining(['sc000001', '000001', 'ada', 'wren', 'geelong']));
    expect(packet?.['movements']).toEqual([expect.objectContaining({ kind: 'in', by: 'user-lawyer' })]);
  });

  it('follows a merged testator to the contact kept', async () => {
    const w = world();
    const { id } = await w.receive({ testatorContactId: 'c-old' });
    expect(w.doc(`${SC}/${id}`)).toMatchObject({ testatorContactId: 'c-wren' });
  });

  it('refuses an organisation, an inactive responsible lawyer, an unscanned scan and read-only callers', async () => {
    const w = world();
    expect(await failure(w.receive({ testatorContactId: 'c-firm' }))).toMatchObject({
      code: 'invalid-argument',
      details: { fields: { testatorContactId: ['Choose a person'] } },
    });
    expect(await failure(w.receive({ responsibleUid: 'user-gone' }))).toMatchObject({ code: 'invalid-argument' });
    expect(
      await failure(w.receive({ items: [{ ...WILL, document: { matterId: 'm-will', documentId: 'd-pending' } }] })),
    ).toMatchObject({ code: 'invalid-argument', details: { fields: { 'items.0.document': [expect.any(String)] } } });
    expect(await failure(w.receive({}, 'readonly'))).toMatchObject({ code: 'permission-denied' });
    expect(await failure(w.receive({ items: [] }))).toMatchObject({ code: 'invalid-argument' });
  });
});

describe('safeCustody-update', () => {
  it('moves a packet to a new slot and keeps its search and sort key in step', async () => {
    const w = world();
    const { id } = await w.receive();
    await w.call(updateDefinition, { id, location: { site: 'Melbourne', cabinet: 'Vault', slot: '12' } }, 'paralegal');
    expect(w.doc(`${SC}/${id}`)).toMatchObject({
      location: { site: 'Melbourne', cabinet: 'Vault', slot: '12' },
      locationKey: 'melbourne|vault|00000012',
      updatedBy: 'user-paralegal',
    });
    expect(w.doc(`${SC}/${id}`)?.['search']).toContain('melbourne');
  });

  it('refuses a released packet', async () => {
    const w = world();
    const { id } = await w.receive();
    await w.move(id, { kind: 'released', reason: 'Testator collected it', to: 'Ada Wren', authority: AUTHORITY });
    expect(await failure(w.call(updateDefinition, { id, notes: 'Late note' }))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'packet_closed' },
    });
  });
});

describe('safeCustody-recordMovement', () => {
  it('takes a will out, returns it and releases it with an authority, keeping the chain of custody', async () => {
    const w = world();
    const { id } = await w.receive();
    expect(await w.move(id, { kind: 'out', reason: 'Signing review', to: 'Jordan (lawyer)' }, 'paralegal')).toEqual({
      status: 'out',
      pendingConfirmation: false,
    });
    await w.move(id, { kind: 'returned', reason: 'Back', location: { site: 'Geelong', cabinet: 'Safe B', slot: '7' } });
    expect(w.doc(`${SC}/${id}`)).toMatchObject({ status: 'held', location: { cabinet: 'Safe B', slot: '7' } });
    expect(
      await w.move(id, { kind: 'released', reason: 'Executor’s request', toContactId: 'c-firm', authority: AUTHORITY }),
    ).toEqual({ status: 'released', pendingConfirmation: false });
    const movements = w.doc(`${SC}/${id}`)?.['movements'] as Data[];
    expect(movements.map((m) => m['kind'])).toEqual(['in', 'out', 'returned', 'released']);
    expect(movements[3]).toMatchObject({ toContactId: 'c-firm', authority: AUTHORITY, by: 'user-lawyer' });
    expect(movements[2]).toMatchObject({ location: { cabinet: 'Safe B' } });
  });

  it('releases only with an authority, by a lawyer or above, signed in within five minutes', async () => {
    const w = world();
    const { id } = await w.receive();
    const release = { kind: 'released', reason: 'Executor', to: 'Fictional Executor', authority: AUTHORITY };
    expect(await failure(w.move(id, { ...release, authority: undefined }))).toMatchObject({
      code: 'invalid-argument',
      details: { fields: { authority: ['Choose the authority document'] } },
    });
    expect(await failure(w.move(id, release, 'paralegal'))).toMatchObject({ code: 'permission-denied' });
    expect(await failure(w.move(id, release, 'lawyer', { authTime: SIGNED_IN - 10 * 60 }))).toMatchObject({
      code: 'unauthenticated',
      details: { code: 'REAUTH_REQUIRED' },
    });
    expect(
      await failure(w.move(id, { ...release, authority: { matterId: 'm-will', documentId: 'd-pending' } })),
    ).toMatchObject({ code: 'invalid-argument', details: { fields: { authority: [expect.any(String)] } } });
    expect(
      await failure(w.move(id, { ...release, authority: { matterId: 'm-will', documentId: 'd-none' } })),
    ).toMatchObject({ code: 'invalid-argument' });
    expect(w.doc(`${SC}/${id}`)).toMatchObject({ status: 'held' });
    expect(await w.move(id, release, 'owner')).toMatchObject({ status: 'released' });
  });

  it('refuses movements the status doesn’t allow, and anything after a release', async () => {
    const w = world();
    const { id } = await w.receive();
    expect(await failure(w.move(id, { kind: 'returned', reason: 'x' }))).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'invalid_movement', status: 'held' },
    });
    expect(await failure(w.move(id, { kind: 'out', reason: 'x' }))).toMatchObject({
      code: 'invalid-argument',
      details: { fields: { to: ['Say who has it'] } },
    });
    await w.move(id, { kind: 'released', reason: 'x', to: 'Executor', authority: AUTHORITY });
    expect(await failure(w.move(id, { kind: 'out', reason: 'x', to: 'y' }))).toMatchObject({
      details: { reason: 'packet_closed' },
    });
    expect(await failure(w.move('nope', { kind: 'out', reason: 'x', to: 'y' }))).toMatchObject({ code: 'not-found' });
  });
});

describe('destruction (two lawyers)', () => {
  it('asks, tells the other lawyers, and destroys only once a second lawyer confirms', async () => {
    const w = world();
    const { id } = await w.receive();
    expect(
      await w.move(id, { kind: 'destroyed', reason: 'Testator’s written instruction', authority: AUTHORITY }),
    ).toEqual({ status: 'held', pendingConfirmation: true });
    expect(w.doc(`${SC}/${id}`)).toMatchObject({
      status: 'held',
      pendingDestruction: { requestedBy: 'user-lawyer', authority: AUTHORITY },
    });
    const notified = w.under(`orgs/${ORG}/notifications`);
    expect(notified.map((n) => n['recipientUid']).sort()).toEqual(['user-lawyer2', 'user-owner']);
    expect(notified[0]).toMatchObject({ kind: 'safe_custody', packetId: id, link: `/safe-custody/${id}` });

    expect(await failure(w.move(id, { kind: 'out', reason: 'x', to: 'y' }))).toMatchObject({
      details: { reason: 'destruction_pending' },
    });
    expect(await failure(w.call(confirmDestructionDefinition, { id, approve: true }))).toMatchObject({
      code: 'permission-denied',
      details: { reason: 'same_person' },
    });
    expect(await failure(w.call(confirmDestructionDefinition, { id, approve: true }, 'paralegal'))).toMatchObject({
      code: 'permission-denied',
    });
    expect(
      await w.call(confirmDestructionDefinition, { id, approve: true }, 'lawyer', { uid: 'user-lawyer2' }),
    ).toEqual({ status: 'destroyed', pendingConfirmation: false });
    const packet = w.doc(`${SC}/${id}`);
    expect(packet).toMatchObject({ status: 'destroyed', pendingDestruction: null });
    expect((packet?.['movements'] as Data[]).at(-1)).toMatchObject({
      kind: 'destroyed',
      by: 'user-lawyer',
      approvedBy: 'user-lawyer2',
      authority: AUTHORITY,
    });
  });

  it('lets either lawyer decline, which changes nothing else', async () => {
    const w = world();
    const { id } = await w.receive();
    await w.move(id, { kind: 'destroyed', reason: 'Instruction', authority: AUTHORITY });
    expect(await w.call(confirmDestructionDefinition, { id, approve: false })).toEqual({
      status: 'held',
      pendingConfirmation: false,
    });
    expect(w.doc(`${SC}/${id}`)).toMatchObject({ status: 'held', pendingDestruction: null });
    expect(w.doc(`${SC}/${id}`)?.['movements']).toHaveLength(1);
    expect(await failure(w.call(confirmDestructionDefinition, { id, approve: true }))).toMatchObject({
      details: { reason: 'no_pending_destruction' },
    });
  });

  it('destroys only held packets', async () => {
    const w = world();
    const { id } = await w.receive();
    await w.move(id, { kind: 'out', reason: 'x', to: 'y' });
    expect(await failure(w.move(id, { kind: 'destroyed', reason: 'x', authority: AUTHORITY }))).toMatchObject({
      details: { reason: 'invalid_movement' },
    });
  });
});

describe('safeCustody-verify', () => {
  it('marks held packets verified on the stocktake date and skips the rest', async () => {
    const w = world();
    const held = await w.receive();
    const out = await w.receive();
    await w.move(out.id, { kind: 'out', reason: 'x', to: 'y' });
    const result = await w.call(verifyDefinition, { ids: [held.id, out.id, 'missing'], on: '2026-10-05' }, 'paralegal');
    expect(result).toEqual({ verified: [held.id], skipped: [out.id, 'missing'] });
    expect(w.doc(`${SC}/${held.id}`)).toMatchObject({ lastVerified: { on: '2026-10-05', by: 'user-paralegal' } });
    expect(w.doc(`${SC}/${out.id}`)?.['lastVerified']).toBeUndefined();
  });
});

describe('PDFs', () => {
  it('starts the receipt job with the firm, testator and items, but not the cabinet', async () => {
    const w = world();
    const { id } = await w.receive({ items: [{ kind: 'will', date: '2010-01-01', description: 'Earlier' }, WILL] });
    const { jobId } = await w.call<{ jobId: string }>(receiptDefinition, { id });
    const job = w.doc(`orgs/${ORG}/jobs/${jobId}`);
    expect(job).toMatchObject({
      type: 'pdf.render',
      status: 'queued',
      target: { kind: 'export', name: 'Safe custody receipt SC-000001' },
      input: {
        templateId: 'safe-custody-receipt',
        data: {
          firmName: 'Fictional Bayside Legal',
          packetNo: 'SC-000001',
          testatorName: 'Ada Wren',
          testatorAddress: '1 Fictional St, Geelong VIC 3220',
          site: 'Geelong',
          issuedOn: '5 Oct 2026',
          items: [
            expect.objectContaining({ current: false }),
            expect.objectContaining({ kind: 'Will', current: true }),
          ],
        },
      },
    });
    expect(JSON.stringify(job?.['input'])).not.toContain('Safe A');
    expect((w.ports.jobs as FakeJobRunner).started).toEqual([{ job: 'pdf', orgId: ORG, jobId }]);
  });

  it('starts the stocktake with held packets only, grouped by site and cabinet', async () => {
    const w = world();
    await w.receive({ location: { site: 'Geelong', cabinet: 'Safe A', slot: '12' } });
    await w.receive({ location: { site: 'Geelong', cabinet: 'Safe A', slot: '2' } });
    const out = await w.receive({ location: { site: 'Torquay', cabinet: 'Drawer', slot: '' } });
    await w.move(out.id, { kind: 'out', reason: 'x', to: 'y' });
    const { jobId } = await w.call<{ jobId: string }>(stocktakeReportDefinition, {});
    const data = (w.doc(`orgs/${ORG}/jobs/${jobId}`)?.['input'] as { data: Data }).data;
    expect(data).toMatchObject({ count: 2, sites: [{ site: 'Geelong', cabinets: [{ cabinet: 'Safe A' }] }] });
    const rows = (data['sites'] as { cabinets: { packets: Data[] }[] }[])[0]?.cabinets[0]?.packets;
    expect(rows?.map((row) => row['slot'])).toEqual(['2', '12']);
    const torquay = await w.call<{ jobId: string }>(stocktakeReportDefinition, { site: 'Torquay' });
    expect((w.doc(`orgs/${ORG}/jobs/${torquay.jobId}`)?.['input'] as { data: Data }).data).toMatchObject({ count: 0 });
  });

  it('groups and labels rows for the templates', () => {
    expect(receiptItems([{ kind: 'codicil', date: '2020-01-01' as never, description: '' }])).toEqual([
      { kind: 'Codicil', date: '1 Jan 2020', description: '', current: true },
    ]);
    expect(stocktakeGroups([{ packetNo: 'SC-1', location: {} }])).toEqual([
      {
        site: 'No site',
        cabinets: [
          {
            cabinet: 'No cabinet',
            packets: [{ packetNo: 'SC-1', testatorName: '', slot: '', items: '', lastVerified: '' }],
          },
        ],
      },
    ]);
  });
});

describe('jobs-getExportUrl', () => {
  const job = (extra: Data = {}) => ({
    ...meta,
    createdBy: 'user-lawyer',
    type: 'pdf.render',
    target: { kind: 'export', name: 'Safe custody receipt SC-000001' },
    status: 'succeeded',
    output: { storagePath: `orgs/${ORG}/exports/j1.pdf` },
    ...extra,
  });
  const def = getExportUrlDefinition(() => 'bucket-test');

  it('signs the PDF for the member who started the job', async () => {
    const w = world({ [`orgs/${ORG}/jobs/j1`]: job() });
    const result = await w.call<{ url: string; fileName: string }>(def, { jobId: 'j1' });
    expect(result.fileName).toBe('Safe custody receipt SC-000001.pdf');
    expect((w.ports.signedUrls as FakeSignedUrls).signed[0]).toMatchObject({
      bucket: 'bucket-test',
      path: `orgs/${ORG}/exports/j1.pdf`,
      contentType: 'application/pdf',
    });
  });

  it('hides other people’s jobs and refuses one still running', async () => {
    const w = world({
      [`orgs/${ORG}/jobs/j1`]: job(),
      [`orgs/${ORG}/jobs/j2`]: job({ status: 'running', output: undefined }),
      [`orgs/${ORG}/jobs/j3`]: job({ target: { kind: 'matter', matterId: 'm-will', name: 'x', category: 'other' } }),
    });
    expect(await failure(w.call(def, { jobId: 'j1' }, 'owner'))).toMatchObject({ code: 'not-found' });
    expect(await failure(w.call(def, { jobId: 'j2' }))).toMatchObject({ details: { reason: 'not_ready' } });
    expect(await failure(w.call(def, { jobId: 'j3' }))).toMatchObject({ code: 'not-found' });
  });

  it('makes a safe file name', () => {
    expect(exportFileName('Stocktake: Geelong/Safe A')).toBe('Stocktake Geelong Safe A.pdf');
    expect(exportFileName('')).toBe('Export.pdf');
  });
});

describe('safeCustody-onContactWrite', () => {
  const trigger = (w: ReturnType<typeof world>, contactId: string, before: Data | undefined) => {
    const path = `${C}/${contactId}`;
    const snap = (data: Data | undefined) => (data ? { ref: { path }, data: () => data } : undefined);
    const change = { before: snap(before), after: snap(w.doc(path)) } as unknown as TriggerChange;
    const ctx = {
      eventId: 'e1',
      time: NOW,
      params: { orgId: ORG, contactId },
      log: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
      clock: w.clock,
      db: w.db,
      ports: w.ports,
    } as unknown as TriggerContext;
    return onTestatorWrite(change, ctx);
  };

  it('tells the responsible lawyer when a testator with a held packet dies, once', async () => {
    const w = world();
    const { id } = await w.receive({ responsibleUid: 'user-lawyer2' });
    const released = await w.receive();
    await w.move(released.id, { kind: 'released', reason: 'x', to: 'Testator', authority: AUTHORITY });
    const before = w.doc(`${C}/c-wren`) as Data;
    await w.db.doc(`${C}/c-wren`).update({ dateOfDeath: '2026-10-01' });
    expect(await trigger(w, 'c-wren', before)).toEqual({ notified: [id], renamed: [] });
    const [notification] = w.under(`orgs/${ORG}/notifications`);
    expect(notification).toMatchObject({
      id: `sc-death-${id}`,
      kind: 'safe_custody',
      recipientUid: 'user-lawyer2',
      title: 'Original will held: SC-000001',
      link: `/safe-custody/${id}`,
      priority: 'high',
    });
    expect(JSON.stringify(notification)).not.toContain('Wren');
    // A later edit that keeps the date of death tells nobody again.
    expect(await trigger(w, 'c-wren', w.doc(`${C}/c-wren`))).toEqual({ notified: [], renamed: [] });
  });

  it('keeps the packet’s testator name and search in step with the contact', async () => {
    const w = world();
    const { id } = await w.receive();
    const before = w.doc(`${C}/c-wren`) as Data;
    await w.db.doc(`${C}/c-wren`).update({ familyName: 'Wren-Hart' });
    expect(await trigger(w, 'c-wren', before)).toEqual({ notified: [], renamed: [id] });
    expect(w.doc(`${SC}/${id}`)).toMatchObject({ testatorName: 'Ada Wren-Hart' });
    expect(w.doc(`${SC}/${id}`)?.['search']).toContain('hart');
  });

  it('does nothing for a deleted contact or one without packets', async () => {
    const w = world();
    expect(await trigger(w, 'c-firm', undefined)).toEqual({ notified: [], renamed: [] });
    const path = `${C}/c-gone`;
    const change = { before: { data: () => ({}) }, after: undefined } as unknown as TriggerChange;
    expect(await onTestatorWrite(change, { params: { orgId: ORG, contactId: 'c-gone' }, db: w.db } as never)).toEqual({
      notified: [],
      renamed: [],
    });
    expect(w.doc(path)).toBeUndefined();
  });
});
