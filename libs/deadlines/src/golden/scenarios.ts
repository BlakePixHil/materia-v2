import type { MatterType } from '@materia/domain';

/**
 * Golden scenarios for the Victorian rule set v1. Each lists the expected result for the rules it is
 * about (a date, `blocked`, `invalid` or `omit` for "doesn't apply"); `golden.spec.ts` checks them and
 * snapshots every trace. A practitioner reviews this file and the snapshot before the rule set's flag
 * is turned on (CORE-09). All matters are fictional.
 *
 * Unless stated, today is 2026-10-04 (the first day of daylight saving in Melbourne) and the firm's
 * locality calendar is VIC_MELBOURNE.
 */
export interface GoldenEvent {
  id?: string;
  kind: string;
  date: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface GoldenScenario {
  name: string;
  matterType: MatterType;
  facts?: Record<string, unknown>;
  events: GoldenEvent[];
  today?: string;
  locality?: string;
  expect: Record<string, string>;
  /** Rules expected to be flagged past-on-creation or approximate. */
  flags?: Record<string, ('past' | 'approximate')[]>;
  reminders?: Record<string, string[]>;
  dueTime?: Record<string, string>;
  /** Rules that keep their proposed task after de-duplication. */
  tasksFrom?: string[];
  throws?: string;
}

const grant = (date: string, meta?: GoldenEvent['meta']): GoldenEvent => ({
  id: 'ev-grant',
  kind: 'grant_issued',
  date,
  ...(meta ? { meta } : {}),
});
const dod = (date: string, meta?: GoldenEvent['meta']): GoldenEvent => ({
  id: 'ev-dod',
  kind: 'date_of_death',
  date,
  ...(meta ? { meta } : {}),
});
const notice = (date: string): GoldenEvent => ({ id: 'ev-notice', kind: 'notice_published', date });
const s33 = (date: string): GoldenEvent => ({ id: 'ev-s33', kind: 'statutory_notice_published', date });

export const GOLDEN: GoldenScenario[] = [
  // Family provision limitation: 6 months from the grant (s 99), on the Supreme Court calendar.
  {
    name: 'fp: 6 months from the grant lands on a Monday',
    matterType: 'probate',
    events: [dod('2025-12-01'), grant('2026-03-14')],
    expect: { 'vic.fp.limitation': '2026-09-14' },
  },
  {
    name: 'fp: due on Melbourne Cup rolls to Wednesday',
    matterType: 'probate',
    events: [dod('2025-12-01'), grant('2026-05-03')],
    expect: { 'vic.fp.limitation': '2026-11-04' },
  },
  {
    name: 'fp: due inside the court Christmas closure rolls to the reopening',
    matterType: 'probate',
    events: [dod('2025-12-01'), grant('2026-06-28')],
    expect: { 'vic.fp.limitation': '2027-01-04' },
  },
  {
    name: 'fp: 31 Aug + 6 months clamps to 28 Feb (a Sunday) then rolls',
    matterType: 'probate',
    events: [dod('2026-01-01'), grant('2026-08-31')],
    expect: { 'vic.fp.limitation': '2027-03-01' },
  },
  {
    name: 'fp: 29 Aug + 6 months reaches 29 Feb in a leap year',
    matterType: 'admin',
    events: [dod('2027-01-01'), grant('2027-08-29')],
    today: '2027-09-01',
    expect: { 'vic.fp.limitation': '2028-02-29' },
  },
  {
    name: 'fp: 31 Aug + 6 months clamps to 29 Feb in a leap year',
    matterType: 'admin',
    events: [dod('2027-01-01'), grant('2027-08-31')],
    today: '2027-09-01',
    expect: { 'vic.fp.limitation': '2028-02-29' },
  },
  {
    name: 'fp: due on King’s Birthday rolls to Tuesday',
    matterType: 'loa',
    events: [dod('2026-08-01'), grant('2026-12-14')],
    expect: { 'vic.fp.limitation': '2027-06-15' },
  },
  {
    name: 'fp: a grant on Easter Monday (a holiday) still counts from that day',
    matterType: 'probate',
    events: [dod('2026-10-01'), grant('2027-03-29')],
    today: '2027-04-01',
    expect: { 'vic.fp.limitation': '2027-09-29' },
  },
  {
    name: 'fp: no grant yet blocks the limitation and s 99A',
    matterType: 'probate',
    events: [dod('2026-06-01')],
    expect: {
      'vic.fp.limitation': 'blocked',
      'vic.distribution.s99a': 'blocked',
      'vic.distribution.earliest': 'blocked',
    },
  },
  {
    name: 'fp: a contest matter gets the limitation but not distribution rules',
    matterType: 'contest',
    events: [grant('2026-03-02')],
    expect: { 'vic.fp.limitation': '2026-09-02', 'vic.distribution.s99a': 'omit' },
  },
  {
    name: 'fp: a family provision matter computes from the grant too',
    matterType: 'fp',
    events: [grant('2026-04-30')],
    expect: { 'vic.fp.limitation': '2026-10-30' },
  },
  {
    name: 'fp: Geelong firm reminders follow the Geelong calendar',
    matterType: 'probate',
    locality: 'VIC_GREATER_GEELONG',
    events: [dod('2026-01-10'), grant('2026-05-04')],
    expect: { 'vic.fp.limitation': '2026-11-04' },
    reminders: { 'vic.fp.limitation': ['2026-10-05', '2026-10-20', '2026-10-28', '2026-10-30', '2026-11-03'] },
  },
  {
    name: 'fp: Melbourne firm reminders follow the Melbourne calendar',
    matterType: 'probate',
    events: [dod('2026-01-10'), grant('2026-05-04')],
    expect: { 'vic.fp.limitation': '2026-11-04' },
    reminders: { 'vic.fp.limitation': ['2026-10-05', '2026-10-21', '2026-10-28', '2026-10-30', '2026-11-02'] },
  },
  {
    name: 'fp: past on entry goes to review, not missed',
    matterType: 'probate',
    events: [dod('2025-06-01'), grant('2025-10-01')],
    expect: { 'vic.fp.limitation': '2026-04-01' },
    flags: { 'vic.fp.limitation': ['past'] },
  },
  {
    name: 'fp: DST end (5 Apr 2026) doesn’t move date-only arithmetic',
    matterType: 'probate',
    events: [dod('2025-12-01'), grant('2026-04-05')],
    expect: { 'vic.fp.limitation': '2026-10-05' },
  },

  // Reseal: prefer the grant recorded for Victoria.
  {
    name: 'reseal: the Victorian reseal anchors the window, not the interstate grant',
    matterType: 'probate',
    events: [
      dod('2025-10-01'),
      { id: 'ev-nsw', kind: 'grant_issued', date: '2026-01-10', meta: { jurisdiction: 'NSW' } },
      { id: 'ev-vic', kind: 'grant_issued', date: '2026-03-02', meta: { jurisdiction: 'VIC' } },
    ],
    expect: { 'vic.fp.limitation': '2026-09-02' },
  },
  {
    name: 'reseal: only an interstate grant recorded so far (verify applicability)',
    matterType: 'probate',
    events: [
      dod('2025-10-01'),
      { id: 'ev-nsw', kind: 'grant_issued', date: '2026-01-10', meta: { jurisdiction: 'NSW' } },
    ],
    expect: { 'vic.fp.limitation': '2026-07-10' },
    flags: { 'vic.fp.limitation': ['past'] },
  },

  // Distribution: s 99A, s 33 and the composite.
  {
    name: 'distribution: s 33 notice expiry is later than s 99A',
    matterType: 'probate',
    events: [dod('2025-12-01'), grant('2026-03-02'), s33('2026-08-01')],
    expect: {
      'vic.distribution.s99a': '2026-09-02',
      'vic.distribution.s33_notice': '2026-09-30',
      'vic.distribution.earliest': '2026-09-30',
    },
  },
  {
    name: 'distribution: s 99A is later than the s 33 notice expiry',
    matterType: 'probate',
    events: [dod('2025-12-01'), grant('2026-03-02'), s33('2026-06-01')],
    expect: { 'vic.distribution.s33_notice': '2026-07-31', 'vic.distribution.earliest': '2026-09-02' },
    flags: { 'vic.distribution.s33_notice': ['past'] },
  },
  {
    name: 'distribution: notice published but no grant blocks the composite',
    matterType: 'admin',
    events: [dod('2026-03-01'), s33('2026-08-01')],
    expect: { 'vic.distribution.s33_notice': '2026-09-30', 'vic.distribution.earliest': 'blocked' },
  },
  {
    name: 'distribution: s 99A and s 33 propose one "Plan the distribution" task',
    matterType: 'probate',
    events: [dod('2025-12-01'), grant('2026-03-02'), s33('2026-08-01')],
    expect: { 'vic.distribution.earliest': '2026-09-30' },
    tasksFrom: ['vic.fp.limitation', 'vic.distribution.s99a'],
  },
  {
    name: 'distribution: s 33 notice expiring in the Christmas closure rolls',
    matterType: 'probate',
    events: [dod('2026-02-01'), grant('2026-06-01'), s33('2026-10-30')],
    expect: { 'vic.distribution.s33_notice': '2027-01-04', 'vic.distribution.earliest': '2027-01-04' },
  },

  // Advertisement: earliest filing date 14 days after the notice.
  {
    name: 'advert: 14 days after the notice',
    matterType: 'probate',
    events: [dod('2026-07-01'), notice('2026-10-01')],
    expect: { 'vic.probate.advert_min': '2026-10-15' },
  },
  {
    name: 'advert: lands on Melbourne Cup and rolls (court calendar)',
    matterType: 'probate',
    events: [dod('2026-07-01'), notice('2026-10-20')],
    expect: { 'vic.probate.advert_min': '2026-11-04' },
  },
  {
    name: 'advert: a Geelong firm still uses the court calendar for court rules',
    matterType: 'probate',
    locality: 'VIC_GREATER_GEELONG',
    events: [dod('2026-07-01'), notice('2026-10-20')],
    expect: { 'vic.probate.advert_min': '2026-11-04' },
  },
  {
    name: 'advert: lands in the Christmas closure',
    matterType: 'probate',
    events: [dod('2026-07-01'), notice('2026-12-14')],
    expect: { 'vic.probate.advert_min': '2027-01-04' },
  },
  {
    name: 'advert: Good Friday, Easter Saturday, Sunday and Monday in a row',
    matterType: 'probate',
    events: [dod('2026-12-01'), notice('2027-03-12')],
    today: '2027-03-12',
    expect: { 'vic.probate.advert_min': '2027-03-30' },
  },
  {
    name: 'advert: AFL Grand Final Friday (provisional date) rolls to Monday',
    matterType: 'probate',
    events: [dod('2026-06-01'), notice('2026-09-11')],
    today: '2026-09-11',
    expect: { 'vic.probate.advert_min': '2026-09-28' },
  },
  {
    name: 'advert: a notice on the DST start day (4 Oct 2026)',
    matterType: 'probate',
    events: [dod('2026-07-01'), notice('2026-10-04')],
    expect: { 'vic.probate.advert_min': '2026-10-19' },
  },
  {
    name: 'advert: no notice yet',
    matterType: 'loa',
    events: [dod('2026-07-01')],
    expect: { 'vic.probate.advert_min': 'blocked' },
  },

  // Practice reminders and tax.
  {
    name: 'prompt filing: 6 months after death by default',
    matterType: 'probate',
    events: [dod('2026-04-15')],
    expect: { 'vic.probate.prompt_filing': '2026-10-15' },
  },
  {
    name: 'prompt filing: org setting of 3 months, already past',
    matterType: 'probate',
    facts: { org: { promptFilingMonths: 3 } },
    events: [dod('2026-04-15')],
    expect: { 'vic.probate.prompt_filing': '2026-07-15' },
    flags: { 'vic.probate.prompt_filing': ['past'] },
  },
  {
    name: 'prompt filing: not shown once the application is filed',
    matterType: 'probate',
    facts: { grant: { filed: true } },
    events: [dod('2026-04-15')],
    expect: { 'vic.probate.prompt_filing': 'omit' },
  },
  {
    name: 'unknown date of death blocks death-anchored rules',
    matterType: 'probate',
    events: [],
    expect: {
      'vic.probate.prompt_filing': 'blocked',
      'au.tax.final_return': 'blocked',
      'org.executor_year': 'blocked',
    },
  },
  {
    name: 'a future date of death is invalid',
    matterType: 'probate',
    events: [dod('2026-12-01')],
    expect: {
      'vic.probate.prompt_filing': 'invalid',
      'org.executor_year': 'invalid',
      'au.tax.final_return': 'invalid',
    },
  },
  {
    name: 'approximate date of death (month): earliest possible, flagged',
    matterType: 'probate',
    events: [dod('2025-11-15', { datePrecision: 'month' })],
    expect: { 'org.executor_year': '2026-11-02' },
    flags: { 'org.executor_year': ['approximate'] },
  },
  {
    name: 'approximate date of death (year only)',
    matterType: 'probate',
    events: [dod('2025-06-30', { datePrecision: 'year' })],
    expect: { 'org.executor_year': '2026-01-02', 'au.tax.final_return': '2025-10-31' },
    flags: { 'org.executor_year': ['approximate', 'past'], 'au.tax.final_return': ['approximate', 'past'] },
  },
  {
    name: 'executor’s year on Geelong Cup Day for a Geelong firm',
    matterType: 'admin',
    locality: 'VIC_GREATER_GEELONG',
    events: [dod('2025-10-21')],
    expect: { 'org.executor_year': '2026-10-22' },
  },
  {
    name: 'executor’s year on Geelong Cup Day for a Melbourne firm',
    matterType: 'admin',
    events: [dod('2025-10-21')],
    expect: { 'org.executor_year': '2026-10-21' },
  },
  {
    name: 'CGT main residence window: 2 years, no roll',
    matterType: 'probate',
    facts: { estate: { hasMainResidence: true } },
    events: [dod('2025-12-25')],
    expect: { 'au.cgt.main_residence': '2027-12-25' },
  },
  {
    name: 'CGT window only when there is a main residence',
    matterType: 'probate',
    events: [dod('2025-12-25')],
    expect: { 'au.cgt.main_residence': 'omit' },
  },
  {
    name: 'final return: 31 Oct after the FY of death, rolled off a Saturday',
    matterType: 'probate',
    events: [dod('2026-03-10')],
    expect: { 'au.tax.final_return': '2026-11-02' },
  },
  {
    name: 'final return: death on 1 July starts a new financial year',
    matterType: 'probate',
    events: [dod('2026-07-01')],
    expect: { 'au.tax.final_return': '2027-11-01' },
  },

  // Caveats, offers and orders.
  {
    name: 'caveat lapses 6 months after lodging (verify the period)',
    matterType: 'probate',
    events: [dod('2026-01-01'), { id: 'ev-caveat', kind: 'caveat_lodged', date: '2026-05-29' }],
    expect: { 'vic.caveat.expiry': '2026-11-30' },
  },
  {
    name: 'caveat on a will dispute',
    matterType: 'contest',
    events: [{ id: 'ev-caveat', kind: 'caveat_lodged', date: '2026-05-29' }],
    expect: { 'vic.caveat.expiry': '2026-11-30' },
  },
  {
    name: 'offer of compromise: 14 days by default, by 4pm',
    matterType: 'fp',
    events: [{ id: 'ev-offer', kind: 'offer_made', date: '2026-09-21' }],
    expect: { 'vic.offer.o26_expiry': '2026-10-05' },
    dueTime: { 'vic.offer.o26_expiry': '16:00' },
  },
  {
    name: 'offer of compromise: the period stated in the offer',
    matterType: 'contest',
    events: [{ id: 'ev-offer', kind: 'offer_made', date: '2026-09-21', meta: { periodDays: 28 } }],
    expect: { 'vic.offer.o26_expiry': '2026-10-19' },
  },
  {
    name: 'order: comply within 21 days, across the closure, by 4pm',
    matterType: 'fp',
    events: [{ id: 'ev-order', kind: 'order_made', date: '2026-12-10', meta: { days: 21 } }],
    expect: { 'vic.order.compliance': '2027-01-04' },
    dueTime: { 'vic.order.compliance': '16:00' },
  },
  {
    name: 'order: no number of days recorded',
    matterType: 'fp',
    events: [{ id: 'ev-order', kind: 'order_made', date: '2026-12-10' }],
    expect: { 'vic.order.compliance': 'blocked' },
  },

  // Applicability and calendar data.
  {
    name: 'a will matter has no deadlines in v1',
    matterType: 'will',
    events: [dod('2026-01-01')],
    expect: { 'vic.fp.limitation': 'omit', 'org.executor_year': 'omit' },
  },
  {
    name: 'a deadline in a year with no calendar data fails loudly',
    matterType: 'probate',
    events: [dod('2028-01-01'), grant('2028-07-01')],
    today: '2028-07-02',
    expect: {},
    throws: 'CALENDAR_MISSING',
  },
];
