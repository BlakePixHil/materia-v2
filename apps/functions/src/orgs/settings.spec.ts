import { randomUUID } from 'node:crypto';

import type { Role } from '@materia/domain';

import { memberSecurityDefinition, updateSettingsDefinition } from './settings';
import { memoryAuth, memoryFirestore } from './testing';
import { csvCell } from '../audit/query';
import { clearRetentionCache } from '../audit/retention';
import { createLog } from '../core/log';
import { FakeClock, fakePorts } from '../ports/fakes';

/**
 * `orgs-updateSettings` and `orgs-memberSecurity` (CORE-21) against an in-memory Firestore and
 * Auth. The emulator suite (tests/integration/org-settings.spec.ts) covers the role checks, the
 * reminder reschedule and new matter numbers end to end. Everything is fictional.
 */

const ORG = 'org-s';
const practice = {
  name: 'Fictional Bayside Legal',
  abn: '51 824 753 556',
  primaryJurisdiction: 'VIC' as const,
  jurisdictions: ['VIC' as const],
  timezone: 'Australia/Melbourne',
  holidayLocality: 'VIC_MELBOURNE' as const,
  retentionYears: 7,
};
const billing = {
  defaultRateCents: 45000,
  unitMinutes: 6,
  rounding: 'up' as const,
  gstRegistered: true,
  invoicePrefix: 'INV-',
  paymentTermsDays: 14,
};

