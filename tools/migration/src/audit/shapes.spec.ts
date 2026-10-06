import { addDueDate, dateShape, fieldHistogram, shapeOf, type DueDateStats } from './shapes.ts';

const ctx = { uid: 'AlexRiversLegacyUid000000001', others: new Set(['JordanEllisLegacyUid00000002']) };

describe('shapeOf', () => {
  it('describes values without revealing them', () => {
    expect(
      [
        undefined,
        null,
        [],
        [1],
        '',
        '   ',
        'AlexRiversLegacyUid000000001',
        'JordanEllisLegacyUid00000002',
        'SomeOtherUserLegacyUid000005',
        '2025-03-13T13:00:00.000Z',
        '2025-03-14',
        '0b6f1c2e-5d4a-4c3b-9a8e-111111111111',
        'WillsCardAuto0000001',
        '<p>x</p>',
        'Client name',
        3,
        3.5,
        true,
        { $timestamp: 'x' },
        {},
        { a: 1 },
      ].map((v) => shapeOf(v, ctx)),
    ).toEqual([
      'missing',
      'null',
      'array:empty',
      'array',
      'empty-string',
      'whitespace',
      'uid:self',
      'uid:other',
      'uid:unknown',
      'iso-datetime',
      'date-only',
      'uuid',
      'auto-id',
      'html',
      'text',
      'integer',
      'decimal',
      'true',
      'timestamp',
      'map:empty',
      'map',
    ]);
  });
});

describe('fieldHistogram', () => {
  it("counts every field's shapes and how often it is missing", () => {
    const histogram = fieldHistogram(
      [
        {
          assignee: '',
          fee: { value: 1 },
          checklists: [{ items: [{ dueDate: null }, { dueDate: '2025-01-01T00:00:00Z' }] }],
        },
        { assignee: null, fee: null, checklists: [], uids: [ctx.uid, 'JordanEllisLegacyUid00000002'] },
        { assignee: ctx.uid, users: { JordanEllisLegacyUid00000002: { roles: { owner: true } } } },
        {},
      ],
      ctx,
    );
    expect(histogram['assignee']).toEqual({ of: 4, shapes: { 'empty-string': 1, missing: 1, null: 1, 'uid:self': 1 } });
    expect(histogram['fee']).toEqual({ of: 4, shapes: { map: 1, missing: 2, null: 1 } });
    expect(histogram['fee.value']).toEqual({ of: 1, shapes: { integer: 1 } });
    expect(histogram['checklists[].items[].dueDate']).toEqual({ of: 2, shapes: { 'iso-datetime': 1, null: 1 } });
    expect(histogram['uids[]']).toEqual({ of: 2, shapes: { 'uid:other': 1, 'uid:self': 1 } });
    expect(histogram['users.{id}.roles.owner']).toEqual({ of: 1, shapes: { true: 1 } });
    expect(Object.keys(histogram)).not.toContain('users.JordanEllisLegacyUid00000002');
  });
});

describe('dates', () => {
  it('classifies date values', () => {
    expect(
      [
        undefined,
        null,
        '',
        '2025-03-14',
        '2025-02-30',
        '2025-03-13T13:00:00.000Z',
        '2025-03-14T00:00:00+11:00',
        '2025-13-45T99:00:00Z',
        'March 3, 2025',
        'soon',
        17,
        { $timestamp: 'x' },
        {},
      ].map(dateShape),
    ).toEqual([
      'missing',
      'null',
      'empty-string',
      'date-only',
      'invalid',
      'iso-utc',
      'iso-offset',
      'invalid',
      'other-parseable',
      'invalid',
      'number',
      'timestamp',
      'invalid',
    ]);
  });

  it('counts due dates by how they land in Melbourne', () => {
    const stats: DueDateStats = { melbourneMidnight: 0, utcMidnight: 0, otherTime: 0, differsFromUtc: 0 };
    for (const value of [
      '2025-03-13T13:00:00.000Z',
      '2025-07-31T14:00:00.000Z',
      '2025-06-01T00:00:00.000Z',
      '2025-06-01T02:30:00.000Z',
      null,
      '2025-06-01',
    ]) {
      addDueDate(stats, value);
    }
    expect(stats).toEqual({ melbourneMidnight: 2, utcMidnight: 1, otherTime: 1, differsFromUtc: 2 });
  });
});
