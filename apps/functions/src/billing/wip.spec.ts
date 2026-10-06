import type { Role } from '@materia/domain';

import { wipDefinition } from './wip';
import { runCallable, type CallableDeps } from '../core/callable';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** `billing-wip` (BILL-03). Every matter and amount is fictional. */
const ORG = 'org-b';
const NOW = new Date('2026-10-06T00:00:00Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };

const matter = (number: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  number,
  title: `Estate ${number}`,
  type: 'probate',
  status: 'open',
  responsibleUid: 'user-lawyer',
  fee: { arrangement: 'hourly', history: [] },
  ...extra,
});
const time = (matterId: string, date: string, amountCents: number, extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId,
  uid: 'user-lawyer',
  date,
  minutes: 30,
  units: 5,
  rateCents: 44000,
  amountCents,
  billable: true,
  status: 'final',
  ...extra,
});

function setup() {
  const m = (id: string) => `orgs/${ORG}/matters/${id}`;
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Corio Legal', timezone: 'Australia/Melbourne' },
    [m('m1')]: matter('WE-118', { budget: { pct: 41 }, lastInvoicedOn: '2026-08-31' }),
    [m('m2')]: matter('WE-097', { status: 'closed' }),
    [m('m3')]: matter('WE-151', { disbursementWipCents: 35000 }),
    [m('m4')]: matter('WE-090', { deletedAt: NOW }),
    [`${m('m1')}/timeEntries/a`]: time('m1', '2026-08-20', 13200),
    [`${m('m1')}/timeEntries/b`]: time('m1', '2026-09-10', 8800),
    [`${m('m1')}/timeEntries/c`]: time('m1', '2026-09-11', 99900, { status: 'draft' }),
    [`${m('m1')}/timeEntries/d`]: time('m1', '2026-09-12', 99900, { billable: false }),
    [`${m('m2')}/timeEntries/a`]: time('m2', '2026-10-01', 4400),
    [`${m('m4')}/timeEntries/a`]: time('m4', '2026-10-01', 4400),
    [`orgs/org-other/matters/x/timeEntries/a`]: time('x', '2026-10-01', 4400, { orgId: 'org-other' }),
  });
  const deps: CallableDeps = {
    db: () => store.db,
    clock: new FakeClock(NOW),
    ports: () => fakePorts(),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  };
  const call = (role: Role = 'lawyer') =>
    runCallable(wipDefinition, { data: {}, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } }, deps);
  return { call };
}

describe('billing-wip', () => {
  it('sums final billable time per matter, adds disbursement-only matters and flags closed ones', async () => {
    const result = await setup().call();
    expect(result.truncated).toBe(false);
    expect(result.totalCents).toBe(22000 + 35000 + 4400);
    expect(result.rows.map((row) => [row.number, row.timeCents, row.disbursementCents, row.closed])).toEqual([
      ['WE-151', 0, 35000, false],
      ['WE-118', 22000, 0, false],
      ['WE-097', 4400, 0, true],
    ]);
    expect(result.rows[1]).toMatchObject({
      entries: 2,
      oldestDate: '2026-08-20',
      ageDays: 47,
      budgetPct: 41,
      lastInvoicedOn: '2026-08-31',
    });
  });

  it('needs billing.view', async () => {
    await expect(setup().call('paralegal')).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
