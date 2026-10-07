import type { HttpsError } from 'firebase-functions/v2/https';

import { DomainError, ORG_PURGE_QUEUE, resolveSecurity } from '@materia/domain';

import { runCallable, type CallableDefinition, type CallableDeps } from './callable';
import { cachedPurgeLookup, payloadOrgId, purgedTaskOrg } from './purge-guard';
import { assertWritable, READ_ONLY_CALLABLES } from './read-only';
import { cachedSessionLookup, type SessionPolicy } from './sessions';
import { runTrigger, type TriggerDeps } from './trigger';
import { cancelDeletionDefinition } from '../orgs/deletion';
import { changeRoleDefinition } from '../orgs/members';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** A practice waiting to be deleted is read-only, and one being deleted is left alone (SEC-05). */

const REQUEST_ID = '0c7e1d2a-3b4c-4d5e-8f60-718293a4b5c6';
const clock = new FakeClock(new Date('2026-10-07T00:00:00Z'));
const nowSeconds = Math.floor(clock.now().getTime() / 1000);
const DELETION = new Date('2026-11-06T00:00:00Z');

const session = (deletionScheduledAt: Date | null): SessionPolicy => ({
  policy: resolveSecurity(undefined),
  validAfter: null,
  deletionScheduledAt,
});

const call = (def: CallableDefinition<never, unknown>, data: Record<string, unknown>, sessions: SessionPolicy) => {
  const { db } = memoryFirestore({ 'orgs/org-a': { name: 'Fictional Legal', deletionScheduledAt: DELETION } });
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts({ clock }),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
    sessions: async () => sessions,
  };
  return runCallable(
    def,
    {
      data: { requestId: REQUEST_ID, ...data },
      auth: { uid: 'owner-1', token: { orgId: 'org-a', role: 'owner', auth_time: nowSeconds } },
    },
    deps,
  ).catch((error: unknown) => error as HttpsError);
};

describe('read-only while a deletion is scheduled', () => {
  it('lets every callable run when no deletion is scheduled', () => {
    expect(() => assertWritable('matters-createMatter', { deletionScheduledAt: null })).not.toThrow();
    expect(() => assertWritable('matters-createMatter', {})).not.toThrow();
  });

  it('refuses changes, but not reads, exports, the deletion itself or taking access away', () => {
    const scheduled = { deletionScheduledAt: DELETION };
    for (const name of ['matters-createMatter', 'time-stopTimer', 'orgs-inviteMember', 'orgs-offboardMember']) {
      expect(() => assertWritable(name, scheduled), name).toThrow(DomainError);
    }
    for (const name of [
      'audit-query',
      'exports-orgFull',
      'jobs-getExportUrl',
      'orgs-cancelDeletion',
      'matters-setLegalHold',
      'orgs-removeMember',
      'orgs-offboardingPlan',
      'orgs-acceptTerms',
    ]) {
      expect(READ_ONLY_CALLABLES.has(name), name).toBe(true);
      expect(() => assertWritable(name, scheduled), name).not.toThrow();
    }
    try {
      assertWritable('matters-createMatter', scheduled);
    } catch (error) {
      expect(error).toMatchObject({ code: 'ORG_READ_ONLY', details: { deletionScheduledAt: DELETION.toISOString() } });
    }
  });

  it('is enforced by the callable wrapper', async () => {
    const refused = await call(changeRoleDefinition as never, { uid: 'lawyer-1', role: 'admin' }, session(DELETION));
    expect(refused).toMatchObject({ code: 'failed-precondition', details: { code: 'ORG_READ_ONLY' } });
    const allowed = await call(cancelDeletionDefinition as never, {}, session(DELETION));
    expect(allowed).toEqual({ cancelled: true });
  });

  it('reads the deletion date with the session policy', async () => {
    const { db } = memoryFirestore({ 'orgs/org-a': { deletionScheduledAt: DELETION }, 'orgs/org-a/members/u1': {} });
    const lookup = cachedSessionLookup(() => db, clock);
    expect((await lookup('org-a', 'u1')).deletionScheduledAt).toEqual(DELETION);
    expect(
      (await cachedSessionLookup(() => memoryFirestore().db, clock)('org-b', 'u1')).deletionScheduledAt,
    ).toBeNull();
  });
});

describe('the purge guard', () => {
  it('remembers a practice being deleted, and checks again on a "no" after 30 seconds', async () => {
    const store = memoryFirestore();
    const local = new FakeClock(clock.now());
    const lookup = cachedPurgeLookup(() => store.db, local);
    expect(await lookup('org-a')).toBe(false);
    await store.db.doc('deletedOrgs/org-a').set({ orgId: 'org-a', status: 'purging' });
    expect(await lookup('org-a')).toBe(false);
    local.advance(31_000);
    expect(await lookup('org-a')).toBe(true);
    store.docs.delete('deletedOrgs/org-a');
    local.advance(31_000);
    expect(await lookup('org-a')).toBe(true);
    lookup.clear();
    expect(await lookup('org-a')).toBe(false);
  });

  it('drops queued tasks for a practice being deleted, except the deletion’s own', async () => {
    const purging = Object.assign(async (orgId: string) => orgId === 'org-gone', { clear: () => undefined });
    expect(payloadOrgId({ orgId: 'org-a' })).toBe('org-a');
    expect(payloadOrgId({ uid: 'u1' })).toBeNull();
    expect(await purgedTaskOrg('reminders-deliver', { orgId: 'org-gone' }, purging)).toBe('org-gone');
    expect(await purgedTaskOrg('reminders-deliver', { orgId: 'org-a' }, purging)).toBeNull();
    expect(await purgedTaskOrg('reminders-deliver', { other: 1 }, purging)).toBeNull();
    expect(await purgedTaskOrg(ORG_PURGE_QUEUE, { orgId: 'org-gone' }, purging)).toBeNull();
  });

  it('skips triggers in a practice being deleted', async () => {
    const store = memoryFirestore();
    const handler = vi.fn();
    const deps: TriggerDeps = {
      db: () => store.db,
      clock,
      ports: () => fakePorts(),
      sink: () => undefined,
      purging: Object.assign(async (orgId: string) => orgId === 'org-gone', { clear: () => undefined }),
    };
    const def = {
      name: 'matters-onWrite',
      document: 'orgs/{orgId}/matters/{matterId}',
      on: 'written' as const,
      handler,
    };
    const event = (orgId: string) => ({
      id: `e-${orgId}`,
      params: { orgId, matterId: 'm1' },
      change: { before: undefined, after: undefined },
    });
    expect(await runTrigger(def, event('org-gone'), deps)).toBe('purging');
    expect(await runTrigger(def, event('org-a'), deps)).toBe('ran');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
