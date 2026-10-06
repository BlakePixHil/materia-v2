import { onPartyWriteHandler, recomputeMatterRoles, refreshMatterRoles } from './matter-roles';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** `contacts-onPartyWrite` and the roles-in-matters recompute (CORE-01a). Everything is fictional. */

const ORG = 'org-a';
const C = `orgs/${ORG}/contacts`;
const M = `orgs/${ORG}/matters`;
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };

const contact = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  kind: 'person',
  familyName: 'Fictional',
  ...extra,
});
const matter = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  title: 'Estate of Example',
  deletedAt: null,
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

function world(initial: Record<string, Record<string, unknown>>) {
  const store = memoryFirestore(initial);
  const logs: string[] = [];
  const ctx = (matterId: string) =>
    ({
      eventId: 'e1',
      time: new Date('2026-10-06T00:00:00Z'),
      params: { orgId: ORG, matterId, partyId: 'p' },
      log: createLog({ fn: 'test' }, (_severity, message) => logs.push(message)),
      clock: new FakeClock(new Date('2026-10-06T00:00:00Z')),
      db: store.db,
      ports: fakePorts(),
    }) as unknown as TriggerContext;
  const snap = (data: Record<string, unknown> | undefined) => (data ? { data: () => data } : undefined);
  /** Writes the party row as the callable would, then runs the trigger on that change. */
  const write = async (path: string, data: Record<string, unknown> | undefined) => {
    const before = store.docs.get(path);
    if (data) await store.db.doc(path).set(data);
    else await store.db.doc(path).delete();
    const change = { before: snap(before), after: snap(data) } as unknown as TriggerChange;
    return onPartyWriteHandler(change, ctx(path.split('/')[3] as string));
  };
  const roles = (contactId: string) => store.docs.get(`${C}/${contactId}`)?.['matterRoles'];
  return { ...store, write, roles };
}

describe('contacts-onPartyWrite', () => {
  it('adds a new role in matters order, and leaves a role it already has alone', async () => {
    const w = world({
      [`${C}/c-1`]: contact({ matterRoles: ['beneficiary'] }),
      [`${M}/m-1`]: matter(),
      [`${M}/m-2`]: matter(),
    });
    expect(await w.write(`${M}/m-1/parties/executor-c-1`, party('m-1', 'c-1', 'executor'))).toEqual({
      'c-1': 'updated',
    });
    expect(w.roles('c-1')).toEqual(['executor', 'beneficiary']);
    expect(await w.write(`${M}/m-2/parties/executor-c-1`, party('m-2', 'c-1', 'executor'))).toEqual({
      'c-1': 'unchanged',
    });
  });

  it('removes a role only when no other live row on a live matter holds it', async () => {
    const w = world({
      [`${C}/c-1`]: contact({ matterRoles: ['executor', 'beneficiary'] }),
      [`${M}/m-1`]: matter(),
      [`${M}/m-2`]: matter(),
      [`${M}/m-1/parties/executor-c-1`]: party('m-1', 'c-1', 'executor'),
      [`${M}/m-2/parties/executor-c-1`]: party('m-2', 'c-1', 'executor'),
      [`${M}/m-2/parties/beneficiary-c-1`]: party('m-2', 'c-1', 'beneficiary'),
    });
    const removed = (path: string) => ({ ...(w.docs.get(path) as object), deletedAt: new Date() });
    await w.write(`${M}/m-2/parties/executor-c-1`, removed(`${M}/m-2/parties/executor-c-1`));
    expect(w.roles('c-1')).toEqual(['executor', 'beneficiary']);
    await w.write(`${M}/m-2/parties/beneficiary-c-1`, removed(`${M}/m-2/parties/beneficiary-c-1`));
    expect(w.roles('c-1')).toEqual(['executor']);
    await w.write(`${M}/m-1/parties/executor-c-1`, undefined);
    expect(w.roles('c-1')).toEqual([]);
  });

  it('moves the role from the merged contact to the kept one when a merge re-points the row', async () => {
    const w = world({
      [`${C}/c-keep`]: contact({ matterRoles: [] }),
      [`${C}/c-gone`]: contact({ matterRoles: ['trustee'], mergedInto: 'c-keep', deletedAt: new Date() }),
      [`${M}/m-1`]: matter(),
      [`${M}/m-1/parties/trustee-c-gone`]: party('m-1', 'c-gone', 'trustee'),
    });
    const results = await w.write(`${M}/m-1/parties/trustee-c-gone`, party('m-1', 'c-keep', 'trustee'));
    expect(results).toEqual({ 'c-gone': 'skipped', 'c-keep': 'updated' });
    expect(w.roles('c-keep')).toEqual(['trustee']);
    // The tombstone never shows in the list, so it isn't rewritten.
    expect(w.roles('c-gone')).toEqual(['trustee']);
  });

  it('recomputes on a role change, and ignores share and notes edits', async () => {
    const w = world({
      [`${C}/c-1`]: contact({ matterRoles: ['beneficiary'] }),
      [`${M}/m-1`]: matter(),
      [`${M}/m-1/parties/beneficiary-c-1`]: party('m-1', 'c-1', 'beneficiary'),
    });
    expect(
      await w.write(`${M}/m-1/parties/beneficiary-c-1`, party('m-1', 'c-1', 'beneficiary', { share: '50%' })),
    ).toEqual({});
    await w.write(`${M}/m-1/parties/beneficiary-c-1`, party('m-1', 'c-1', 'executor'));
    expect(w.roles('c-1')).toEqual(['executor']);
  });

  it('doesn’t count a privileged matter, so the filter can’t hint at it', async () => {
    const w = world({
      [`${C}/c-1`]: contact({ matterRoles: [] }),
      [`${M}/m-secret`]: matter({ privileged: true }),
    });
    expect(await w.write(`${M}/m-secret/parties/beneficiary-c-1`, party('m-secret', 'c-1', 'beneficiary'))).toEqual({
      'c-1': 'unchanged',
    });
    expect(w.roles('c-1')).toEqual([]);
    // Unmarking it brings the role in (matters-denormalise), marking it again takes it out.
    await w.db.doc(`${M}/m-secret`).set(matter({ privileged: false }));
    expect(await refreshMatterRoles(w.db, ORG, 'm-secret', matter({ privileged: true }), matter())).toBe(1);
    expect(w.roles('c-1')).toEqual(['beneficiary']);
    await w.db.doc(`${M}/m-secret`).set(matter({ privileged: true }));
    await refreshMatterRoles(w.db, ORG, 'm-secret', matter(), matter({ privileged: true }));
    expect(w.roles('c-1')).toEqual([]);
  });

  it('doesn’t count a deleted matter, and skips a missing contact', async () => {
    const w = world({
      [`${C}/c-1`]: contact(),
      [`${M}/m-deleted`]: matter({ deletedAt: new Date() }),
    });
    expect(await w.write(`${M}/m-deleted/parties/client-c-1`, party('m-deleted', 'c-1', 'client'))).toEqual({
      'c-1': 'unchanged',
    });
    expect(w.roles('c-1')).toBeUndefined();
    expect(await w.write(`${M}/m-deleted/parties/client-c-none`, party('m-deleted', 'c-none', 'client'))).toEqual({
      'c-none': 'skipped',
    });
  });
});

