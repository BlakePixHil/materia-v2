import { TestBed } from '@angular/core/testing';

import { CONFLICT_CALLABLES, matterConflictsRepository } from './conflicts';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** The conflict check's matter reads (CORE-02). Fictional data only. */

const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};

function setup(data: Record<string, unknown>) {
  const fs = new InMemoryFirestore();
  fs.set('orgs/org-a/matters/m-1', {
    number: 'M-2026-0300',
    title: 'Estate of Fictional Quill',
    type: 'probate',
    status: 'lead',
    clientContactIds: ['c-1'],
    jurisdiction: 'VIC',
    responsibleUid: 'u-jordan',
    fee: { arrangement: 'hourly', history: [] },
    costsDisclosure: { status: 'required' },
    deletedAt: null,
    ...meta,
    ...data,
  });
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  return TestBed.runInInjectionContext(() => matterConflictsRepository());
}

describe('matterConflictsRepository', () => {
  it('reads the subjects, the determination and any alert, dropping the rest', async () => {
    const repo = setup({
      deceased: { contactId: 'c-2', dateOfDeath: '2026-09-01', domicile: 'VIC', lastAddress: '1 Fictional St' },
      conflictCheck: { status: 'potential', checkedBy: 'u-priya', resultId: 'chk-1', reason: 'Consent on file' },
      conflictAlert: { checkId: 'chk-2', contactId: 'c-3', at: new Date('2026-10-01T00:00:00Z'), adverse: true },
      wipCents: 1200,
    });
    const matter = await repo.get('m-1');
    expect(matter).toMatchObject({
      id: 'm-1',
      number: 'M-2026-0300',
      status: 'lead',
      clientContactIds: ['c-1'],
      deceased: { contactId: 'c-2' },
      conflictCheck: { status: 'potential', reason: 'Consent on file' },
      conflictAlert: { checkId: 'chk-2', adverse: true },
    });
    expect(matter).not.toHaveProperty('wipCents');
  });

  it('reads a matter with no check or alert yet', async () => {
    const matter = await setup({}).get('m-1');
    expect(matter?.conflictCheck).toBeUndefined();
    expect(matter?.conflictAlert).toBeUndefined();
  });

  it('names the conflicts callables', () => {
    expect(CONFLICT_CALLABLES).toEqual({ run: 'conflicts-run', determine: 'conflicts-determine' });
  });
});
