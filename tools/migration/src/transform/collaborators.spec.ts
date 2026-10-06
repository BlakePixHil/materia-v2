import { domain } from '../domain.ts';
import { FIXTURE_UIDS } from '../legacy/fixtures.ts';
import type { MappingProfile } from '../profile.ts';
import { COLLABORATOR_TAG, mapCollaborators } from './collaborators.ts';
import { migId, type TransformContext } from './context.ts';
import { mapReferrer } from './referrers.ts';
import { loadSpecProfile, SPEC_AS_OF, specContext, warned } from './spec-helpers.ts';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadSpecProfile();
});

const SAM = 'SamExampleLegacyUid000000005';
const people = new Map<string, string | null>([
  [FIXTURE_UIDS.colleague, 'Jordan Ellis'],
  [FIXTURE_UIDS.departed, null],
  [SAM, 'Sam Example'],
]);
const ctxWithPeople = (): TransformContext => specContext(profile, { people });

describe('mapCollaborators', () => {
  it('makes a contact tagged legacy-collaborator for each named person', () => {
    const ctx = ctxWithPeople();
    const result = mapCollaborators(ctx, [FIXTURE_UIDS.colleague], []);
    const legacyPath = `profiles/${FIXTURE_UIDS.colleague}`;
    const id = migId(legacyPath);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      entity: 'contacts',
      path: `orgs/org1/contacts/${id}`,
      legacyPath,
      data: {
        kind: 'person',
        givenNames: 'Jordan',
        familyName: 'Ellis',
        tags: [COLLABORATOR_TAG],
        isReferrer: false,
        notes: 'Worked on matters in the legacy app (imported). Not a member of this practice.',
        dedupeKey: 'person:ellis jordan|',
        createdAt: SPEC_AS_OF,
        updatedAt: SPEC_AS_OF,
        createdBy: FIXTURE_UIDS.subject,
        migration: { runId: 'run1', legacyPath, loadedAt: SPEC_AS_OF },
      },
    });
    expect(domain.ContactSchema.safeParse(result.records[0]?.data).success).toBe(true);
    expect(result.contactIds).toEqual(new Map([[FIXTURE_UIDS.colleague, id]]));
    expect(COLLABORATOR_TAG).toBe('legacy-collaborator');
    expect(warned(ctx)).toEqual({});
  });

  it('skips the subject and lists each uid once, in uid order', () => {
    const ctx = ctxWithPeople();
    const result = mapCollaborators(
      ctx,
      [SAM, FIXTURE_UIDS.subject, FIXTURE_UIDS.colleague, SAM, FIXTURE_UIDS.colleague],
      [],
    );
    expect(result.records.map((record) => record.legacyPath)).toEqual([
      `profiles/${FIXTURE_UIDS.colleague}`,
      `profiles/${SAM}`,
    ]);
    expect([...result.contactIds.keys()]).toEqual([FIXTURE_UIDS.colleague, SAM]);
    expect(result.contactIds.has(FIXTURE_UIDS.subject)).toBe(false);
    expect(warned(ctx)).toEqual({});
  });

  it('gives a user whose profile is gone no contact, with MIG_W_PERSON_MISSING', () => {
    const ctx = ctxWithPeople();
    const result = mapCollaborators(ctx, [FIXTURE_UIDS.departed, FIXTURE_UIDS.stranger, FIXTURE_UIDS.departed], []);
    expect(result).toEqual({ records: [], contactIds: new Map() });
    expect(warned(ctx)).toEqual({
      MIG_W_PERSON_MISSING: [`profiles/${FIXTURE_UIDS.departed}`, `profiles/${FIXTURE_UIDS.stranger}`],
    });
  });

  it('merges a collaborator who is also a referrer into the referrer contact', () => {
    const ctx = ctxWithPeople();
    const referrer = mapReferrer(ctx, 'referrers/r1', {
      name: 'Jordan  Ellis',
      company: 'Fictional Wealth',
      phone: '0412 345 678',
      createdOn: '2024-06-01T00:00:00.000Z',
    });
    const other = mapReferrer(ctx, 'referrers/r2', { company: 'Fictional Funeral Services' });
    const result = mapCollaborators(ctx, [FIXTURE_UIDS.colleague, SAM], [referrer, other]);

    const sam = migId(`profiles/${SAM}`);
    expect(result.records.map((record) => record.path)).toEqual([`orgs/org1/contacts/${sam}`, referrer.path]);
    const merged = result.records[1];
    expect(merged).toEqual({
      ...referrer,
      data: { ...referrer.data, tags: [COLLABORATOR_TAG] },
    });
    expect(result.contactIds).toEqual(
      new Map([
        [FIXTURE_UIDS.colleague, migId('referrers/r1')],
        [SAM, sam],
      ]),
    );
    // The referrer's own record is not changed in place.
    expect(referrer.data?.['tags']).toEqual([]);
  });

  it('adds the tag to a referrer once, keeping its other tags sorted', () => {
    const ctx = specContext(profile, {
      people: new Map([
        ['UidOne', 'Jordan Ellis'],
        ['UidTwo', 'jordan ellis'],
      ]),
    });
    const referrer = mapReferrer(ctx, 'referrers/r1', { name: 'Jordan Ellis', createdOn: '2024-06-01T00:00:00.000Z' });
    const tagged = { ...referrer, data: { ...referrer.data, tags: ['vip', 'accountant'] } };
    const result = mapCollaborators(ctx, ['UidTwo', 'UidOne'], [tagged]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.data?.['tags']).toEqual(['accountant', COLLABORATOR_TAG, 'vip']);
    expect(result.contactIds).toEqual(
      new Map([
        ['UidOne', migId('referrers/r1')],
        ['UidTwo', migId('referrers/r1')],
      ]),
    );
  });

  it('tags a referrer record that has no tags yet', () => {
    const ctx = ctxWithPeople();
    const referrer = { entity: 'contacts', path: 'orgs/org1/contacts/r1', legacyPath: 'referrers/r1' } as const;
    const result = mapCollaborators(
      ctx,
      [FIXTURE_UIDS.colleague],
      [{ ...referrer, data: { kind: 'person', dedupeKey: 'person:ellis jordan|' } }],
    );
    expect(result.records).toEqual([
      { ...referrer, data: { kind: 'person', dedupeKey: 'person:ellis jordan|', tags: [COLLABORATOR_TAG] } },
    ]);
    expect(result.contactIds.get(FIXTURE_UIDS.colleague)).toBe('r1');
  });

  it('never merges into a referrer without data', () => {
    const ctx = ctxWithPeople();
    const referrer = mapReferrer(ctx, 'referrers/r1', { name: 'Jordan Ellis' });
    const { data, ...withoutData } = referrer;
    expect(data).toBeDefined();
    const result = mapCollaborators(ctx, [FIXTURE_UIDS.colleague], [withoutData]);
    expect(result.records.map((record) => record.legacyPath)).toEqual([`profiles/${FIXTURE_UIDS.colleague}`]);
  });

  it('is empty for no uids', () => {
    expect(mapCollaborators(ctxWithPeople(), [], [])).toEqual({ records: [], contactIds: new Map() });
  });
});