describe('roles when a matter is deleted or restored', () => {
  it('recomputes the contacts with live rows on the matter, only when its liveness changes', async () => {
    const w = world({
      [`${C}/c-1`]: contact({ matterRoles: ['executor', 'beneficiary'] }),
      [`${C}/c-2`]: contact({ matterRoles: ['client'] }),
      [`${M}/m-1`]: matter({ deletedAt: new Date() }),
      [`${M}/m-2`]: matter(),
      [`${M}/m-1/parties/executor-c-1`]: party('m-1', 'c-1', 'executor'),
      [`${M}/m-1/parties/client-c-2`]: party('m-1', 'c-2', 'client'),
      [`${M}/m-1/parties/witness-c-2`]: party('m-1', 'c-2', 'witness', { deletedAt: new Date() }),
      [`${M}/m-2/parties/beneficiary-c-1`]: party('m-2', 'c-1', 'beneficiary'),
    });
    const live = matter();
    const deleted = matter({ deletedAt: new Date() });
    expect(await refreshMatterRoles(w.db, ORG, 'm-1', live, deleted)).toBe(2);
    expect(w.roles('c-1')).toEqual(['beneficiary']);
    expect(w.roles('c-2')).toEqual([]);
    expect(await refreshMatterRoles(w.db, ORG, 'm-1', live, { ...live, title: 'Renamed' })).toBe(0);
    expect(await refreshMatterRoles(w.db, ORG, 'm-1', undefined, live)).toBe(0);

    await w.db.doc(`${M}/m-1`).set(live);
    await refreshMatterRoles(w.db, ORG, 'm-1', deleted, live);
    expect(w.roles('c-1')).toEqual(['executor', 'beneficiary']);
    expect(w.roles('c-2')).toEqual(['client']);
  });

  it('recomputeMatterRoles is a no-op when nothing changed', async () => {
    const w = world({
      [`${C}/c-1`]: contact({ matterRoles: ['client'] }),
      [`${M}/m-1`]: matter(),
      [`${M}/m-1/parties/client-c-1`]: party('m-1', 'c-1', 'client'),
    });
    expect(await recomputeMatterRoles(w.db, ORG, 'c-1')).toBe('unchanged');
  });
});
