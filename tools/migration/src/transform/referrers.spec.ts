import { domain } from '../domain.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import type { MappingProfile } from '../profile.ts';
import { migId } from './context.ts';
import { mapReferrer, mapReferrers } from './referrers.ts';
import { loadSpecProfile, SPEC_AS_OF, specContext, warned } from './spec-helpers.ts';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadSpecProfile();
});

const R1 = 'referrers/7e7e0000-0000-4000-8000-000000000001';
const R2 = 'referrers/7e7e0000-0000-4000-8000-000000000002';
const R3 = 'referrers/7e7e0000-0000-4000-8000-000000000003';
const R4 = 'referrers/7e7e0000-0000-4000-8000-000000000004';

/** Fictional referrers in the shapes legacy wrote them. */
const ACCOUNTANT = {
  id: '7e7e0000-0000-4000-8000-000000000001',
  name: 'Fictional Accountant',
  company: 'Fictional Accounting Pty Ltd',
  industry: 'Accountant',
  phone: '0412 345 678',
  email: 'Accountant@Example.com',
  address: '1 Example St, Geelong VIC 3220',
};
const FUNERAL_HOME = {
  id: '7e7e0000-0000-4000-8000-000000000002',
  name: '',
  company: 'Fictional Funeral Services',
  industry: 'funeral home',
  phone: '(03) 5221 0000',
  email: 'not-an-email',
  createdOn: '2024-06-01T00:00:00.000Z',
  updatedOn: '2024-07-01T00:00:00.000Z',
};
const UNNAMED = { id: '7e7e0000-0000-4000-8000-000000000003', name: '', phone: '' };

describe('mapReferrers', () => {
  it('maps each referrer to a contact and its legacy id to the contact id, skipping missing records', () => {
    const ctx = specContext(profile);
    const records: ExportRecord[] = [
      { path: R1, data: ACCOUNTANT },
      { path: R2, data: FUNERAL_HOME },
      { path: R4, data: null },
      { path: R3, data: UNNAMED },
    ];
    const result = mapReferrers(ctx, records);
    expect(result.records.map((record) => record.legacyPath)).toEqual([R1, R2, R3]);
    expect(result.contactIds).toEqual(
      new Map([
        ['7e7e0000-0000-4000-8000-000000000001', migId(R1)],
        ['7e7e0000-0000-4000-8000-000000000002', migId(R2)],
        ['7e7e0000-0000-4000-8000-000000000003', migId(R3)],
      ]),
    );
    for (const record of result.records) {
      expect(record.entity).toBe('contacts');
      expect(record.path).toBe(`orgs/org1/contacts/${migId(record.legacyPath)}`);
      expect(domain.ContactSchema.safeParse(record.data).success).toBe(true);
    }
  });

  it('is empty for no referrers', () => {
    const result = mapReferrers(specContext(profile), []);
    expect(result).toEqual({ records: [], contactIds: new Map() });
  });
});

