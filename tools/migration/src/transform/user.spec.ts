import { domain } from '../domain.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import type { StorageObject } from '../legacy/snapshot.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { Warnings, type TransformContext, type TransformedRecord, type WarningCode } from './context.ts';
import { CopyPlanSchema } from './run.ts';
import { colourFor, initialsOf, mapBudgets, mapProfile, orgNameOf, subjectOf, type Subject } from './user.ts';

const UID = FIXTURE_UIDS.subject;
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const PROFILE_PATH = `profiles/${UID}`;
const COLOURS = ['#346CFC', '#0E9F6E', '#C2410C', '#7C3AED', '#0891B2', '#BE185D', '#4D7C0F', '#B45309'];

const fixtureProfile = (): ExportRecord => {
  const doc = loadLegacyFixtures().docs.find((d) => d.path === PROFILE_PATH);
  if (!doc) throw new Error('No fixture profile');
  return { path: doc.path, data: doc.data };
};
const auth: ExportRecord = {
  path: `auth/${UID}`,
  data: { email: 'Alex.Rivers@Example.com', providers: ['google.com'] },
};
const photo: StorageObject = {
  name: `profile-images/${UID}.png`,
  size: 5000,
  contentType: 'image/png',
  md5Hash: 'cGhvdG8tbWQ1',
  crc32c: 'AAAAAA==',
  generation: '1700000000000002',
};

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map(),
    members: new Set([UID]),
    warnings: new Warnings(),
    ...over,
  };
}

/** A context whose profile names no org, so the name comes from legacy (D-09). */
function unnamed(over: Partial<TransformContext> = {}): TransformContext {
  const org: MappingProfile['org'] = { timezone: profile.org.timezone, jurisdiction: profile.org.jurisdiction };
  return makeCtx({ profile: { ...profile, org }, ...over });
}

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

const byEntity = (records: readonly TransformedRecord[], entity: TransformedRecord['entity']) =>
  records.find((record) => record.entity === entity);

const meta = (legacyPath: string) => ({
  createdAt: AS_OF,
  createdBy: UID,
  updatedAt: AS_OF,
  updatedBy: UID,
  schemaVersion: 1,
  migration: { runId: 'run1', legacyPath, loadedAt: AS_OF },
});

describe('subjectOf', () => {
  it("takes the profile's names and lower-cased email", () => {
    expect(
      subjectOf(
        { displayName: ' Alex  Rivers ', firstName: 'Alex', lastName: 'Rivers', email: 'Alex@Example.com' },
        null,
      ),
    ).toEqual({ displayName: 'Alex Rivers', firstName: 'Alex', lastName: 'Rivers', email: 'alex@example.com' });
  });

  it('falls back to the first and last names', () => {
    expect(subjectOf({ displayName: '', firstName: 'Jordan', lastName: 'Ellis' }, null).displayName).toBe(
      'Jordan Ellis',
    );
    expect(subjectOf({ firstName: 'Jordan' }, null).displayName).toBe('Jordan');
    expect(subjectOf({ lastName: 'Ellis' }, null).displayName).toBe('Ellis');
  });

  it("falls back to the email's local part, from the Auth record when the profile has none", () => {
    expect(subjectOf({ email: 'pat.lee@example.com' }, null)).toEqual({
      displayName: 'pat.lee',
      firstName: '',
      lastName: '',
      email: 'pat.lee@example.com',
    });
    expect(subjectOf(null, { email: 'Sam.Ng@Example.com' })).toEqual({
      displayName: 'sam.ng',
      firstName: '',
      lastName: '',
      email: 'sam.ng@example.com',
    });
    expect(subjectOf({ email: '' }, { email: 'sam@example.com' }).email).toBe('sam@example.com');
  });

  it('is "Member" with nothing to go on', () => {
    expect(subjectOf(null, null)).toEqual({ displayName: 'Member', firstName: '', lastName: '', email: '' });
    expect(subjectOf({ displayName: 42, email: null }, { email: 7 }).displayName).toBe('Member');
  });
});

