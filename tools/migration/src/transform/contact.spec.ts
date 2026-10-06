import { domain } from '../domain.ts';
import { FIXTURE_UIDS } from '../legacy/fixtures.ts';
import type { MappingProfile } from '../profile.ts';
import {
  buildContact,
  contactName,
  contactPath,
  emailEntry,
  parseAddress,
  phoneEntry,
  type ContactInput,
} from './contact.ts';
import { migId } from './context.ts';
import { loadSpecProfile, SPEC_AS_OF, specContext, warned } from './spec-helpers.ts';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadSpecProfile();
});

const CREATED = new Date('2024-06-01T00:00:00.000Z');
const UPDATED = new Date('2025-01-15T03:00:00.000Z');

const person = (over: Partial<ContactInput> = {}): ContactInput => ({
  legacyPath: 'referrers/r1',
  kind: 'person',
  givenNames: 'Sam',
  familyName: 'Example',
  createdAt: CREATED,
  updatedAt: UPDATED,
  ...over,
});

describe('buildContact', () => {
  it('builds a contact at its deterministic path with the fields contacts-onWrite derives', () => {
    const ctx = specContext(profile);
    const record = buildContact(
      ctx,
      person({
        emails: [{ type: 'work', address: 'sam@example.com' }],
        phones: [{ type: 'mobile', number: '+61412345678' }],
      }),
    );
    const id = migId('referrers/r1');
    expect(record).toMatchObject({ entity: 'contacts', path: `orgs/org1/contacts/${id}`, legacyPath: 'referrers/r1' });
    expect(record.path).toBe(contactPath(ctx, id));
    expect(record.data).toEqual({
      kind: 'person',
      givenNames: 'Sam',
      familyName: 'Example',
      emails: [{ type: 'work', address: 'sam@example.com' }],
      phones: [{ type: 'mobile', number: '+61412345678' }],
      addresses: [],
      tags: [],
      isReferrer: false,
      matterRoles: [],
      search: expect.arrayContaining(['example', 'sam']),
      dedupeKey: 'person:example sam|',
      sortName: 'sam example',
      createdAt: CREATED,
      createdBy: FIXTURE_UIDS.subject,
      updatedAt: UPDATED,
      updatedBy: FIXTURE_UIDS.subject,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: 'referrers/r1', loadedAt: SPEC_AS_OF },
    });
    expect(domain.ContactSchema.safeParse(record.data).success).toBe(true);
    expect(warned(ctx)).toEqual({});
  });

  it('derives the same fields as the domain does', () => {
    const ctx = specContext(profile);
    const record = buildContact(ctx, person({ phones: [{ type: 'home', number: '+61352210000' }] }));
    const derived = domain.contactDerivedFields({
      kind: 'person',
      givenNames: 'Sam',
      familyName: 'Example',
      emails: [],
      phones: [{ type: 'home', number: '+61352210000' }],
    });
    expect(record.data).toMatchObject({ ...derived });
    expect(derived.search).toContain('0352210000');
  });

  it('sorts tags and lists each once', () => {
    const record = buildContact(
      specContext(profile),
      person({ tags: ['zeta', 'legacy-collaborator', 'zeta', 'alpha'] }),
    );
    expect(record.data?.['tags']).toEqual(['alpha', 'legacy-collaborator', 'zeta']);
  });

  it('builds an organisation, with referrer meta and notes when given', () => {
    const ctx = specContext(profile);
    const record = buildContact(ctx, {
      legacyPath: 'referrers/r2',
      kind: 'organisation',
      orgName: 'Fictional Funeral Services',
      isReferrer: true,
      referrerMeta: { industry: 'funeral_director' },
      notes: 'Email (imported): not-an-email',
      addresses: [parseAddress('1 Example St, Geelong VIC 3220', 'business') ?? {}],
      createdAt: CREATED,
      updatedAt: CREATED,
    });
    expect(record.data).toMatchObject({
      kind: 'organisation',
      orgName: 'Fictional Funeral Services',
      isReferrer: true,
      referrerMeta: { industry: 'funeral_director' },
      notes: 'Email (imported): not-an-email',
      dedupeKey: 'org:fictional funeral services',
      sortName: 'fictional funeral services',
    });
    expect(record.data).not.toHaveProperty('givenNames');
    expect(record.data).not.toHaveProperty('familyName');
    expect(domain.ContactSchema.safeParse(record.data).success).toBe(true);
  });

  it('leaves out empty names, referrer meta and notes', () => {
    const record = buildContact(
      specContext(profile),
      person({ givenNames: '', familyName: 'Example', orgName: '', referrerMeta: {}, notes: '' }),
    );
    for (const key of ['givenNames', 'orgName', 'referrerMeta', 'notes', 'needsReview']) {
      expect(record.data).not.toHaveProperty(key);
    }
  });

  it('carries review codes into needsReview', () => {
    const record = buildContact(
      specContext(profile),
      person({ needsReview: ['referrer_unnamed', 'referrer_unnamed'] }),
    );
    expect(record.data?.['needsReview']).toEqual(['referrer_unnamed']);
    const none = buildContact(specContext(profile), person({ needsReview: [] }));
    expect(none.data).not.toHaveProperty('needsReview');
  });

  it('gives the same record for the same input', () => {
    expect(buildContact(specContext(profile), person())).toEqual(buildContact(specContext(profile), person()));
  });

  it('writes under the context org', () => {
    const record = buildContact(specContext(profile, { orgId: 'org2' }), person());
    expect(record.path).toBe(`orgs/org2/contacts/${migId('referrers/r1')}`);
  });
});

