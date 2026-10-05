import { onProfileUpdate, onProfileWriteDefinition } from './on-profile-write';
import { memoryFirestore } from './testing';
import type { TriggerChange, TriggerContext } from '../core/trigger';

const AT = new Date('2026-10-06T00:00:00.000Z');

function ctx(db: TriggerContext['db']): TriggerContext {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  return {
    eventId: 'evt-1',
    time: AT,
    params: { uid: 'u1' },
    log: log as unknown as TriggerContext['log'],
    clock: { now: () => AT },
    db,
    ports: {} as TriggerContext['ports'],
  };
}

const snap = (data: Record<string, unknown>) => ({ data: () => data });
const change = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  ({ before: snap(before), after: snap(after) }) as unknown as TriggerChange;

describe('orgs-onProfileWrite', () => {
  it('watches updates of users/{uid}', () => {
    expect(onProfileWriteDefinition.document).toBe('users/{uid}');
    expect(onProfileWriteDefinition.on).toBe('updated');
  });

  it('copies a new display name to every active or suspended membership, not removed ones', async () => {
    const { db, docs } = memoryFirestore({
      'orgs/a/members/u1': { status: 'active', displayName: 'Priya Old' },
      'orgs/b/members/u1': { status: 'suspended', displayName: 'Priya Old' },
      'orgs/c/members/u1': { status: 'removed', displayName: 'Priya Old' },
      'orgs/d/members/u1': { status: 'active', displayName: 'Priya New' },
    });
    await onProfileUpdate(
      change(
        { displayName: 'Priya Old', orgIds: ['a', 'b', 'c', 'd', 'e'] },
        { displayName: 'Priya New', orgIds: ['a', 'b', 'c', 'd', 'e'] },
      ),
      ctx(db),
    );
    expect(docs.get('orgs/a/members/u1')).toMatchObject({ displayName: 'Priya New', updatedBy: 'u1' });
    expect(docs.get('orgs/b/members/u1')?.['displayName']).toBe('Priya New');
    expect(docs.get('orgs/c/members/u1')?.['displayName']).toBe('Priya Old');
    // Already current (the page wrote it): untouched.
    expect(docs.get('orgs/d/members/u1')).toEqual({ status: 'active', displayName: 'Priya New' });
    expect(docs.has('orgs/e/members/u1')).toBe(false);
  });

  it('does nothing when the name didn’t change, or is empty', async () => {
    const { db, docs } = memoryFirestore({ 'orgs/a/members/u1': { status: 'active', displayName: 'Priya Old' } });
    await onProfileUpdate(
      change({ displayName: 'Priya Old', orgIds: ['a'] }, { displayName: 'Priya Old', orgIds: ['a'], prefs: {} }),
      ctx(db),
    );
    await onProfileUpdate(
      change({ displayName: 'Priya Old', orgIds: ['a'] }, { displayName: '  ', orgIds: ['a'] }),
      ctx(db),
    );
    expect(docs.get('orgs/a/members/u1')).toEqual({ status: 'active', displayName: 'Priya Old' });
  });
});