describe('orgNameOf', () => {
  const subject: Subject = { displayName: 'Alex Rivers', firstName: 'Alex', lastName: 'Rivers', email: '' };

  it("takes the profile's org name as confirmed", () => {
    expect(orgNameOf(makeCtx(), { companyName: 'Materia Technologies' }, subject)).toEqual({
      name: 'Rivers Wills & Estates',
      confirmed: true,
    });
  });

  it('takes the legacy company name, unconfirmed', () => {
    expect(orgNameOf(unnamed(), { companyName: '  Rivers  Legal ' }, subject)).toEqual({
      name: 'Rivers Legal',
      confirmed: false,
    });
  });

  it('names the practice after the user when there is no company name', () => {
    expect(orgNameOf(unnamed(), { companyName: null }, subject)).toEqual({
      name: "Alex Rivers's practice",
      confirmed: false,
    });
    expect(orgNameOf(unnamed(), null, subject).name).toBe("Alex Rivers's practice");
  });
});

describe('mapProfile', () => {
  it('writes the org, the user and their owner membership for a new org', () => {
    const ctx = makeCtx();
    const result = mapProfile(ctx, { profile: fixtureProfile(), auth, newOrg: true, photo: undefined });
    expect(result.subject).toEqual({
      displayName: 'Alex Rivers',
      firstName: 'Alex',
      lastName: 'Rivers',
      email: 'alex.rivers@example.com',
    });
    expect(result.orgName).toBe('Rivers Wills & Estates');
    expect(result.records.map((record) => [record.entity, record.path, record.legacyPath])).toEqual([
      ['orgs', 'orgs/org1', `${PROFILE_PATH}#org`],
      ['users', `users/${UID}`, PROFILE_PATH],
      ['members', `orgs/org1/members/${UID}`, `${PROFILE_PATH}#member`],
    ]);

    const org = byEntity(result.records, 'orgs');
    expect(org?.data).toEqual({
      name: 'Rivers Wills & Estates',
      practiceType: 'wills_estates',
      jurisdictions: ['VIC'],
      primaryJurisdiction: 'VIC',
      timezone: 'Australia/Melbourne',
      holidayLocality: 'VIC_MELBOURNE',
      billing: {
        unitMinutes: 6,
        rounding: 'up',
        gstRegistered: true,
        defaultRateCents: 0,
        invoicePrefix: 'INV-',
        paymentTermsDays: 14,
      },
      matterNumberFormat: 'M-{YYYY}-{seq:4}',
      fy: { startMonth: 7 },
      retentionYears: 7,
      plan: 'trial',
      security: domain.newOrgSecurity(AS_OF),
      ...meta(`${PROFILE_PATH}#org`),
    });
    expect(() => domain.OrgSchema.parse(org?.data)).not.toThrow();

    const user = byEntity(result.records, 'users');
    expect(user?.data).toEqual({
      email: 'alex.rivers@example.com',
      displayName: 'Alex Rivers',
      firstName: 'Alex',
      lastName: 'Rivers',
      orgIds: ['org1'],
      activeOrgId: 'org1',
      claimsVersion: 0,
      memberships: { org1: { role: 'owner', name: 'Rivers Wills & Estates' } },
      prefs: domain.DEFAULT_USER_PREFS,
      legacy: { uid: UID, migratedAt: AS_OF },
      ...meta(PROFILE_PATH),
    });
    expect(() => domain.UserSchema.parse(user?.data)).not.toThrow();

    const member = byEntity(result.records, 'members');
    expect(member?.data).toEqual({
      role: 'owner',
      status: 'active',
      email: 'alex.rivers@example.com',
      displayName: 'Alex Rivers',
      initials: 'AR',
      title: '',
      defaultRateCents: 0,
      rates: [],
      colour: colourFor(UID),
      // Dollars as cents, each keyed by its own financial year.
      budgets: { '2025': 25_000_000, '2024': 23_000_000 },
      ...meta(`${PROFILE_PATH}#member`),
      needsReview: ['budgets_imported'],
    });
    expect(() => domain.MemberSchema.parse(member?.data)).not.toThrow();
    // The fixture's budgets are for years before the current one (2026).
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_ROLLED_OVER: [PROFILE_PATH] });
  });

  it('writes no org record into an existing org', () => {
    const ctx = unnamed();
    const result = mapProfile(ctx, { profile: fixtureProfile(), auth, newOrg: false, photo: undefined });
    expect(result.records.map((record) => record.entity)).toEqual(['users', 'members']);
    expect(result.orgName).toBe('Rivers Wills & Estates');
    // An existing org's name is already confirmed: nothing to review.
    expect(warned(ctx)).not.toHaveProperty('MIG_W_ORG_NAME_UNCONFIRMED');
  });

  it('flags a new org named from legacy for the user to confirm', () => {
    const ctx = unnamed();
    const data = { ...(fixtureProfile().data ?? {}), companyName: 'Materia Technologies' };
    const result = mapProfile(ctx, { profile: { path: PROFILE_PATH, data }, auth, newOrg: true, photo: undefined });
    const org = byEntity(result.records, 'orgs');
    expect(org?.data).toMatchObject({ name: 'Materia Technologies', needsReview: ['org_name_unconfirmed'] });
    expect(byEntity(result.records, 'users')?.data?.['memberships']).toEqual({
      org1: { role: 'owner', name: 'Materia Technologies' },
    });
    expect(warned(ctx)).toMatchObject({ MIG_W_ORG_NAME_UNCONFIRMED: [PROFILE_PATH] });
    expect(() => domain.OrgSchema.parse(org?.data)).not.toThrow();
  });

  it('uses the context time zone and the profile jurisdiction', () => {
    const ctx = makeCtx({
      timeZone: 'Australia/Sydney',
      profile: { ...profile, org: { ...profile.org, jurisdiction: 'NSW' } },
    });
    const org = byEntity(
      mapProfile(ctx, { profile: fixtureProfile(), auth, newOrg: true, photo: undefined }).records,
      'orgs',
    );
    expect(org?.data).toMatchObject({
      timezone: 'Australia/Sydney',
      jurisdictions: ['NSW'],
      primaryJurisdiction: 'NSW',
    });
  });

  it('plans a copy of the profile photo to the avatar', () => {
    const result = mapProfile(makeCtx(), { profile: fixtureProfile(), auth, newOrg: false, photo });
    const avatar = byEntity(result.records, 'avatars');
    expect(avatar).toEqual({
      entity: 'avatars',
      path: `users/${UID}/avatar.png`,
      legacyPath: photo.name,
      copy: {
        source: photo.name,
        target: `users/${UID}/avatar.png`,
        fileName: 'avatar.png',
        mime: 'image/png',
        sizeBytes: 5000,
        md5Hash: 'cGhvdG8tbWQ1',
        crc32c: 'AAAAAA==',
        generation: '1700000000000002',
      },
    });
    expect(CopyPlanSchema.parse(avatar?.copy)).toEqual(avatar?.copy);
  });

  it('reads a photo with no type as a PNG, and copies only the checksums it has', () => {
    const result = mapProfile(makeCtx(), {
      profile: fixtureProfile(),
      auth,
      newOrg: false,
      photo: { name: `profile-images/${UID}`, size: 10 },
    });
    expect(byEntity(result.records, 'avatars')?.copy).toEqual({
      source: `profile-images/${UID}`,
      target: `users/${UID}/avatar.png`,
      fileName: 'avatar.png',
      mime: 'image/png',
      sizeBytes: 10,
    });
  });

  it('maps a user whose legacy profile is missing from their Auth record', () => {
    const ctx = makeCtx();
    const result = mapProfile(ctx, { profile: undefined, auth, newOrg: false, photo: undefined });
    expect(result.subject.displayName).toBe('alex.rivers');
    const user = byEntity(result.records, 'users');
    expect(user?.legacyPath).toBe(PROFILE_PATH);
    expect(user?.data).toMatchObject({ email: 'alex.rivers@example.com', displayName: 'alex.rivers', firstName: '' });
    const member = byEntity(result.records, 'members');
    expect(member?.data).toMatchObject({ initials: 'AL', budgets: {} });
    expect(member?.data).not.toHaveProperty('needsReview');
    expect(() => domain.MemberSchema.parse(member?.data)).not.toThrow();
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_MISSING: [PROFILE_PATH] });
  });

  it('leaves the email off the member when there is none', () => {
    const result = mapProfile(makeCtx(), {
      profile: { path: PROFILE_PATH, data: { displayName: 'Alex Rivers' } },
      auth: undefined,
      newOrg: false,
      photo: undefined,
    });
    expect(byEntity(result.records, 'members')?.data).not.toHaveProperty('email');
    expect(byEntity(result.records, 'users')?.data?.['email']).toBe('');
  });

  it('treats a profile document that is gone like a missing one', () => {
    const ctx = makeCtx();
    const result = mapProfile(ctx, {
      profile: { path: PROFILE_PATH, data: null },
      auth,
      newOrg: false,
      photo: undefined,
    });
    expect(result.subject.email).toBe('alex.rivers@example.com');
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_MISSING: [PROFILE_PATH] });
  });
});

