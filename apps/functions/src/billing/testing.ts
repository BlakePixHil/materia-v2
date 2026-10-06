import { randomUUID } from 'node:crypto';

import type { Role } from '@materia/domain';

import { saveDraftDefinition } from './drafts';
import { issueDefinition } from './issue';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** A fictional firm with one matter, its time and a disbursement, for the invoicing and payments tests (BILL-07, BILL-08). */

export const ORG = 'org-inv';
export const M = `orgs/${ORG}/matters/m1`;
export const NOW = new Date('2026-10-06T00:00:00Z');
export const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
export const PDF = new TextEncoder().encode('%PDF-1.7 fictional invoice');

export const member = (role: Role, displayName: string) => ({
  ...meta,
  role,
  status: 'active',
  displayName,
  defaultRateCents: 44000,
  rates: [],
});
export const time = (amountCents: number, extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  uid: 'user-lawyer',
  date: '2026-09-01',
  minutes: 60,
  units: 10,
  rateCents: 44000,
  amountCents,
  narrative: 'Advice on the will',
  billable: true,
  status: 'final',
  deletedAt: null,
  ...extra,
});
export const disbursement = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  date: '2026-09-02',
  description: 'Probate filing fee',
  payee: 'Supreme Court of Victoria',
  amountExGstCents: 33310,
  gstCents: 0,
  gstTreatment: 'gst_free',
  status: 'unbilled',
  deletedAt: null,
  ...extra,
});

export function world(initial: Record<string, Record<string, unknown>> = {}, flagOn = true) {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Harbour & Vine Legal',
      abn: '12345678901',
      timezone: 'Australia/Melbourne',
      billing: { gstRegistered: true, invoicePrefix: 'INV-', paymentTermsDays: 14, unitMinutes: 6 },
      flags: { 'billing.invoicing': flagOn },
    },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer', 'Pat Lawyer'),
    [`orgs/${ORG}/members/user-owner`]: member('owner', 'Olive Owner'),
    [`orgs/${ORG}/contacts/c1`]: {
      ...meta,
      kind: 'person',
      givenNames: 'Lan',
      familyName: 'Nguyễn',
      emails: [{ type: 'personal', address: 'lan@example.com' }],
      addresses: [
        { type: 'postal', line1: '1 Fictional St', suburb: 'Geelong', state: 'VIC', postcode: '3220', country: 'AU' },
      ],
    },
    [M]: {
      ...meta,
      number: 'M-2026-0042',
      title: 'Estate of the late Wren',
      clientContactIds: ['c1'],
      responsibleUid: 'user-lawyer',
      fee: { arrangement: 'hourly', revision: 0, history: [] },
      wipCents: 0,
    },
    [`${M}/timeEntries/t1`]: time(44000),
    [`${M}/timeEntries/t2`]: time(13200, { date: '2026-09-05', units: 3 }),
    [`${M}/timeEntries/draft`]: time(1000, { status: 'draft' }),
    [`${M}/disbursements/d1`]: disbursement(),
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const ports = fakePorts({ clock });
  const doc = (path: string) => store.docs.get(path) as Record<string, unknown> | undefined;
  const deps: CallableDeps = {
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
  };
  const call = <T>(
    definition: CallableDefinition<never, T>,
    data: Record<string, unknown>,
    role: Role = 'lawyer',
  ): Promise<T> =>
    runCallable(
      definition as unknown as CallableDefinition<never, T>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps,
    );
  const entries = (prefix: string) =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, d]) => ({ path, ...d }));
  const triggerCtx = (params: Record<string, string>) =>
    ({
      params: { orgId: ORG, ...params },
      db: store.db,
      clock,
      log: createLog({ fn: 'test' }, () => undefined),
      ports,
      time: NOW,
      eventId: 'e1',
    }) as unknown as TriggerContext;
  return { ...store, clock, ports, doc, call, entries, triggerCtx };
}

export type World = ReturnType<typeof world>;
export const save = (w: World, fields: Record<string, unknown> = {}, invoiceId?: string) =>
  w.call(saveDraftDefinition as never, { matterId: 'm1', fields, ...(invoiceId ? { invoiceId } : {}) }) as Promise<{
    invoiceId: string;
    totalCents: number;
    warnings: string[];
  }>;
export const issue = (w: World, invoiceId: string, role: Role = 'lawyer') =>
  w.call(issueDefinition as never, { invoiceId }, role) as Promise<{ number: string; totalCents: number }>;
export const invoice = (w: World, id: string) => w.doc(`orgs/${ORG}/invoices/${id}`) ?? {};
