import * as D from '@materia/domain';

import { buildLoadMatters } from './load-matters';

describe('buildLoadMatters', () => {
  const load = () =>
    buildLoadMatters({
      orgId: 'org-load',
      now: new Date('2026-10-04T00:00:00Z'),
      format: 'HV-{YYYY}-{seq:4}',
      year: 2026,
      firstSeq: 13,
      uids: ['user-a', 'user-b', 'user-c'],
      clientContactIds: ['c-1', 'c-2'],
      contactNames: { 'c-1': 'Ada Quill' },
    });

  it('builds 500 schema-valid matters with unique numbers and their reservations', () => {
    const { matters, reservations, nextSeq } = load();
    expect(matters).toHaveLength(500);
    expect(reservations).toHaveLength(500);
    expect(nextSeq).toBe(513);
    for (const { data } of matters) expect(D.Matter.schema.safeParse(data).success).toBe(true);
    for (const { data } of reservations) expect(D.MatterNumber.schema.safeParse(data).success).toBe(true);
    const numbers = matters.map((m) => m.data['number']);
    expect(new Set(numbers).size).toBe(500);
    expect(numbers[0]).toBe('HV-2026-0013');
    expect(numbers.at(-1)).toBe('HV-2026-0512');
    expect(reservations[0]?.path).toBe('orgs/org-load/matterNumbers/HV-2026-0013');
    expect(matters[0]?.data['search']).toEqual(expect.arrayContaining(['hv20260013', 'ada', 'quill']));
  });

  it('varies what the list filters and sorts on, deterministically', () => {
    const { matters } = load();
    const values = (field: string) => new Set(matters.map((m) => JSON.stringify(m.data[field])));
    expect(values('type').size).toBe(D.MatterTypeSchema.options.length);
    expect(values('status').size).toBe(D.MatterStatusSchema.options.length);
    expect(values('responsibleUid').size).toBe(3);
    expect(values('jurisdiction').size).toBeGreaterThan(1);
    expect(values('labels').size).toBeGreaterThan(3);
    expect(values('lastActivityAt').size).toBe(500);
    expect(matters.some((m) => m.data['privileged'] === true)).toBe(true);
    expect(matters.every((m) => m.data['deletedAt'] === null)).toBe(true);
    expect(JSON.stringify(load().matters)).toBe(JSON.stringify(matters));
  });

  it('needs people and clients', () => {
    expect(() =>
      buildLoadMatters({ orgId: 'o', now: new Date(), year: 2026, uids: [], clientContactIds: ['c'] }),
    ).toThrow(/required/);
  });
});