describe('mapBudgets', () => {
  it('warns when the profile has no budget fields (older profiles)', () => {
    const ctx = makeCtx();
    expect(mapBudgets(ctx, { displayName: 'Alex Rivers' }, PROFILE_PATH)).toEqual({});
    expect(mapBudgets(ctx, null, `${PROFILE_PATH}b`)).toEqual({});
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_MISSING: [PROFILE_PATH, `${PROFILE_PATH}b`] });
  });

  it('keys each budget by its own legacy year, in cents', () => {
    const ctx = makeCtx();
    expect(
      mapBudgets(
        ctx,
        {
          currentFinancialYearBudget: 250000.5,
          budgetFinancialYear: 2026,
          previousFinancialYearBudget: 230000,
          previousBudgetFinancialYear: 2025,
        },
        PROFILE_PATH,
      ),
    ).toEqual({ '2026': 25_000_050, '2025': 23_000_000 });
    expect(warned(ctx)).toEqual({});
  });

  it('reads cents when the profile says so', () => {
    const ctx = makeCtx({ profile: { ...profile, fees: { ...profile.fees, unit: 'cents' } } });
    expect(mapBudgets(ctx, { currentFinancialYearBudget: 1234, budgetFinancialYear: 2026 }, PROFILE_PATH)).toEqual({
      '2026': 1234,
    });
  });

  it('reads a budget with no year as the current financial year, with a warning', () => {
    const ctx = makeCtx();
    expect(mapBudgets(ctx, { currentFinancialYearBudget: 1000 }, PROFILE_PATH)).toEqual({ '2026': 100_000 });
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_YEAR_MISSING: [PROFILE_PATH] });
  });

  it.each([null, 'FY26', 26, 2025.5, 1999, 10000])('reads a budget year of %j as missing', (budgetFinancialYear) => {
    const ctx = makeCtx();
    expect(mapBudgets(ctx, { currentFinancialYearBudget: 10, budgetFinancialYear }, PROFILE_PATH)).toEqual({
      '2026': 1000,
    });
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_YEAR_MISSING: [PROFILE_PATH] });
  });

  it('reads a previous budget with no year as the year before', () => {
    const ctx = makeCtx();
    expect(
      mapBudgets(
        ctx,
        { currentFinancialYearBudget: 10, budgetFinancialYear: 2026, previousFinancialYearBudget: 5 },
        PROFILE_PATH,
      ),
    ).toEqual({ '2026': 1000, '2025': 500 });
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_YEAR_MISSING: [PROFILE_PATH] });
  });

  it('finds the current financial year in the org time zone', () => {
    // 30 June 2026 23:00 in Melbourne is still the year starting July 2025.
    const june = makeCtx({ asOf: new Date('2026-06-30T13:00:00Z') });
    expect(mapBudgets(june, { currentFinancialYearBudget: 1 }, PROFILE_PATH)).toEqual({ '2025': 100 });
    // 1 July 2026 01:00 in Melbourne starts the 2026 year, though it is still 30 June in UTC.
    const july = makeCtx({ asOf: new Date('2026-06-30T15:00:00Z') });
    expect(mapBudgets(july, { currentFinancialYearBudget: 1 }, PROFILE_PATH)).toEqual({ '2026': 100 });
  });

  it('warns that this year has no budget when every budget is for an earlier year', () => {
    const ctx = makeCtx();
    expect(
      mapBudgets(
        ctx,
        {
          currentFinancialYearBudget: 250000,
          budgetFinancialYear: 2025,
          previousFinancialYearBudget: 230000,
          previousBudgetFinancialYear: 2024,
        },
        PROFILE_PATH,
      ),
    ).toEqual({ '2025': 25_000_000, '2024': 23_000_000 });
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_ROLLED_OVER: [PROFILE_PATH] });
  });

  it("doesn't warn of a rollover when a budget is for this year or later", () => {
    const ctx = makeCtx();
    mapBudgets(ctx, { currentFinancialYearBudget: 1, budgetFinancialYear: 2027 }, PROFILE_PATH);
    mapBudgets(
      ctx,
      {
        currentFinancialYearBudget: 1,
        budgetFinancialYear: 2026,
        previousFinancialYearBudget: 1,
        previousBudgetFinancialYear: 2020,
      },
      PROFILE_PATH,
    );
    expect(warned(ctx)).toEqual({});
  });

  it('never lets the previous budget overwrite the current one for the same year', () => {
    const ctx = makeCtx();
    expect(
      mapBudgets(
        ctx,
        {
          currentFinancialYearBudget: 300,
          budgetFinancialYear: 2026,
          previousFinancialYearBudget: 200,
          previousBudgetFinancialYear: 2026,
        },
        PROFILE_PATH,
      ),
    ).toEqual({ '2026': 30_000 });
  });

  it('skips budgets that are not amounts, without other warnings', () => {
    const ctx = makeCtx();
    expect(
      mapBudgets(
        ctx,
        {
          currentFinancialYearBudget: null,
          budgetFinancialYear: null,
          previousFinancialYearBudget: 'lots',
          previousBudgetFinancialYear: null,
        },
        PROFILE_PATH,
      ),
    ).toEqual({});
    expect(warned(ctx)).toEqual({});
  });

  it('counts a profile with only the previous budget field as having budgets', () => {
    const ctx = makeCtx();
    expect(
      mapBudgets(ctx, { previousFinancialYearBudget: 100, previousBudgetFinancialYear: 2025 }, PROFILE_PATH),
    ).toEqual({ '2025': 10_000 });
    expect(warned(ctx)).toEqual({ MIG_W_BUDGET_ROLLED_OVER: [PROFILE_PATH] });
  });
});

describe('initialsOf', () => {
  it.each([
    ['Priya Shah', 'PS'],
    ['Alex Mary Rivers', 'AR'],
    ['  alex   rivers ', 'AR'],
    ['Alex', 'AL'],
    ['j', 'J'],
    ['', '?'],
    ['   ', '?'],
  ])('gives %j the initials %s', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});

describe('colourFor', () => {
  it('gives a uid the same palette colour every time', () => {
    const colour = colourFor(UID);
    expect(COLOURS).toContain(colour);
    expect(colourFor(UID)).toBe(colour);
  });

  it('hashes the uid as apps/functions does', () => {
    // hash = hash * 31 + code, kept unsigned 32-bit; the colour is hash mod 8.
    expect(colourFor('')).toBe('#346CFC');
    expect(colourFor('a')).toBe(COLOURS[97 % 8]);
    expect(colourFor('ab')).toBe(COLOURS[(97 * 31 + 98) % 8]);
  });

  it('spreads uids over the palette', () => {
    const colours = new Set(Array.from({ length: 64 }, (_, i) => colourFor(`LegacyUid${i}`)));
    expect(colours.size).toBeGreaterThan(4);
  });
});
