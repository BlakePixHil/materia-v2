import type { TransformedRecord } from './context.ts';
import { byPath, idmapLine, recordLine, reportJson, tagDates, untagDates } from './output.ts';

const CREATED = new Date('2024-02-01T01:00:00.000Z');
const LOADED = new Date('2026-10-06T21:00:00.123Z');

describe('tagDates and untagDates', () => {
  it('tags every Date as { $timestamp } at any depth, arrays included', () => {
    const value = {
      createdAt: CREATED,
      list: [CREATED, { at: LOADED }, [LOADED]],
      nested: { deeper: { at: LOADED, n: 1 } },
      text: 'x',
      none: null,
    };
    expect(tagDates(value)).toEqual({
      createdAt: { $timestamp: '2024-02-01T01:00:00.000Z' },
      list: [
        { $timestamp: '2024-02-01T01:00:00.000Z' },
        { at: { $timestamp: '2026-10-06T21:00:00.123Z' } },
        [{ $timestamp: '2026-10-06T21:00:00.123Z' }],
      ],
      nested: { deeper: { at: { $timestamp: '2026-10-06T21:00:00.123Z' }, n: 1 } },
      text: 'x',
      none: null,
    });
  });

  it('leaves values without dates as they are', () => {
    for (const value of [null, undefined, 0, 'text', true, [], {}, [1, 'a'], { a: { b: [null] } }]) {
      expect(tagDates(value)).toEqual(value);
      expect(untagDates(value)).toEqual(value);
    }
    expect(tagDates(CREATED)).toEqual({ $timestamp: '2024-02-01T01:00:00.000Z' });
  });

  it('round-trips a record at depth', () => {
    const value = {
      createdAt: CREATED,
      migration: { loadedAt: LOADED, runId: 'run1' },
      history: [{ at: CREATED, events: [{ at: LOADED }] }],
      dates: [CREATED, LOADED],
    };
    const back = untagDates(JSON.parse(JSON.stringify(tagDates(value))));
    expect(back).toEqual(value);
    expect((back as { createdAt: unknown }).createdAt).toBeInstanceOf(Date);
  });

  it('turns back only objects that are exactly a $timestamp string', () => {
    expect(untagDates({ $timestamp: '2024-02-01T01:00:00.000Z' })).toEqual(CREATED);
    expect(untagDates({ $timestamp: 5 })).toEqual({ $timestamp: 5 });
    expect(untagDates({ $timestamp: '2024-02-01T01:00:00.000Z', other: 1 })).toEqual({
      $timestamp: '2024-02-01T01:00:00.000Z',
      other: 1,
    });
    expect(untagDates({ $bytes: 'AAAA' })).toEqual({ $bytes: 'AAAA' });
  });
});

describe('recordLine', () => {
  const record: TransformedRecord = {
    entity: 'contacts',
    path: 'orgs/org1/contacts/c1',
    legacyPath: 'referrers/r1',
    data: { kind: 'person', familyName: 'Example', createdAt: CREATED, tags: ['b', 'a'], meta: { z: 1, a: 2 } },
  };

  it('writes path, legacyPath and data with keys sorted at every depth, dates tagged and a newline', () => {
    expect(recordLine(record)).toBe(
      '{"data":{"createdAt":{"$timestamp":"2024-02-01T01:00:00.000Z"},"familyName":"Example","kind":"person",' +
        '"meta":{"a":2,"z":1},"tags":["b","a"]},"legacyPath":"referrers/r1","path":"orgs/org1/contacts/c1"}\n',
    );
  });

  it('leaves out the entity, and data or copy when absent', () => {
    const avatar: TransformedRecord = {
      entity: 'avatars',
      path: 'users/u1/avatar',
      legacyPath: 'profile-images/u1',
      copy: {
        source: 'profile-images/u1',
        target: 'users/u1/avatar.png',
        fileName: 'avatar.png',
        mime: 'image/png',
        sizeBytes: 3,
      },
    };
    expect(recordLine(avatar)).toBe(
      '{"copy":{"fileName":"avatar.png","mime":"image/png","sizeBytes":3,"source":"profile-images/u1",' +
        '"target":"users/u1/avatar.png"},"legacyPath":"profile-images/u1","path":"users/u1/avatar"}\n',
    );
    expect(recordLine({ entity: 'orgs', path: 'orgs/org1', legacyPath: 'profiles/u1' })).toBe(
      '{"legacyPath":"profiles/u1","path":"orgs/org1"}\n',
    );
  });

  it('keeps both data and copy when a record has both', () => {
    const line = recordLine({
      ...record,
      copy: { target: 't', fileName: 'f.pdf', mime: 'application/pdf', sizeBytes: 1 },
    });
    expect(Object.keys(JSON.parse(line) as object)).toEqual(['copy', 'data', 'legacyPath', 'path']);
  });

  it('gives the same bytes whatever order the keys were built in', () => {
    const reordered: TransformedRecord = {
      legacyPath: 'referrers/r1',
      data: { meta: { a: 2, z: 1 }, tags: ['b', 'a'], createdAt: CREATED, kind: 'person', familyName: 'Example' },
      path: 'orgs/org1/contacts/c1',
      entity: 'contacts',
    };
    expect(recordLine(reordered)).toBe(recordLine(record));
  });
});

describe('idmapLine', () => {
  it('writes the entry with sorted keys and a newline', () => {
    expect(idmapLine({ v2Path: 'orgs/org1/matters/m1', legacyPath: 'workflows/wf1/cards/c1' })).toBe(
      '{"legacyPath":"workflows/wf1/cards/c1","v2Path":"orgs/org1/matters/m1"}\n',
    );
  });
});

describe('reportJson', () => {
  it('sorts keys at every depth, indents by two spaces, tags dates and ends with a newline', () => {
    const text = reportJson({ z: [{ b: 1, a: CREATED }], a: { y: true, x: null }, m: 'text' });
    expect(text).toBe(
      [
        '{',
        '  "a": {',
        '    "x": null,',
        '    "y": true',
        '  },',
        '  "m": "text",',
        '  "z": [',
        '    {',
        '      "a": {',
        '        "$timestamp": "2024-02-01T01:00:00.000Z"',
        '      },',
        '      "b": 1',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });
});

describe('byPath', () => {
  it('orders records by path in code-unit order', () => {
    const records = [{ path: 'orgs/o/b' }, { path: 'orgs/o/B' }, { path: 'orgs/o/a' }, { path: 'orgs/o/a' }];
    expect([...records].sort(byPath).map((r) => r.path)).toEqual(['orgs/o/B', 'orgs/o/a', 'orgs/o/a', 'orgs/o/b']);
    expect(byPath({ path: 'x' }, { path: 'x' })).toBe(0);
    expect(byPath({ path: 'a' }, { path: 'b' })).toBeLessThan(0);
    expect(byPath({ path: 'b' }, { path: 'a' })).toBeGreaterThan(0);
  });
});
