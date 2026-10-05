import { TestBed } from '@angular/core/testing';

import { TIME_CALLABLES } from '@materia/domain';

import { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';
import { MATTER_TIME_QUERY, matterTimeRepository, timeCallables } from './time-entries';

/** Time entries: reads, client-direct drafts and time-setStatus (BILL-01). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const M = 'orgs/org-a/matters/m-1/timeEntries';

function entry(date: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: 'org-a',
    matterId: 'm-1',
    uid: 'u-jordan',
    date,
    minutes: 18,
    units: 3,
    rateCents: 44000,
    amountCents: 13200,
    narrative: 'Perusing and considering the will',
    billable: true,
    status: 'draft',
    source: 'manual',
    wipCountedCents: 13200,
    ...meta,
    ...extra,
  };
}

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('matterTimeRepository', () => {
  it('lists a matter’s entries newest first and hides deleted ones', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/te-1`, entry('2026-10-01'));
    fs.set(`${M}/te-2`, entry('2026-10-03'));
    fs.set(`${M}/te-3`, entry('2026-10-02', { deletedAt: new Date('2026-10-04T00:00:00Z') }));
    const rows = await run(() => matterTimeRepository(() => 'm-1')).query(MATTER_TIME_QUERY);
    expect(rows.map((row) => row.id)).toEqual(['te-2', 'te-1']);
    expect(rows[0]).toMatchObject({ minutes: 18, units: 3, amountCents: 13200, status: 'draft' });
  });

  it('creates my own uncounted draft with the org and matter the rules require', async () => {
    const { fs, run } = setup();
    const repo = run(() => matterTimeRepository(() => 'm-1'));
    const id = await repo.create({
      date: '2026-10-05' as never,
      minutes: 18,
      units: 3,
      rateCents: 44000 as never,
      amountCents: 13200 as never,
      narrative: 'Attendance on executor',
      billable: true,
    });
    expect(fs.get(`${M}/${id}`)).toMatchObject({
      orgId: 'org-a',
      matterId: 'm-1',
      uid: 'u-jordan',
      status: 'draft',
      source: 'manual',
      wipCountedCents: 0,
      createdBy: 'u-jordan',
      schemaVersion: 1,
    });
  });

  it('refuses a create without a matter, and a zero duration', async () => {
    const { run } = setup();
    await expect(
      run(() => matterTimeRepository(() => null)).create({
        date: '2026-10-05',
        minutes: 6,
        narrative: '',
        billable: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      run(() => matterTimeRepository(() => 'm-1')).create({
        date: '2026-10-05',
        minutes: 0,
        units: 0,
        rateCents: 0,
        amountCents: 0,
        narrative: '',
        billable: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('timeCallables', () => {
  it('calls time-setStatus with a request id', async () => {
    const calls: { name: string; data: unknown }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data });
          return { updated: ['te-1'], skipped: [] } as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => '00000000-0000-4000-8000-000000000001' },
    );
    const result = await timeCallables(client).setStatus({ matterId: 'm-1', entryIds: ['te-1'], status: 'final' });
    expect(result).toEqual({ updated: ['te-1'], skipped: [] });
    expect(calls).toEqual([
      {
        name: TIME_CALLABLES.setStatus,
        data: {
          matterId: 'm-1',
          entryIds: ['te-1'],
          status: 'final',
          requestId: '00000000-0000-4000-8000-000000000001',
        },
      },
    ]);
  });
});
