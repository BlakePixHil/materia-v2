import { TestBed } from '@angular/core/testing';

import { createMatterFromIntake, IntakeDrafts, intakeDraftKey, intakeDraftsRepository } from './intake';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

const NOW = new Date('2026-10-04T01:00:00Z');

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  const repository = TestBed.runInInjectionContext(() => intakeDraftsRepository());
  return {
    fs,
    drafts: new IntakeDrafts(
      repository,
      () => 'org-a',
      () => NOW,
    ),
  };
}

describe('IntakeDrafts', () => {
  it('creates intake-{key} on the first save and updates it after that', async () => {
    const { fs, drafts } = setup();
    await drafts.save('k1', 'type', { type: 'probate' });
    await drafts.save('k1', 'clients', { type: 'probate', clientContactIds: ['c-1'] });
    expect(fs.writes.map((w) => `${w.op} ${w.path}`)).toEqual([
      'create users/u-jordan/drafts/intake-k1',
      'update users/u-jordan/drafts/intake-k1',
    ]);
    expect(fs.get('users/u-jordan/drafts/intake-k1')).toMatchObject({
      orgId: 'org-a',
      kind: 'intake',
      step: 'clients',
      stateJson: '{"type":"probate","clientContactIds":["c-1"]}',
      expireAt: new Date('2026-11-03T01:00:00Z'),
    });
  });

  it('finds the latest draft in the org, and recreates one deleted elsewhere', async () => {
    const { fs, drafts } = setup();
    await drafts.save('old', 'type', { type: 'will' });
    await drafts.save('new', 'fees', { type: 'trust' });
    fs.set('users/u-jordan/drafts/intake-new', {
      ...fs.get('users/u-jordan/drafts/intake-new'),
      updatedAt: new Date('2026-10-05T00:00:00Z'),
    });
    const latest = await drafts.latest();
    expect(latest && intakeDraftKey(latest.id)).toBe('new');
    await drafts.remove('new');
    expect(fs.get('users/u-jordan/drafts/intake-new')).toBeUndefined();
    await drafts.save('new', 'review', {});
    expect(fs.get('users/u-jordan/drafts/intake-new')).toMatchObject({ step: 'review' });
  });
});

describe('createMatterFromIntake', () => {
  it('sends the input with its own request id, idempotently', async () => {
    const calls: unknown[] = [];
    const client = {
      call: async (...args: unknown[]) => {
        calls.push(args);
        return { matterId: 'm-1', number: 'M-2026-0001', status: 'open' };
      },
    };
    const requestId = '7c8d2f8e-34d4-4b8e-9a4f-3d1b5f3c2a10';
    await createMatterFromIntake(client as never, { requestId, matter: { title: 'T' } } as never);
    expect(calls).toEqual([['matters-createMatter', { matter: { title: 'T' } }, { idempotent: true, requestId }]]);
  });
});
