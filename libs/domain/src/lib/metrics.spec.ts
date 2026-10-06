import {
  addMetricValues,
  canSeeMemberMetrics,
  clerkRollupValues,
  creditNoteMetrics,
  dayOfInstant,
  deadlineMetrics,
  deadlineSnapshotMetrics,
  debtorsRollupValues,
  diffContributions,
  disbursementMetrics,
  filterContribution,
  instantOf,
  invoiceMetrics,
  isEmptyContribution,
  isSnapshotKey,
  legacyBilledCents,
  matterMetrics,
  matterSnapshotMetrics,
  medianDays,
  memberMetricsKey,
  METRIC_DAYS_MAX,
  metricCell,
  metricHistogram,
  metricKeyPart,
  metricPeriodRange,
  metricPeriods,
  metricPeriodsBetween,
  metricsContribution,
  metricShardCount,
  metricsReferralOf,
  nextStageHistory,
  parseMetricCell,
  periodTargetMinutes,
  rollupMetrics,
  sameStages,
  splitMetricsKey,
  STAGE_HISTORY_MAX,
  subtractMetricValues,
  sumMetricShards,
  timeEntryMetrics,
  utilisationPct,
  workingDays,
} from './metrics';
import type { StageVisit } from './schemas/metrics';
import { dateOnly } from './values/date-only';

/** INS-01: the practice metrics rollups (ADR-048). Every amount, name and id is fictional. */

const d = (value: string) => dateOnly(value);
/** 10:00 Melbourne (AEDT) on the day, as Firestore hands it over. */
const at = (day: string) => ({ seconds: Date.parse(`${day}T10:00:00+11:00`) / 1000, nanoseconds: 0 });