describe('contactName', () => {
  it("is a person's given and family names, or an organisation's name", () => {
    const ctx = specContext(profile);
    expect(contactName(buildContact(ctx, person({ givenNames: 'Jane Mary', familyName: 'Smith' })))).toBe(
      'Jane Mary Smith',
    );
    const mononym = {
      legacyPath: 'referrers/r3',
      kind: 'person',
      familyName: 'Morgan',
      createdAt: CREATED,
      updatedAt: CREATED,
    } as const;
    expect(contactName(buildContact(ctx, mononym))).toBe('Morgan');
    expect(
      contactName(
        buildContact(ctx, {
          legacyPath: 'referrers/r2',
          kind: 'organisation',
          orgName: 'Fictional Accounting Pty Ltd',
          createdAt: CREATED,
          updatedAt: CREATED,
        }),
      ),
    ).toBe('Fictional Accounting Pty Ltd');
  });

  it('falls back to the domain placeholder for a record without data', () => {
    expect(contactName({ entity: 'contacts', path: 'orgs/org1/contacts/x', legacyPath: 'profiles/x' })).toBe(
      'Unnamed contact',
    );
  });
});

describe('phoneEntry', () => {
  it('reads Australian mobiles as E.164 mobiles', () => {
    for (const raw of ['0412 345 678', '0412345678', '+61 412 345 678', '  0412-345-678 ']) {
      expect(phoneEntry(raw)).toEqual({ type: 'mobile', number: '+61412345678' });
    }
  });

  it('reads landlines as E.164 home numbers', () => {
    for (const raw of ['(03) 5221 0000', '03 5221 0000', '+61 3 5221 0000', '0061 3 5221 0000']) {
      expect(phoneEntry(raw)).toEqual({ type: 'home', number: '+61352210000' });
    }
    expect(phoneEntry('03 5555 0123')).toEqual({ type: 'home', number: '+61355550123' });
  });

  it('is null for anything that is not a valid number', () => {
    for (const raw of ['', '   ', '12345', '0412 345', 'not a phone', '+61 4']) {
      expect(phoneEntry(raw)).toBeNull();
    }
  });
});

describe('emailEntry', () => {
  it('keeps a valid address, trimmed and lower-cased, with its type', () => {
    expect(emailEntry(' Jordan.Ellis@Example.COM ', 'work')).toEqual({
      type: 'work',
      address: 'jordan.ellis@example.com',
    });
    expect(emailEntry('sam@example.com', 'personal')).toEqual({ type: 'personal', address: 'sam@example.com' });
  });

  it('is null for an invalid address', () => {
    for (const raw of ['', 'not-an-email', 'sam@', '@example.com', 'sam example@example.com']) {
      expect(emailEntry(raw, 'other')).toBeNull();
    }
  });
});

describe('parseAddress', () => {
  const GEELONG = {
    type: 'business',
    line1: '1 Example St',
    suburb: 'Geelong',
    state: 'VIC',
    postcode: '3220',
    country: 'AU',
  };

  it('splits a one-line Australian address', () => {
    const address = parseAddress('1 Example St, Geelong VIC 3220', 'business');
    expect(address).toEqual(GEELONG);
    expect(domain.AddressSchema.safeParse(address).success).toBe(true);
  });

  it('accepts a trailing Australia', () => {
    expect(parseAddress('1 Example St, Geelong VIC 3220, Australia', 'business')).toEqual(GEELONG);
    expect(parseAddress('1 Example St, Geelong VIC 3220 AUSTRALIA', 'business')).toEqual(GEELONG);
  });

  it('keeps a second line', () => {
    expect(parseAddress('Unit 2, 10 Sample Rd, Belmont VIC 3216', 'postal')).toEqual({
      type: 'postal',
      line1: 'Unit 2',
      line2: '10 Sample Rd',
      suburb: 'Belmont',
      state: 'VIC',
      postcode: '3216',
      country: 'AU',
    });
    expect(parseAddress('Level 3, , 1 Example St, Sampleton NSW 2000', 'business')).toMatchObject({
      line1: 'Level 3',
      line2: '1 Example St',
      suburb: 'Sampleton',
      state: 'NSW',
    });
  });

  it('upper-cases a lower-case state and tidies whitespace', () => {
    expect(parseAddress('1 Example St, Geelong vic 3220', 'business')).toEqual(GEELONG);
    expect(parseAddress('  5  Sample   Ave,  Ocean Grove  VIC  3226 ', 'residential')).toEqual({
      type: 'residential',
      line1: '5 Sample Ave',
      suburb: 'Ocean Grove',
      state: 'VIC',
      postcode: '3226',
      country: 'AU',
    });
  });

  it('accepts a comma between the suburb and the state', () => {
    expect(parseAddress('1 Example St, Geelong, VIC 3220', 'business')).toEqual(GEELONG);
    expect(parseAddress('1 Example St,Geelong,VIC 3220', 'business')).toEqual(GEELONG);
    expect(parseAddress('1 Example St, Geelong, vic 3220, Australia', 'business')).toEqual(GEELONG);
    expect(parseAddress('Unit 2, 10 Sample Rd, Belmont, VIC 3216', 'postal')).toEqual({
      type: 'postal',
      line1: 'Unit 2',
      line2: '10 Sample Rd',
      suburb: 'Belmont',
      state: 'VIC',
      postcode: '3216',
      country: 'AU',
    });
  });

  it('is null for text that does not read as an address', () => {
    for (const raw of [
      '',
      'PO Box 123 Geelong',
      '1 Example St Geelong VIC 3220',
      '1 Example St, Geelong XYZ 3220',
      '1 Example St, Geelong VIC 32200',
      ', 1 Example St, Geelong VIC 3220',
      'Geelong, VIC 3220',
    ]) {
      expect(parseAddress(raw, 'business')).toBeNull();
    }
  });
});
