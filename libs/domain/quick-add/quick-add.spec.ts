import { parseQuickAdd, type QuickAddMember, type QuickAddResult } from './quick-add';

// Fictional members (the seed's cast) plus a second "Da…" for the ambiguous case.
const MEMBERS: QuickAddMember[] = [
  { uid: 'u-priya', displayName: 'Priya Shah', initials: 'PS' },
  { uid: 'u-jordan', displayName: 'Jordan Price', initials: 'JP' },
  { uid: 'u-daniel', displayName: 'Daniel Kim', initials: 'DK' },
  { uid: 'u-dana', displayName: 'Dana Kelly', initials: 'DKe' },
  { uid: 'u-sam', displayName: 'Sam Lee', initials: 'SL' },
];

// Friday 9 October 2026, 10:30 in Melbourne (AEDT, UTC+11): still Thursday 8 October in UTC.
const FRIDAY = new Date('2026-10-08T23:30:00Z');
const parse = (input: string, now: Date = FRIDAY, timeZone?: string) =>
  parseQuickAdd(input, { members: MEMBERS, now, ...(timeZone ? { timeZone } : {}) });

type Expected = { [K in 'title' | 'assigneeUid' | 'priority' | 'dueDate']?: QuickAddResult[K] | undefined };

describe('parseQuickAdd: table (pinned to Friday 9 October 2026, Australia/Melbourne)', () => {
  const table: [string, Expected][] = [
    [
      'Lodge inventory @jordan !high due fri',
      { title: 'Lodge inventory', assigneeUid: 'u-jordan', priority: 'high', dueDate: '2026-10-09' as never },
    ],
    ['Call executor due tomorrow', { title: 'Call executor', dueDate: '2026-10-10' as never }],
    ['File affidavit due 14 Oct', { title: 'File affidavit', dueDate: '2026-10-14' as never }],
    ['Send letter due 14/10', { title: 'Send letter', dueDate: '2026-10-14' as never }],
    // Day-month (en-AU), and a date already past this year is next year's.
    ['Review will due 2/1', { title: 'Review will', dueDate: '2027-01-02' as never }],
    ['Draft notice due next week', { title: 'Draft notice', dueDate: '2026-10-16' as never }],
    ['Search registry due in 3 days', { title: 'Search registry', dueDate: '2026-10-12' as never }],
    ['Book valuation due mon', { title: 'Book valuation', dueDate: '2026-10-12' as never }],
    ['Prepare accounts due 1 March 2027', { title: 'Prepare accounts', dueDate: '2027-03-01' as never }],
    ['Pay invoice due today !urgent', { title: 'Pay invoice', priority: 'urgent', dueDate: '2026-10-09' as never }],
    ['!low Tidy file', { title: 'Tidy file', priority: 'low' }],
    ['Chase bank @Daniel', { title: 'Chase bank', assigneeUid: 'u-daniel' }],
    ['Chase bank @daniel.kim', { title: 'Chase bank', assigneeUid: 'u-daniel' }],
    ['@PS Review costs agreement', { title: 'Review costs agreement', assigneeUid: 'u-priya' }],
    ['Follow up @Jordan Price tomorrow', { title: 'Follow up tomorrow', assigneeUid: 'u-jordan' }],
    ['@da Review', { title: '@da Review', assigneeUid: undefined }],
    ['@nobody Review', { title: '@nobody Review', assigneeUid: undefined }],
    ['Email client !someday', { title: 'Email client !someday', priority: undefined }],
    ['Discuss due diligence report', { title: 'Discuss due diligence report', dueDate: undefined }],
    ['Meet re 14 Oct hearing', { title: 'Meet re 14 Oct hearing', dueDate: undefined }],
    [
      'Lodge caveat due sat @sam !med',
      { title: 'Lodge caveat', assigneeUid: 'u-sam', priority: 'medium', dueDate: '2026-10-10' as never },
    ],
    ['DUE FRIDAY Collect original will', { title: 'Collect original will', dueDate: '2026-10-09' as never }],
    ['Invoice !low !high', { title: 'Invoice', priority: 'high' }],
    ['Send probate pack due 31 Feb', { title: 'Send probate pack due 31 Feb', dueDate: undefined }],
    ['Ring the registry due end of month', { title: 'Ring the registry', dueDate: '2026-10-31' as never }],
    ['  spaced   out   title  ', { title: 'spaced out title' }],
    ['', { title: '' }],
  ];

  it('has at least 20 phrases', () => {
    expect(table.length).toBeGreaterThanOrEqual(20);
  });

  it.each(table)('%j', (input, expected) => {
    const result = parse(input);
    for (const [key, value] of Object.entries(expected)) {
      expect(result[key as keyof Expected], key).toEqual(value);
    }
  });
});