describe('mapReferrer', () => {
  it('maps a named referrer to a person, with the company in referrerMeta', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R1, ACCOUNTANT);
    expect(data).toMatchObject({
      kind: 'person',
      givenNames: 'Fictional',
      familyName: 'Accountant',
      isReferrer: true,
      referrerMeta: { company: 'Fictional Accounting Pty Ltd', industry: 'accountant' },
      emails: [{ type: 'work', address: 'accountant@example.com' }],
      phones: [{ type: 'mobile', number: '+61412345678' }],
      addresses: [
        {
          type: 'business',
          line1: '1 Example St',
          suburb: 'Geelong',
          state: 'VIC',
          postcode: '3220',
          country: 'AU',
        },
      ],
      tags: [],
      matterRoles: [],
      migration: { runId: 'run1', legacyPath: R1, loadedAt: SPEC_AS_OF },
    });
    expect(data).not.toHaveProperty('orgName');
    expect(data).not.toHaveProperty('notes');
    expect(data).not.toHaveProperty('needsReview');
  });

  it('uses the export time, with MIG_W_REFERRER_NO_TIMESTAMPS, for a referrer without dates', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R1, ACCOUNTANT);
    expect(data).toMatchObject({ createdAt: SPEC_AS_OF, updatedAt: SPEC_AS_OF });
    expect(warned(ctx)).toEqual({ MIG_W_REFERRER_NO_TIMESTAMPS: [R1] });
  });

  it('uses updatedOn for both dates when a referrer has only that', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R1, { ...ACCOUNTANT, updatedOn: '2025-02-01T00:00:00.000Z' });
    expect(data).toMatchObject({
      createdAt: new Date('2025-02-01T00:00:00.000Z'),
      updatedAt: new Date('2025-02-01T00:00:00.000Z'),
    });
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [R1] });
  });

  it('treats empty-string dates as no dates', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R1, { ...ACCOUNTANT, createdOn: '', updatedOn: '' });
    expect(data).toMatchObject({ createdAt: SPEC_AS_OF, updatedAt: SPEC_AS_OF });
    expect(warned(ctx)).toEqual({ MIG_W_REFERRER_NO_TIMESTAMPS: [R1] });
  });

  it('treats a null createdOn as no dates', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R1, { ...ACCOUNTANT, createdOn: null });
    expect(data).toMatchObject({ createdAt: SPEC_AS_OF, updatedAt: SPEC_AS_OF });
    expect(warned(ctx)).toEqual({ MIG_W_REFERRER_NO_TIMESTAMPS: [R1] });
  });

  it('maps a referrer with only a company to an organisation, with its own dates', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R2, { ...FUNERAL_HOME, email: 'office@example.com' });
    expect(data).toMatchObject({
      kind: 'organisation',
      orgName: 'Fictional Funeral Services',
      referrerMeta: { industry: 'funeral_director' },
      phones: [{ type: 'home', number: '+61352210000' }],
      createdAt: new Date('2024-06-01T00:00:00.000Z'),
      updatedAt: new Date('2024-07-01T00:00:00.000Z'),
      dedupeKey: 'org:fictional funeral services',
    });
    expect(data?.['referrerMeta']).not.toHaveProperty('company');
    expect(data).not.toHaveProperty('givenNames');
    expect(warned(ctx)).toEqual({});
  });

  it('flags a referrer with neither a name nor a company for review', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R3, UNNAMED);
    expect(data).toMatchObject({
      kind: 'organisation',
      orgName: 'Unnamed referrer (imported)',
      isReferrer: true,
      phones: [],
      emails: [],
      addresses: [],
      needsReview: ['referrer_unnamed'],
    });
    expect(data).not.toHaveProperty('referrerMeta');
    expect(data).not.toHaveProperty('notes');
    expect(warned(ctx)).toEqual({ MIG_W_REFERRER_UNNAMED: [R3], MIG_W_REFERRER_NO_TIMESTAMPS: [R3] });
  });

  it('keeps an invalid phone, email or address in the notes, with a warning each', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R2, {
      ...FUNERAL_HOME,
      phone: '12345',
      email: 'not-an-email',
      address: 'Behind the  old post office',
    });
    expect(data).toMatchObject({
      phones: [],
      emails: [],
      addresses: [],
      notes: 'Phone (imported): 12345\nEmail (imported): not-an-email\nAddress (imported): Behind the old post office',
    });
    expect(warned(ctx)).toEqual({
      MIG_W_PHONE_INVALID: [R2],
      MIG_W_EMAIL_INVALID: [R2],
      MIG_W_ADDRESS_UNPARSED: [R2],
    });
    expect(domain.ContactSchema.safeParse(data).success).toBe(true);
  });

  it('keeps only the invalid one in the notes', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R2, FUNERAL_HOME);
    expect(data).toMatchObject({
      phones: [{ type: 'home', number: '+61352210000' }],
      emails: [],
      notes: 'Email (imported): not-an-email',
    });
    expect(warned(ctx)).toEqual({ MIG_W_EMAIL_INVALID: [R2] });
  });

  it('reads free-text industries through referrerIndustryFromText', () => {
    const industry = (text: unknown) =>
      (
        mapReferrer(specContext(profile), R1, { ...ACCOUNTANT, industry: text }).data?.['referrerMeta'] as
          { industry?: string } | undefined
      )?.industry;
    expect(industry('Accountant')).toBe('accountant');
    expect(industry('Financial  Planner')).toBe('financial_planner');
    expect(industry('funeral home')).toBe('funeral_director');
    expect(industry('Bakery')).toBe('other');
    expect(industry('')).toBeUndefined();
    expect(industry(undefined)).toBeUndefined();
    expect(industry(42)).toBeUndefined();
  });

  it('leaves referrerMeta out when there is neither a company beside a name nor an industry', () => {
    const { data } = mapReferrer(specContext(profile), R1, { name: 'Morgan' });
    expect(data).toMatchObject({ kind: 'person', familyName: 'Morgan' });
    expect(data).not.toHaveProperty('referrerMeta');
    expect(data).not.toHaveProperty('givenNames');
  });

  it('tidies whitespace in names and values', () => {
    const { data } = mapReferrer(specContext(profile), R1, {
      name: '  Jane   Mary\nSmith ',
      company: '  Fictional   Wealth ',
      phone: ' 0412 345 678 ',
    });
    expect(data).toMatchObject({
      givenNames: 'Jane Mary',
      familyName: 'Smith',
      referrerMeta: { company: 'Fictional Wealth' },
      phones: [{ type: 'mobile', number: '+61412345678' }],
    });
  });

  it('reads the dates it has, with their warnings', () => {
    const ctx = specContext(profile);
    const { data } = mapReferrer(ctx, R2, {
      ...FUNERAL_HOME,
      email: '',
      createdOn: '2024-07-01T00:00:00.000Z',
      updatedOn: '2024-06-01T00:00:00.000Z',
    });
    expect(data).toMatchObject({
      createdAt: new Date('2024-07-01T00:00:00.000Z'),
      updatedAt: new Date('2024-07-01T00:00:00.000Z'),
    });
    expect(warned(ctx)).toEqual({ MIG_W_UPDATED_BEFORE_CREATED: [R2] });

    const invalid = specContext(profile);
    const { data: fallback } = mapReferrer(invalid, R2, {
      ...FUNERAL_HOME,
      email: '',
      createdOn: 'garbage',
      updatedOn: null,
    });
    expect(fallback).toMatchObject({ createdAt: SPEC_AS_OF, updatedAt: SPEC_AS_OF });
    expect(warned(invalid)).toEqual({ MIG_W_DATE_INVALID: [R2] });
  });

  it('is written by the user', () => {
    const { data } = mapReferrer(specContext(profile), R1, ACCOUNTANT);
    expect(data).toMatchObject({
      createdBy: 'AlexRiversLegacyUid000000001',
      updatedBy: 'AlexRiversLegacyUid000000001',
    });
  });
});