function world(extra: Record<string, Record<string, unknown>> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Bayside Legal',
      jurisdictions: ['VIC', 'NSW'],
      primaryJurisdiction: 'VIC',
      timezone: 'Australia/Melbourne',
      holidayLocality: 'VIC_MELBOURNE',
      retentionYears: 7,
      billing,
    },
    [`orgs/${ORG}/counters/invoices`]: { next: 1 },
    [`orgs/${ORG}/members/owner`]: { role: 'owner', status: 'active', displayName: 'Olive Fictional' },
    [`orgs/${ORG}/members/lawyer`]: { role: 'lawyer', status: 'active', displayName: 'Lena Fictional' },
    'users/owner': { orgIds: [ORG], activeOrgId: ORG },
    'users/lawyer': { orgIds: [ORG], activeOrgId: ORG },
    ...extra,
  });
  const auth = memoryAuth([
    {
      uid: 'owner',
      email: 'owner@example.test',
      multiFactor: { enrolledFactors: [{ factorId: 'totp' }] },
      metadata: { lastSignInTime: 'Mon, 05 Oct 2026 01:00:00 GMT', lastRefreshTime: 'Mon, 05 Oct 2026 03:00:00 GMT' },
    },
    { uid: 'lawyer', email: 'lawyer@example.test' },
  ]);
  const clock = new FakeClock(new Date('2026-10-05T00:00:00Z'));
  const log = createLog({ fn: 'test' }, () => undefined);
  const ctx = <T>(input: T, role: Role = 'owner', uid = 'owner') => ({
    input: { requestId: randomUUID(), dryRun: false, ...input },
    uid,
    orgId: ORG,
    role,
    token: {},
    requestId: randomUUID(),
    log,
    clock,
    db: store.db,
    ports: fakePorts(),
    auth: () => auth.auth,
  });
  const audits = () => [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`));
  return { ...store, ...auth, ctx, audits, org: () => store.docs.get(`orgs/${ORG}`) ?? {} };
}

/** Runs the handler on the parsed input, as the callable wrapper does. */
const run = (w: ReturnType<typeof world>, input: Record<string, unknown>, role?: Role) =>
  updateSettingsDefinition.handler({
    ...w.ctx({}, role),
    input: updateSettingsDefinition.input.parse({ requestId: randomUUID(), ...input }),
  } as never);

beforeEach(() => clearRetentionCache());

describe('orgs-updateSettings', () => {
  it('saves the practice, removes nothing in use, and audits the change', async () => {
    const w = world();
    const result = await run(w, { practice: { ...practice, name: 'Fictional Bayside Lawyers' } });
    expect(result.saved).toBe(true);
    expect(result.impact.changed).toEqual(expect.arrayContaining(['name', 'abn', 'jurisdictions']));
    expect(w.org()).toMatchObject({ name: 'Fictional Bayside Lawyers', abn: '51824753556', jurisdictions: ['VIC'] });
    const [[, entry] = []] = w.audits();
    expect(entry).toMatchObject({ action: 'org.settings_updated', actor: { uid: 'owner' } });
    // The rename reaches every active member's claims.
    expect(w.records.get('lawyer')?.customClaims).toMatchObject({ orgName: 'Fictional Bayside Lawyers' });
  });

  it('does nothing when nothing changed', async () => {
    const w = world();
    const result = await run(w, { billing });
    expect(result).toEqual({
      saved: false,
      impact: { remindersRescheduled: 0, jurisdictionInUse: [], gstChanged: false, changed: [] },
    });
    expect(w.audits()).toHaveLength(0);
  });

  it('removes an emptied ABN', async () => {
    const w = world();
    await run(w, { practice });
    expect(w.org()['abn']).toBe('51824753556');
    await run(w, { practice: { ...practice, abn: '' } });
    expect(w.org()).not.toHaveProperty('abn');
  });

  it('refuses removing a jurisdiction open matters use, and lists them on a dry run', async () => {
    const w = world({
      [`orgs/${ORG}/matters/m-open`]: {
        number: 'M-2026-0001',
        title: 'Estate of Fictional A',
        jurisdiction: 'NSW',
        status: 'open',
      },
      [`orgs/${ORG}/matters/m-closed`]: {
        number: 'M-2026-0002',
        title: 'Estate of Fictional B',
        jurisdiction: 'NSW',
        status: 'closed',
      },
      [`orgs/${ORG}/matters/m-gone`]: {
        number: 'M-2026-0003',
        title: 'Estate of Fictional C',
        jurisdiction: 'NSW',
        status: 'open',
        deletedAt: new Date(),
      },
    });
    const dry = await run(w, { practice, dryRun: true });
    expect(dry.saved).toBe(false);
    expect(dry.impact.jurisdictionInUse).toEqual([
      { matterId: 'm-open', number: 'M-2026-0001', title: 'Estate of Fictional A', jurisdiction: 'NSW' },
    ]);
    await expect(run(w, { practice })).rejects.toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { matters: ['m-open'], jurisdictions: ['NSW'] },
    });
    expect(w.org()['jurisdictions']).toEqual(['VIC', 'NSW']);
  });

  it('counts the reminders a time zone change moves, without saving on a dry run', async () => {
    const deadline = (status: string, dueDate = '2026-12-01') => ({ orgId: ORG, status, dueDate, deletedAt: null });
    const w = world({
      [`orgs/${ORG}/matters/m-1/deadlines/d-1`]: deadline('upcoming'),
      [`orgs/${ORG}/matters/m-1/deadlines/d-2`]: deadline('upcoming'),
      [`orgs/${ORG}/matters/m-1/deadlines/d-3`]: deadline('done'),
      [`orgs/other/matters/m-9/deadlines/d-9`]: { ...deadline('upcoming'), orgId: 'other' },
    });
    const input = { practice: { ...practice, jurisdictions: ['VIC', 'NSW'], timezone: 'Australia/Perth' } };
    const dry = await run(w, { ...input, dryRun: true });
    expect(dry).toMatchObject({ saved: false, impact: { remindersRescheduled: 2 } });
    expect(w.org()['timezone']).toBe('Australia/Melbourne');
    const saved = await run(w, input);
    expect(saved).toMatchObject({ saved: true, impact: { remindersRescheduled: 2 } });
    expect(w.org()['timezone']).toBe('Australia/Perth');
  });

  it('reports a GST change and saves billing, fee defaults and the number format', async () => {
    const w = world();
    const result = await run(w, {
      billing: { ...billing, gstRegistered: false },
      feeDefaults: { will: { arrangement: 'fixed', amountCents: 88000 } },
      matterNumberFormat: '{TYPE}-{YY}-{seq:3}',
    });
    expect(result.impact.gstChanged).toBe(true);
    expect(w.org()).toMatchObject({
      billing: { gstRegistered: false },
      feeDefaults: { will: { arrangement: 'fixed', amountCents: 88000 } },
      matterNumberFormat: '{TYPE}-{YY}-{seq:3}',
    });
  });

  it('sets the next invoice number only before the first invoice', async () => {
    const w = world();
    await run(w, { nextInvoiceNumber: 1001 });
    expect(w.docs.get(`orgs/${ORG}/counters/invoices`)).toEqual({ next: 1001 });
    w.docs.set(`orgs/${ORG}/invoices/i-1`, { number: 'INV-1001' });
    await expect(run(w, { nextInvoiceNumber: 5 })).rejects.toMatchObject({ code: 'FAILED_PRECONDITION' });
  });

  it('is for owners and admins', () => {
    expect(updateSettingsDefinition.roles).toEqual(['owner', 'admin']);
  });
});

describe('orgs-memberSecurity', () => {
  it('reports MFA and last activity for the org’s members only', async () => {
    const w = world();
    const result = await memberSecurityDefinition.handler(
      w.ctx({ uids: ['owner', 'lawyer', 'stranger'] }, 'admin', 'owner') as never,
    );
    expect(result.members).toEqual([
      {
        uid: 'owner',
        mfaEnrolled: true,
        lastSignInAt: '2026-10-05T01:00:00.000Z',
        lastActiveAt: '2026-10-05T03:00:00.000Z',
      },
      { uid: 'lawyer', mfaEnrolled: false, lastSignInAt: null, lastActiveAt: null },
    ]);
    expect(memberSecurityDefinition.roles).toEqual(['owner', 'admin']);
  });
});

describe('audit CSV cells', () => {
  it('quotes when needed and never starts a formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(undefined)).toBe('');
  });
});
