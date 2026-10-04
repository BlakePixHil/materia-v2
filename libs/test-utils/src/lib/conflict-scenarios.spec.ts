import * as D from '@materia/domain';

import { buildConflictFixture, CONFLICT_SCENARIOS } from './conflict-scenarios';

describe('conflict scenarios (CORE-02)', () => {
  const fixture = buildConflictFixture({
    orgId: 'org-cf',
    uid: 'user-a',
    now: new Date('2026-10-04T00:00:00Z'),
    format: 'HV-{YYYY}-{seq:4}',
    year: 2026,
    firstSeq: 13,
  });
  const ofCollection = (name: string) =>
    fixture.docs.filter((doc) => doc.path.split('/').at(-2) === name).map((doc) => doc);

  it('has five adverse and five benign scenarios', () => {
    expect(CONFLICT_SCENARIOS.filter((s) => s.kind === 'adverse')).toHaveLength(5);
    expect(CONFLICT_SCENARIOS.filter((s) => s.kind === 'benign')).toHaveLength(5);
    for (const scenario of CONFLICT_SCENARIOS) {
      const adverse = scenario.expected.some((hit) => hit.matters.some((m) => m.adverse));
      expect(adverse).toBe(scenario.kind === 'adverse');
    }
  });

  it('builds schema-valid contacts, matters, numbers and parties', () => {
    for (const { data } of ofCollection('contacts')) expect(D.Contact.schema.safeParse(data).success).toBe(true);
    for (const { data } of ofCollection('matters')) expect(D.Matter.schema.safeParse(data).success).toBe(true);
    for (const { data } of ofCollection('matterNumbers'))
      expect(D.MatterNumber.schema.safeParse(data).success).toBe(true);
    for (const { data } of ofCollection('parties')) expect(D.Party.schema.safeParse(data).success).toBe(true);
    expect(ofCollection('matters')).toHaveLength(6);
    expect(fixture.nextSeq).toBe(19);
    expect(ofCollection('matters')[0]?.data['number']).toBe('HV-2026-0013');
  });

  it('expects exactly the contacts the duplicate scorer matches, each with its role and adverse pair', () => {
    const contacts = ofCollection('contacts').map(({ path, data }) => ({ id: path.split('/').at(-1) as string, data }));
    const parties = ofCollection('parties').map(({ data }) => data);
    const matters = new Map(ofCollection('matters').map(({ path, data }) => [path.split('/').at(-1), data]));
    for (const scenario of CONFLICT_SCENARIOS) {
      const [subject] = scenario.subjects;
      if (!subject) throw new Error('no subject');
      const probe = D.subjectProbe(subject);
      const hits = contacts
        .filter(({ data }) => D.scoreDuplicate(probe, data as never).score >= D.CONFLICT_HIT_THRESHOLD)
        .map(({ id, data }) => (data['mergedInto'] as string | undefined) ?? id);
      expect(hits.sort(), scenario.name).toEqual(scenario.expected.map((hit) => hit.contactId).sort());
      for (const hit of scenario.expected) {
        const rows = parties.filter((party) => party['contactId'] === hit.contactId);
        expect(rows.map((row) => row['matterId']).sort(), scenario.name).toEqual(
          hit.matters.map((m) => m.matterId).sort(),
        );
        for (const expected of hit.matters) {
          const type = matters.get(expected.matterId)?.['type'] as D.MatterType;
          expect(!!D.adversePair(D.ConflictSubjectSchema.parse(subject).role, expected.role, type), scenario.name).toBe(
            expected.adverse,
          );
        }
      }
    }
  });
});