describe('periods', () => {
  it('names the day, month and Australian FY a day rolls up into', () => {
    expect(metricPeriods(d('2026-10-06'))).toEqual({ day: 'day-2026-10-06', month: 'month-2026-10', fy: 'fy-2026' });
  });

  it('puts 30 June in the FY ending that day and 1 July in the next', () => {
    expect(metricPeriods(d('2026-06-30')).fy).toBe('fy-2025');
    expect(metricPeriods(d('2026-07-01')).fy).toBe('fy-2026');
    // A calendar-year FY.
    expect(metricPeriods(d('2026-06-30'), 1).fy).toBe('fy-2026');
  });

  it('gives each period its first and last day', () => {
    expect(metricPeriodRange('day-2026-02-03')).toEqual({ start: '2026-02-03', end: '2026-02-03' });
    expect(metricPeriodRange('month-2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(metricPeriodRange('fy-2025')).toEqual({ start: '2025-07-01', end: '2026-06-30' });
    expect(metricPeriodRange('fy-2026', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(metricPeriodRange('clerk-2026-10')).toBeNull();
    expect(metricPeriodRange('debtors-2026-10-06')).toBeNull();
  });

  it('lists every period touching a range, across the FY boundary', () => {
    expect(metricPeriodsBetween(d('2026-06-30'), d('2026-07-01'))).toEqual([
      'day-2026-06-30',
      'month-2026-06',
      'fy-2025',
      'day-2026-07-01',
      'month-2026-07',
      'fy-2026',
    ]);
  });
});

describe('keys and cells', () => {
  it('keeps key parts to letters, digits, _ and -', () => {
    expect(metricKeyPart('probate')).toBe('probate');
    expect(metricKeyPart('Wills & estates.v2')).toBe('Wills___estates_v2');
    expect(metricKeyPart('')).toBe('_');
    expect(metricKeyPart('x'.repeat(80))).toHaveLength(64);
  });

  it('tells snapshot figures from counted ones', () => {
    expect(isSnapshotKey('wip.timeCents')).toBe(true);
    expect(isSnapshotKey('clerk.tokens.in')).toBe(true);
    expect(isSnapshotKey('time.minutes')).toBe(false);
  });

  it('round-trips org and member cells', () => {
    expect(metricCell(d('2026-10-06'))).toBe('2026-10-06');
    expect(metricCell(d('2026-10-06'), 'u1')).toBe('2026-10-06|u1');
    expect(parseMetricCell('2026-10-06|u1')).toEqual({ date: '2026-10-06', uid: 'u1' });
    expect(parseMetricCell('2026-10-06')).toEqual({ date: '2026-10-06' });
    expect(parseMetricCell('not-a-day')).toBeNull();
  });

  it('round-trips member document keys', () => {
    expect(memberMetricsKey('month-2026-10', 'u1')).toBe('month-2026-10/byMember/u1');
    expect(splitMetricsKey('month-2026-10/byMember/u1')).toEqual({ period: 'month-2026-10', uid: 'u1' });
    expect(splitMetricsKey('fy-2026')).toEqual({ period: 'fy-2026' });
  });
});

describe('instants', () => {
  it('reads the shapes Firestore and the app use', () => {
    const iso = '2026-10-05T23:30:00.000Z';
    const when = new Date(iso);
    expect(instantOf(when)).toEqual(when);
    expect(instantOf(when.getTime())).toEqual(when);
    expect(instantOf(iso)).toEqual(when);
    expect(instantOf({ toDate: () => when })).toEqual(when);
    expect(instantOf({ seconds: when.getTime() / 1000, nanoseconds: 5_000_000 })?.getTime()).toBe(when.getTime() + 5);
    expect(instantOf({ _seconds: when.getTime() / 1000 })).toEqual(when);
    expect(instantOf(new Date('nope'))).toBeNull();
    expect(instantOf('nope')).toBeNull();
    expect(instantOf({})).toBeNull();
    expect(instantOf(undefined)).toBeNull();
  });

  it('takes the day in the org time zone', () => {
    // 23:30 UTC on the 5th is 10:30 on the 6th in Melbourne.
    expect(dayOfInstant('2026-10-05T23:30:00Z')).toBe('2026-10-06');
    expect(dayOfInstant('2026-10-05T23:30:00Z', 'UTC')).toBe('2026-10-05');
    expect(dayOfInstant(null)).toBeNull();
  });
});

describe('values', () => {
  it('adds, subtracts and drops zeros', () => {
    expect(addMetricValues({ a: 1, b: 2 }, { a: -1, c: 3 })).toEqual({ b: 2, c: 3 });
    expect(addMetricValues({ a: 1 }, { a: 1 }, -1)).toEqual({});
    expect(subtractMetricValues({ a: 5, b: 1 }, { a: 2, b: 1, c: 4 })).toEqual({ a: 3, c: -4 });
  });

  it('sums a period document with its shards', () => {
    expect(sumMetricShards({ a: 1, label: 'x' }, [{ a: 2, b: 3 }, undefined])).toEqual({ a: 3, b: 3 });
    expect(sumMetricShards(undefined)).toEqual({});
  });
});

describe('timeEntryMetrics', () => {
  const entry = {
    uid: 'u-ellis',
    date: '2026-10-06',
    minutes: 90,
    amountCents: 60_000,
    billable: true,
    status: 'final',
  };

  it('counts time for the org, the matter type and the author on the work date', () => {
    expect(timeEntryMetrics(entry, { type: 'probate' })).toEqual({
      '2026-10-06': {
        'time.entries': 1,
        'time.minutes': 90,
        'time.valueCents': 60_000,
        'time.billable.minutes': 90,
        'time.billable.valueCents': 60_000,
        'time.recordedCents': 60_000,
        'time.type.probate.minutes': 90,
        'time.type.probate.valueCents': 60_000,
      },
      '2026-10-06|u-ellis': {
        'time.entries': 1,
        'time.minutes': 90,
        'time.valueCents': 60_000,
        'time.billable.minutes': 90,
        'time.billable.valueCents': 60_000,
        'time.recordedCents': 60_000,
      },
    });
  });

  it('splits non-billable time and counts billed value', () => {
    const nonBillable = timeEntryMetrics({ ...entry, billable: false, amountCents: 0 });
    expect(nonBillable['2026-10-06']).toEqual({
      'time.entries': 1,
      'time.minutes': 90,
      'time.nonBillable.minutes': 90,
    });
    const billed = timeEntryMetrics({ ...entry, status: 'billed' });
    expect(billed['2026-10-06']?.['time.billedCents']).toBe(60_000);
  });

  it('counts write-offs at the original amount and write-downs as the reduction', () => {
    const off = timeEntryMetrics({
      ...entry,
      status: 'written_off',
      amountCents: 0,
      writeDown: { originalAmountCents: 60_000 },
    });
    expect(off['2026-10-06']?.['billing.writtenOff.timeCents']).toBe(60_000);
    expect(off['2026-10-06']?.['time.recordedCents']).toBeUndefined();
    const offPlain = timeEntryMetrics({ ...entry, status: 'written_off' });
    expect(offPlain['2026-10-06']?.['billing.writtenOff.timeCents']).toBe(60_000);
    const down = timeEntryMetrics({ ...entry, amountCents: 45_000, writeDown: { originalAmountCents: 60_000 } });
    expect(down['2026-10-06']?.['billing.writtenDown.timeCents']).toBe(15_000);
  });

  it('adds nothing for a deleted, dateless or missing entry, and skips the member cell without an author', () => {
    expect(timeEntryMetrics(undefined)).toEqual({});
    expect(timeEntryMetrics({ ...entry, deletedAt: at('2026-10-07') })).toEqual({});
    expect(timeEntryMetrics({ ...entry, date: 'soon' })).toEqual({});
    expect(Object.keys(timeEntryMetrics({ ...entry, uid: undefined }))).toEqual(['2026-10-06']);
  });
});

describe('disbursementMetrics', () => {
  it('counts the ex-GST amount on its date, and write-offs', () => {
    const row = { date: '2026-10-06', amountExGstCents: 12_500, status: 'unbilled' };
    expect(disbursementMetrics(row)).toEqual({
      '2026-10-06': { 'disbursements.count': 1, 'disbursements.exGstCents': 12_500 },
    });
    expect(
      disbursementMetrics({ ...row, status: 'written_off' })['2026-10-06']?.['billing.writtenOff.disbursementsCents'],
    ).toBe(12_500);
    expect(disbursementMetrics({ ...row, deletedAt: at('2026-10-07') })).toEqual({});
    expect(disbursementMetrics(undefined)).toEqual({});
  });
});

describe('referrals', () => {
  it('reads the referrer and its industry', () => {
    expect(metricsReferralOf({ referrerContactId: 'c-acct' }, { referrerMeta: { industry: 'accountant' } })).toEqual({
      referrerId: 'c-acct',
      industry: 'accountant',
    });
    expect(metricsReferralOf({ referrerContactId: 'c-acct' }, null)).toEqual({
      referrerId: 'c-acct',
      industry: 'unknown',
    });
    expect(metricsReferralOf({ referralSource: 'website' })).toEqual({});
    expect(metricsReferralOf(undefined)).toEqual({});
  });
});

describe('invoiceMetrics', () => {
  const invoice = {
    status: 'issued',
    issueDate: '2026-06-30',
    subtotalCents: 110_000,
    gstCents: 11_000,
    lines: [{ kind: 'time', amountExGstCents: 100_000 }, { kind: 'disbursement', amountExGstCents: 10_000 }, null],
  };
  const referral = { referrerId: 'c-acct', industry: 'accountant' };

  it('counts what it billed on the issue date, with the referred fees', () => {
    expect(invoiceMetrics(invoice, referral)).toEqual({
      '2026-06-30': {
        'billing.invoices': 1,
        'billing.invoicedCents': 110_000,
        'billing.invoicedGstCents': 11_000,
        'billing.invoicedFeesCents': 100_000,
        'billing.invoicedDisbursementsCents': 10_000,
        'referrals.billedCents': 100_000,
        'referrals.referrer.c-acct.billedCents': 100_000,
        'referrals.industry.accountant.billedCents': 100_000,
      },
    });
  });

  it('counts payments on their dates, refunds against, reversed ones not at all', () => {
    const paid = invoiceMetrics({
      ...invoice,
      status: 'part_paid',
      payments: [
        { date: '2026-07-01', amountCents: 50_000 },
        { date: '2026-07-02', amountCents: 20_000, reversedAt: at('2026-07-03') },
        { date: '2026-07-04', amountCents: 5_000, kind: 'refund' },
        { date: 'whenever', amountCents: 1 },
        null,
      ],
    });
    expect(paid['2026-07-01']).toEqual({ 'billing.collectedCents': 50_000, 'billing.payments': 1 });
    expect(paid['2026-07-02']).toBeUndefined();
    expect(paid['2026-07-04']).toEqual({ 'billing.collectedCents': -5_000, 'billing.refunds': 1 });
  });

  it('adds nothing for a draft, and only payments for a void', () => {
    expect(invoiceMetrics({ ...invoice, status: 'draft' })).toEqual({});
    expect(invoiceMetrics(undefined)).toEqual({});
    expect(invoiceMetrics({ ...invoice, status: 'void' })).toEqual({});
    expect(invoiceMetrics({ status: 'issued' })).toEqual({});
  });
});

describe('creditNoteMetrics', () => {
  it('counts the credit on its issue date, and the referred fees credited', () => {
    const note = {
      issueDate: '2026-10-06',
      subtotalCents: 20_000,
      gstCents: 2_000,
      lines: [{ kind: 'time', amountExGstCents: 20_000 }],
    };
    expect(creditNoteMetrics(note, { referrerId: 'c-acct' })).toEqual({
      '2026-10-06': {
        'billing.creditNotes': 1,
        'billing.creditedCents': 20_000,
        'billing.creditedGstCents': 2_000,
        'billing.creditedFeesCents': 20_000,
        'referrals.creditedCents': 20_000,
        'referrals.referrer.c-acct.creditedCents': 20_000,
        'referrals.industry.unknown.creditedCents': 20_000,
      },
    });
    expect(creditNoteMetrics(undefined)).toEqual({});
    expect(creditNoteMetrics({ issueDate: 'later' })).toEqual({});
  });
});

describe('legacyBilledCents', () => {
  it('reads dollars or cents, ignoring anything else', () => {
    expect(legacyBilledCents({ billingTotal: 1234.5 })).toBe(123_450);
    expect(legacyBilledCents({ billingTotal: '$1,234.50' })).toBe(123_450);
    expect(legacyBilledCents({ billingTotalCents: 99.6 })).toBe(100);
    expect(legacyBilledCents({ billingTotal: -5 })).toBe(0);
    expect(legacyBilledCents({ billingTotal: 'n/a' })).toBe(0);
    expect(legacyBilledCents({ billingTotal: true })).toBe(0);
    expect(legacyBilledCents(undefined)).toBe(0);
  });
});

describe('matterMetrics', () => {
  const matter = {
    status: 'active',
    type: 'probate',
    createdAt: at('2026-01-10'),
    referrerContactId: 'c-acct',
  };

  it('counts an open matter on its creation day, by type and referrer', () => {
    expect(matterMetrics(matter, { referrerIndustry: 'accountant' })).toEqual({
      '2026-01-10': {
        'matters.opened': 1,
        'matters.opened.type.probate': 1,
        'matters.opened.referred': 1,
        'matters.opened.referrer.c-acct': 1,
        'matters.opened.industry.accountant': 1,
      },
    });
  });

  it('counts an unreferred matter by its source', () => {
    const cells = matterMetrics({ ...matter, referrerContactId: undefined, referralSource: 'website' });
    expect(cells['2026-01-10']?.['matters.opened.source.website']).toBe(1);
    const none = matterMetrics({ ...matter, referrerContactId: undefined });
    expect(none['2026-01-10']?.['matters.opened.source.none']).toBe(1);
  });

  it('does not count a lead, a deleted or a destroyed matter', () => {
    expect(matterMetrics({ ...matter, status: 'lead' })).toEqual({});
    expect(matterMetrics({ ...matter, deletedAt: at('2026-02-01') })).toEqual({});
    expect(matterMetrics({ ...matter, destroyedAt: at('2033-02-01') })).toEqual({});
    expect(matterMetrics(undefined)).toEqual({});
  });

  it('counts the close, the cycle times and the legacy billing', () => {
    const closed = {
      ...matter,
      status: 'closed',
      closedAt: at('2026-09-30'),
      estate: { grantDate: '2026-05-01' },
      closing: { finalDistributionRecorded: true },
      legacyBilling: { billingTotal: 5500, billingDate: '2019-03-14' },
    };
    const cells = matterMetrics(closed);
    expect(cells['2026-09-30']).toEqual({
      'matters.closed': 1,
      'matters.closed.type.probate': 1,
      'matters.closed.referrer.c-acct': 1,
      'cycle.probate.grantToDistribution.d152': 1,
    });
    expect(cells['2026-05-01']).toEqual({ 'cycle.probate.instructionsToGrant.d111': 1 });
    expect(cells['2019-03-14']).toEqual({ 'legacy.billed': 1, 'legacy.billedCents': 550_000 });
  });

  it('skips grant to distribution until the final distribution is recorded, and grants before opening', () => {
    const cells = matterMetrics({
      ...matter,
      status: 'archived',
      closedAt: at('2026-09-30'),
      estate: { grantDate: '2025-12-01' },
    });
    expect(Object.keys(cells).sort()).toEqual(['2026-01-10', '2026-09-30']);
    expect(cells['2026-09-30']?.['cycle.probate.grantToDistribution.d303']).toBeUndefined();
  });

  it('caps a histogram at ten years and turns finished stage stays into durations', () => {
    const stages: StageVisit[] = [
      { stageId: 'gathering', enteredOn: d('2026-01-10'), leftOn: d('2026-02-09') },
      { stageId: 'grant', enteredOn: d('2026-02-09') },
    ];
    const cells = matterMetrics(
      { ...matter, type: undefined, createdAt: at('2010-01-01'), estate: { grantDate: '2026-02-01' } },
      { stages },
    );
    expect(cells['2026-02-09']).toEqual({ 'stage.unknown.gathering.d30': 1 });
    expect(cells['2026-02-01']).toEqual({ [`cycle.unknown.instructionsToGrant.d${METRIC_DAYS_MAX}`]: 1 });
  });
});

describe('deadlineMetrics', () => {
  const deadline = { status: 'upcoming', dueDate: '2026-07-01', critical: true };

  it('counts a deadline as due on its due date', () => {
    expect(deadlineMetrics(deadline)).toEqual({ '2026-07-01': { 'deadlines.due': 1, 'deadlines.critical.due': 1 } });
  });

  it('counts how it was resolved', () => {
    const done = (on: string) => deadlineMetrics({ ...deadline, status: 'done', resolution: { on } })['2026-07-01'];
    expect(done('2026-07-01')?.['deadlines.metOnTime']).toBe(1);
    expect(done('2026-07-02')?.['deadlines.metLate']).toBe(1);
    expect(done('2026-07-02')?.['deadlines.critical.metLate']).toBe(1);
    expect(deadlineMetrics({ ...deadline, status: 'missed' })['2026-07-01']?.['deadlines.critical.missed']).toBe(1);
    const waived = deadlineMetrics({ ...deadline, critical: false, status: 'waived', override: { reason: 'x' } });
    expect(waived['2026-07-01']).toEqual({ 'deadlines.due': 1, 'deadlines.waived': 1, 'deadlines.overridden': 1 });
  });

  it('adds nothing for superseded, blocked or deleted deadlines', () => {
    expect(deadlineMetrics({ ...deadline, status: 'superseded' })).toEqual({});
    expect(deadlineMetrics({ ...deadline, dueDate: undefined })).toEqual({});
    expect(deadlineMetrics({ ...deadline, deletedAt: at('2026-07-02') })).toEqual({});
    expect(deadlineMetrics(undefined)).toEqual({});
  });
});

describe('metricsContribution', () => {
  const matter = { status: 'open', type: 'probate', createdAt: at('2026-01-10'), referrerContactId: 'c-acct' };
  const referrer = { referrerMeta: { industry: 'accountant' } };

  it('counts each kind of record with what it reads', () => {
    expect(
      metricsContribution('matter', matter, { referrer, timeZone: 'Australia/Melbourne' })['2026-01-10'],
    ).toMatchObject({
      'matters.opened.industry.accountant': 1,
    });
    expect(metricsContribution('matter', { ...matter, referrerContactId: undefined })['2026-01-10']).toMatchObject({
      'matters.opened': 1,
    });
    expect(metricsContribution('time', { date: '2026-10-06', minutes: 6 }, { matter })['2026-10-06']).toMatchObject({
      'time.type.probate.minutes': 6,
    });
    expect(metricsContribution('disbursement', { date: '2026-10-06', amountExGstCents: 100 })).toEqual(
      disbursementMetrics({ date: '2026-10-06', amountExGstCents: 100 }),
    );
    expect(metricsContribution('deadline', { status: 'upcoming', dueDate: '2026-10-06' })).toEqual(
      deadlineMetrics({ status: 'upcoming', dueDate: '2026-10-06' }),
    );
    const invoice = { status: 'issued', issueDate: '2026-10-06', subtotalCents: 100, lines: [] };
    expect(metricsContribution('invoice', invoice, { matter, referrer })['2026-10-06']).toMatchObject({
      'referrals.industry.accountant.billedCents': 100,
    });
    expect(
      metricsContribution('creditNote', { issueDate: '2026-10-06', subtotalCents: 50 }, { matter, referrer })[
        '2026-10-06'
      ],
    ).toMatchObject({
      'referrals.referrer.c-acct.creditedCents': 50,
    });
  });

  it('keeps the cells from a date on', () => {
    const cells = { '2026-06-30': { a: 1 }, '2026-07-01|u1': { a: 2 }, junk: { a: 3 } };
    expect(filterContribution(cells, (day) => day >= '2026-07-01')).toEqual({ '2026-07-01|u1': { a: 2 } });
  });

  it('compares stage histories', () => {
    const stay: StageVisit = { stageId: 'intake', enteredOn: d('2026-10-01') };
    expect(sameStages(undefined, [])).toBe(true);
    expect(sameStages([stay], [{ ...stay }])).toBe(true);
    expect(sameStages([stay], [{ ...stay, leftOn: d('2026-10-02') }])).toBe(false);
    expect(sameStages([stay], [])).toBe(false);
  });
});

describe('nextStageHistory', () => {
  const today = d('2026-10-06');

  it('opens a stay on the first stage and leaves an unchanged stage alone', () => {
    const first = nextStageHistory(undefined, { stageId: 'intake', stageEnteredOn: '2026-10-01' }, today);
    expect(first).toEqual([{ stageId: 'intake', enteredOn: '2026-10-01' }]);
    expect(nextStageHistory(first, { stageId: 'intake' }, today)).toEqual(first);
  });

  it('closes the open stay when the stage moves', () => {
    const history: StageVisit[] = [{ stageId: 'intake', enteredOn: d('2026-10-01') }];
    expect(nextStageHistory(history, { stageId: 'grant', stageEnteredOn: '2026-10-05' }, today)).toEqual([
      { stageId: 'intake', enteredOn: '2026-10-01', leftOn: '2026-10-05' },
      { stageId: 'grant', enteredOn: '2026-10-05' },
    ]);
    // Without stageEnteredOn the move happened today; an earlier date than the stay clamps.
    expect(nextStageHistory(history, { stageId: 'grant' }, today).at(-1)).toEqual({
      stageId: 'grant',
      enteredOn: today,
    });
    expect(nextStageHistory(history, { stageId: 'grant', stageEnteredOn: '2026-09-01' }, today)[0]?.leftOn).toBe(
      '2026-10-01',
    );
  });

  it('closes the stay today when the stage is cleared, and ignores deleted matters', () => {
    const history: StageVisit[] = [{ stageId: 'intake', enteredOn: d('2026-10-01') }];
    expect(nextStageHistory(history, {}, today)).toEqual([
      { stageId: 'intake', enteredOn: '2026-10-01', leftOn: today },
    ]);
    expect(nextStageHistory(history, { stageId: 'grant', deletedAt: at('2026-10-06') }, today)).toEqual(history);
    expect(nextStageHistory(history, undefined, today)).toEqual(history);
  });

  it('keeps the most recent stays', () => {
    let history: StageVisit[] = [];
    for (let i = 0; i < STAGE_HISTORY_MAX + 5; i++) history = nextStageHistory(history, { stageId: `s${i}` }, today);
    expect(history).toHaveLength(STAGE_HISTORY_MAX);
    expect(history.at(-1)?.stageId).toBe(`s${STAGE_HISTORY_MAX + 4}`);
  });
});

describe('diffContributions and rollupMetrics', () => {
  it('diffs a back-dated move as a removal from the old day and an addition to the new', () => {
    const before = timeEntryMetrics({ uid: 'u1', date: '2026-07-01', minutes: 30, billable: false });
    const after = timeEntryMetrics({ uid: 'u1', date: '2026-06-30', minutes: 30, billable: false });
    const delta = diffContributions(after, before);
    expect(delta['2026-07-01']?.['time.minutes']).toBe(-30);
    expect(delta['2026-06-30']?.['time.minutes']).toBe(30);
    expect(diffContributions(after, after)).toEqual({});
    expect(isEmptyContribution({})).toBe(true);
    expect(isEmptyContribution({ '2026-07-01': {} })).toBe(true);
    expect(isEmptyContribution(delta)).toBe(false);
  });

  it('rolls a back-dated move across the FY boundary out of one FY and into the other', () => {
    const before = timeEntryMetrics({ uid: 'u1', date: '2026-07-01', minutes: 30, billable: false });
    const after = timeEntryMetrics({ uid: 'u1', date: '2026-06-30', minutes: 30, billable: false });
    const docs = rollupMetrics([diffContributions(after, before)]);
    expect(docs.get('fy-2026')?.['time.minutes']).toBe(-30);
    expect(docs.get('fy-2025')?.['time.minutes']).toBe(30);
    expect(docs.get('month-2026-07/byMember/u1')?.['time.minutes']).toBe(-30);
    expect(docs.get('day-2026-06-30/byMember/u1')?.['time.minutes']).toBe(30);
  });

  it('leaves out a document whose figures cancel out (a move within the period)', () => {
    const before = timeEntryMetrics({ date: '2026-10-05', minutes: 30 });
    const after = timeEntryMetrics({ date: '2026-10-06', minutes: 30 });
    const docs = rollupMetrics([diffContributions(after, before)]);
    expect(docs.has('month-2026-10')).toBe(false);
    expect(docs.has('fy-2026')).toBe(false);
    expect(docs.get('day-2026-10-05')).toEqual({
      'time.entries': -1,
      'time.minutes': -30,
      'time.nonBillable.minutes': -30,
    });
  });

  it('sums contributions into each period, keeping only the periods asked for', () => {
    const a = timeEntryMetrics({ date: '2026-10-05', minutes: 30 });
    const b = timeEntryMetrics({ date: '2026-10-06', minutes: 45 });
    const docs = rollupMetrics([a, b, { junk: { x: 1 } }], 7, (period) => !period.startsWith('day-'));
    expect([...docs.keys()].sort()).toEqual(['fy-2026', 'month-2026-10']);
    expect(docs.get('month-2026-10')?.['time.minutes']).toBe(75);
  });
});

describe('snapshots', () => {
  const asOf = d('2026-10-06');

  it('counts matters open at the end of the day, and the WIP', () => {
    const matters = [
      {
        status: 'active',
        type: 'probate',
        createdAt: at('2026-01-10'),
        wipCents: 100_000,
        disbursementWipCents: 5_000,
      },
      { status: 'closed', type: 'probate', createdAt: at('2026-01-10'), closedAt: at('2026-10-07') },
      { status: 'closed', type: 'probate', createdAt: at('2026-01-10'), closedAt: at('2026-10-06') },
      { status: 'active', type: 'will', createdAt: at('2026-10-07') },
      { status: 'lead', type: 'will', createdAt: at('2026-01-10'), wipCents: 1 },
      { status: 'active', type: 'will', createdAt: at('2026-01-10'), deletedAt: at('2026-02-01'), wipCents: 9 },
      { status: 'active', type: 'will', createdAt: at('2026-01-10'), destroyedAt: at('2026-02-01') },
      { status: 'active', type: 'will' },
      { type: 'will', createdAt: at('2026-01-10') },
    ];
    expect(matterSnapshotMetrics(matters, asOf, { wip: true })).toEqual({
      'wip.timeCents': 100_001,
      'wip.disbursementsCents': 5_000,
      'active.matters': 2,
      'active.matters.type.probate': 2,
    });
    expect(matterSnapshotMetrics(matters, asOf)).toEqual({ 'active.matters': 2, 'active.matters.type.probate': 2 });
  });

  it('counts deadlines overdue at the end of the day', () => {
    const deadlines = [
      { status: 'upcoming', dueDate: '2026-10-05', critical: true },
      { status: 'upcoming', dueDate: '2026-10-07' },
      { status: 'done', dueDate: '2026-10-01', resolution: { on: '2026-10-07' } },
      { status: 'done', dueDate: '2026-10-01', resolution: { on: '2026-10-02' } },
      { status: 'missed', dueDate: '2026-10-01' },
      { status: 'superseded', dueDate: '2026-10-01' },
      { status: 'upcoming', dueDate: '2026-10-01', deletedAt: at('2026-10-02') },
    ];
    expect(deadlineSnapshotMetrics(deadlines, asOf)).toEqual({
      'overdue.deadlines': 2,
      'overdue.deadlines.critical': 1,
    });
  });

  it("copies Clerk's metering without the per-user figures, and the aged debtors", () => {
    expect(
      clerkRollupValues({ 'tokens.in': 1200, 'user.u1.tokens.in': 1200, 'cost.microUsd': 33, label: 'x' }),
    ).toEqual({
      'clerk.tokens.in': 1200,
      'clerk.cost.microUsd': 33,
    });
    expect(clerkRollupValues(undefined)).toEqual({});
    expect(debtorsRollupValues({ 'aged.d30Cents': 5_000, asOf: '2026-10-06' })).toEqual({
      'debtors.aged.d30Cents': 5_000,
    });
    expect(debtorsRollupValues(undefined)).toEqual({});
  });
});

describe('reading', () => {
  const values = {
    'cycle.probate.instructionsToGrant.d100': 2,
    'cycle.probate.instructionsToGrant.d40': 1,
    'cycle.probate.instructionsToGrant.d300': 1,
    'cycle.probate.instructionsToGrant.dx': 4,
    'cycle.probate.instructionsToGrant.d7': 0,
    'cycle.probate.grantToDistribution.d10': 1,
  };

  it('reads a histogram shortest first, skipping empty and odd buckets', () => {
    expect(metricHistogram(values, 'cycle.probate.instructionsToGrant')).toEqual([
      { days: 40, count: 1 },
      { days: 100, count: 2 },
      { days: 300, count: 1 },
    ]);
  });

  it('takes the median of an even and an odd count', () => {
    expect(medianDays(values, 'cycle.probate.instructionsToGrant')).toBe(100);
    expect(
      medianDays({ ...values, 'cycle.probate.instructionsToGrant.d300': 2 }, 'cycle.probate.instructionsToGrant'),
    ).toBe(100);
    expect(medianDays({ 'x.d10': 1, 'x.d20': 1 }, 'x')).toBe(15);
    expect(medianDays(values, 'cycle.will.instructionsToGrant')).toBeNull();
  });

  it('counts working days and period targets', () => {
    // Monday 5 to Sunday 11 October 2026.
    expect(workingDays(d('2026-10-05'), d('2026-10-11'))).toBe(5);
    expect(workingDays(d('2026-10-03'), d('2026-10-20'))).toBe(12);
    expect(workingDays(d('2026-10-06'), d('2026-10-05'))).toBe(0);
    expect(periodTargetMinutes('month-2026-10', 360)).toBe(22 * 360);
    expect(periodTargetMinutes('month-2026-10', 360, { upTo: d('2026-10-06') })).toBe(4 * 360);
    expect(periodTargetMinutes('fy-2026', -5)).toBe(0);
    expect(periodTargetMinutes('clerk-2026-10', 360)).toBe(0);
  });

  it('turns billable minutes into utilisation', () => {
    expect(utilisationPct(300, 360)).toBe(83);
    expect(utilisationPct(300, 0)).toBeNull();
  });
});

describe('shards and visibility', () => {
  it('shards only above 20 active members', () => {
    expect(metricShardCount(20)).toBe(1);
    expect(metricShardCount(21)).toBe(10);
  });

  it("lets lawyers and above see everyone's figures by default, and everyone their own", () => {
    expect(canSeeMemberMetrics('lawyer', undefined)).toBe(true);
    expect(canSeeMemberMetrics('paralegal', undefined)).toBe(false);
    expect(canSeeMemberMetrics('paralegal', 'lawyers', true)).toBe(true);
    expect(canSeeMemberMetrics('lawyer', 'admins')).toBe(false);
    expect(canSeeMemberMetrics('admin', 'admins')).toBe(true);
    expect(canSeeMemberMetrics('readonly', 'everyone')).toBe(true);
  });
});
