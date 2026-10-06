import { PERMISSIONS } from './permissions';
import { TrustSnapshot } from './schemas/org-records';
import {
  asAtProblem,
  MAX_TRUST_BALANCE_CENTS,
  RecordTrustSnapshotInput,
  TRUST_EXPLAINER,
  trustRecordsName,
  trustSettingsOf,
  TrustSettingsInput,
  trustSnapshotLine,
  trustSnapshotOutOfDate,
  TRUST_NOTICE_TEMPLATE,
  trustNoticeFor,
} from './trust';
import { dateOnly } from './values/date-only';

const REQUEST = '6f1c0f0e-7a43-4c65-9a3c-2f1d1f6a8b10';
const d = dateOnly;

describe('trust snapshots (BILL-11)', () => {
  it('takes integer cents of zero or more, up to a billion dollars', () => {
    const input = (amountCents: number) =>
      RecordTrustSnapshotInput.safeParse({ requestId: REQUEST, matterId: 'm-1', amountCents, asAt: '2026-10-03' });
    expect(input(8_421_000).success).toBe(true);
    expect(input(0).success).toBe(true);
    expect(input(-1).success).toBe(false);
    expect(input(12.5).success).toBe(false);
    expect(input(MAX_TRUST_BALANCE_CENTS).success).toBe(true);
    expect(input(MAX_TRUST_BALANCE_CENTS + 1).success).toBe(false);
  });

  it('takes a real as-at date and an optional short note', () => {
    const base = { requestId: REQUEST, matterId: 'm-1', amountCents: 500_000 };
    expect(RecordTrustSnapshotInput.safeParse({ ...base, asAt: '2026-02-30' }).success).toBe(false);
    expect(RecordTrustSnapshotInput.safeParse({ ...base, asAt: '3/10/2026' }).success).toBe(false);
    expect(RecordTrustSnapshotInput.parse({ ...base, asAt: '2026-10-03', note: '  ledger report 3 Oct ' }).note).toBe(
      'ledger report 3 Oct',
    );
    expect(RecordTrustSnapshotInput.safeParse({ ...base, asAt: '2026-10-03', note: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('refuses an as-at date in the future, and allows long-past ones', () => {
    expect(asAtProblem(d('2026-10-06'), d('2026-10-05'))).toBe('The as-at date can’t be in the future');
    expect(asAtProblem(d('2026-10-05'), d('2026-10-05'))).toBeNull();
    expect(asAtProblem(d('2019-01-01'), d('2026-10-05'))).toBeNull();
  });

  it('is out of date past the threshold, not on it', () => {
    expect(trustSnapshotOutOfDate(d('2026-09-05'), d('2026-10-05'), 30)).toBe(false);
    expect(trustSnapshotOutOfDate(d('2026-09-04'), d('2026-10-05'), 30)).toBe(true);
    expect(trustSnapshotOutOfDate(d('2026-10-05'), d('2026-10-05'), 1)).toBe(false);
    expect(trustSnapshotOutOfDate(d('2026-08-28'), d('2026-10-05'), 60)).toBe(false);
  });

  it('names its source and as-at date', () => {
    expect(trustSnapshotLine({ asAt: d('2026-10-03'), sourceSystemName: 'Smokeball' })).toBe(
      'as at 3 Oct 2026 · from Smokeball',
    );
    expect(trustRecordsName({ system: 'leap' })).toBe('LEAP');
    expect(trustRecordsName({ system: 'other', otherName: 'In-house trust records' })).toBe('In-house trust records');
    expect(trustRecordsName({ system: 'other' })).toBe('Trust records');
  });

  it('stores only snapshot fields, server-side', () => {
    expect(Object.keys(TrustSnapshot.update.shape)).toEqual([]);
    const snapshot = TrustSnapshot.schema.safeParse({
      matterId: 'm-1',
      amountCents: -5,
      asAt: '2026-10-03',
      source: 'manual',
      sourceSystemName: 'Smokeball',
      recordedBy: 'u-1',
      recordedAt: new Date(),
      createdAt: new Date(),
      createdBy: 'u-1',
      updatedAt: new Date(),
      updatedBy: 'u-1',
      schemaVersion: 1,
    });
    expect(snapshot.success).toBe(false);
  });

  it('settings: off by default, 30 days, other records need a name', () => {
    expect(trustSettingsOf(undefined)).toEqual({
      showOnMatters: false,
      system: 'other',
      otherName: undefined,
      staleAfterDays: 30,
    });
    expect(TrustSettingsInput.safeParse({ showOnMatters: true, system: 'other', staleAfterDays: 30 }).success).toBe(
      false,
    );
    expect(TrustSettingsInput.safeParse({ showOnMatters: true, system: 'leap', staleAfterDays: 0 }).success).toBe(
      false,
    );
    expect(
      TrustSettingsInput.parse({ showOnMatters: true, system: 'leap', otherName: 'stale', staleAfterDays: 14 }),
    ).toStrictEqual({ showOnMatters: true, system: 'leap', staleAfterDays: 14 });
    expect(TRUST_EXPLAINER).toContain('It is not the trust ledger.');
  });

  it('only billing roles record a balance', () => {
    for (const role of PERMISSIONS['trust.record']) expect(PERMISSIONS['billing.view']).toContain(role);
    expect(PERMISSIONS['trust.record']).not.toContain('paralegal');
  });
});

describe('the r 42(3) notice (BILL-12)', () => {
  const values = { firm: 'Harbour & Vine Legal', amount: '$1,936.00', matter: 'M-2026-0142', number: 'INV-000042' };

  it('fills the versioned template', () => {
    const notice = trustNoticeFor(values);
    expect(notice.version).toBe(TRUST_NOTICE_TEMPLATE.version);
    expect(notice.text).toBe(
      'Notice of intended withdrawal from trust. Harbour & Vine Legal intends to withdraw $1,936.00 from money ' +
        'held in trust for you on M-2026-0142 to pay this invoice (INV-000042). If you object to the withdrawal, ' +
        'please tell us within 7 business days of receiving this invoice.',
    );
  });

  it('keeps a later wording’s version, and leaves unknown placeholders alone', () => {
    expect(trustNoticeFor(values, { version: 2, body: '{firm} · {number} · {available}' })).toEqual({
      version: 2,
      text: 'Harbour & Vine Legal · INV-000042 · {available}',
    });
  });
});