describe('parseQuickAdd: tokens and unresolved mentions', () => {
  it('reports the recognised spans in input order', () => {
    const input = 'Lodge inventory @jordan !high due fri';
    const { tokens } = parse(input);
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ['assignee', '@jordan'],
      ['priority', '!high'],
      ['due', 'due fri'],
    ]);
    for (const token of tokens) expect(input.slice(token.start, token.end)).toBe(token.text);
  });

  it('lists an ambiguous mention with its candidates, and an unknown one', () => {
    expect(parse('@da Review').unresolved).toEqual([
      { text: '@da', reason: 'ambiguous', candidates: ['u-daniel', 'u-dana'] },
    ]);
    expect(parse('@nobody Review').unresolved).toEqual([{ text: '@nobody', reason: 'unknown', candidates: [] }]);
  });

  it('an exact name wins over a prefix of another', () => {
    const members = [
      { uid: 'u-al', displayName: 'Al' },
      { uid: 'u-alex', displayName: 'Alex Nguyen' },
    ];
    expect(parseQuickAdd('Call @al', { members, now: FRIDAY }).assigneeUid).toBe('u-al');
  });

  it('ignores a mention with only punctuation', () => {
    expect(parse('Ask @-').title).toBe('Ask @-');
  });
});

describe('parseQuickAdd: time zone, DST and year end', () => {
  it('uses the org’s date, not UTC’s', () => {
    // 23:30 UTC on Thursday 8 October is already Friday in Melbourne…
    expect(parse('X due tomorrow').dueDate).toBe('2026-10-10');
    // …and still Thursday in UTC.
    expect(parse('X due tomorrow', FRIDAY, 'UTC').dueDate).toBe('2026-10-09');
  });

  it('defaults to Australia/Melbourne', () => {
    expect(parseQuickAdd('X due today', { members: [], now: FRIDAY }).dueDate).toBe('2026-10-09');
  });

  it('DST starts (Sunday 4 October 2026, 02:00 AEST → 03:00 AEDT)', () => {
    // 23:30 AEST on Saturday 3 October.
    expect(parse('X due today', new Date('2026-10-03T13:30:00Z')).dueDate).toBe('2026-10-03');
    expect(parse('X due tomorrow', new Date('2026-10-03T13:30:00Z')).dueDate).toBe('2026-10-04');
    // 00:30 AEST on Sunday 4 October, then 03:30 AEDT the same morning.
    expect(parse('X due today', new Date('2026-10-03T14:30:00Z')).dueDate).toBe('2026-10-04');
    expect(parse('X due tomorrow', new Date('2026-10-03T16:30:00Z')).dueDate).toBe('2026-10-05');
    expect(parse('X due sun', new Date('2026-10-03T16:30:00Z')).dueDate).toBe('2026-10-04');
  });

  it('DST ends (Sunday 5 April 2026, 03:00 AEDT → 02:00 AEST)', () => {
    // 23:30 AEDT on Saturday 4 April.
    expect(parse('X due today', new Date('2026-04-04T12:30:00Z')).dueDate).toBe('2026-04-04');
    // 02:30 on Sunday 5 April, which happens twice: both are the 5th.
    expect(parse('X due today', new Date('2026-04-04T15:30:00Z')).dueDate).toBe('2026-04-05');
    expect(parse('X due today', new Date('2026-04-04T16:30:00Z')).dueDate).toBe('2026-04-05');
    expect(parse('X due tomorrow', new Date('2026-04-04T16:30:00Z')).dueDate).toBe('2026-04-06');
  });

  it('"due 2 Jan" typed on 20 December is next year', () => {
    const december20 = new Date('2026-12-19T23:00:00Z'); // 10:00 AEDT, Sunday 20 December
    expect(parse('X due 2 Jan', december20).dueDate).toBe('2027-01-02');
    expect(parse('X due 24 Dec', december20).dueDate).toBe('2026-12-24');
    expect(parse('X due 14 Oct', december20).dueDate).toBe('2027-10-14');
  });

  it('crosses the year at midnight in Melbourne, not in UTC', () => {
    // 00:30 AEDT on 1 January 2027 is 13:30 UTC on 31 December 2026.
    const newYear = new Date('2026-12-31T13:30:00Z');
    expect(parse('X due today', newYear).dueDate).toBe('2027-01-01');
    expect(parse('X due 31 Dec', newYear).dueDate).toBe('2027-12-31');
    // On New Year's Eve (Thursday) "mon" is in the new year.
    expect(parse('X due mon', new Date('2026-12-30T23:00:00Z')).dueDate).toBe('2027-01-04');
  });
});
