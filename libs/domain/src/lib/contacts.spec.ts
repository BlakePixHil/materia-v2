import {
  contactDedupeKey,
  contactDisplayName,
  contactInitials,
  contactSearchTokens,
  DUPLICATE_THRESHOLD,
  formatPhone,
  guessPhoneType,
  jaroWinkler,
  MergeContactsInput,
  nearDate,
  normalisePhone,
  postcodeMatchesState,
  scoreDuplicate,
  type DuplicateCandidate,
  type DuplicateProbe,
} from './contacts';
import { normaliseText, searchQueryToken, searchTokens, SEARCH_TOKENS_LIMIT } from './search';

// Dates are plain strings here; the scorer only compares them.
const person = (fields: Record<string, unknown>): DuplicateCandidate =>
  ({ kind: 'person', emails: [], phones: [], ...fields }) as DuplicateCandidate;

describe('search tokens', () => {
  it('lower-cases, strips diacritics and apostrophes, and takes prefixes of 2 to 10', () => {
    expect(normaliseText("Nguyễn O'Brien-Smith")).toBe('nguyen obrien smith');
    expect(searchTokens('Nguyễn')).toEqual(['ng', 'ngu', 'nguy', 'nguye', 'nguyen']);
    expect(searchTokens("O'Brien")).toContain('obrien');
    expect(searchTokens('Wolfeschlegelsteinhausen')).toContain('wolfeschle');
    expect(searchTokens('Wolfeschlegelsteinhausen').every((t) => t.length <= 10)).toBe(true);
    expect(searchTokens('a')).toEqual([]);
  });

  it('stops at 50 tokens and turns a query into its first token', () => {
    expect(
      searchTokens('alphabetical bystanders catastrophe dangerously enthusiasm fragmented gregarious'),
    ).toHaveLength(SEARCH_TOKENS_LIMIT);
    expect(searchQueryToken('  Nguyễn Van')).toBe('nguyen');
    expect(searchQueryToken('x')).toBeNull();
  });

  it('indexes a contact by names, organisation, email user and local phone', () => {
    const tokens = contactSearchTokens({
      kind: 'person',
      givenNames: 'Mai',
      familyName: 'Nguyễn',
      emails: [{ type: 'personal', address: 'mai.n@example.test' }],
      phones: [{ type: 'mobile', number: '+61412345678' }],
    });
    expect(tokens).toEqual(expect.arrayContaining(['nguyen', 'mai', 'ma', '0412345678']));
  });
});

describe('names', () => {
  it.each([
    [{ kind: 'person', givenNames: 'Margaret', familyName: 'Ellis', preferredName: 'Peggy' }, 'Peggy Ellis', 'PE'],
    [{ kind: 'person', givenNames: 'Teuila' }, 'Teuila', 'T'],
    [{ kind: 'organisation', orgName: 'Harbour Trustees Pty Ltd' }, 'Harbour Trustees Pty Ltd', 'HL'],
    [{ kind: 'person' }, 'Unnamed contact', 'UC'],
  ] as const)('%o → %s', (contact, name, initials) => {
    expect(contactDisplayName(contact)).toBe(name);
    expect(contactInitials(contact)).toBe(initials);
  });

  it('builds the same dedupe key whatever the name order', () => {
    expect(contactDedupeKey(person({ givenNames: 'John', familyName: 'Smith', dateOfBirth: '1950-01-02' }))).toBe(
      contactDedupeKey(person({ givenNames: 'Smith', familyName: 'John', dateOfBirth: '1950-01-02' })),
    );
    expect(contactDedupeKey({ kind: 'organisation', orgName: 'Acme Pty Ltd' })).toBe('org:acme');
    expect(contactDedupeKey({ kind: 'organisation', orgName: 'Acme', abn: '51824753556' })).toBe('abn:51824753556');
  });
});

describe('phones', () => {
  it.each([
    ['0412 345 678', '+61412345678', 'mobile', '0412 345 678'],
    ['+61 412 345 678', '+61412345678', 'mobile', '0412 345 678'],
    ['(02) 9876 5432', '+61298765432', 'home', '(02) 9876 5432'],
    ['03 9123 4567', '+61391234567', 'home', '(03) 9123 4567'],
    ['+44 20 7946 0958', '+442079460958', 'home', '+44 20 7946 0958'],
    ['0044 20 7946 0958', '+442079460958', 'home', '+44 20 7946 0958'],
  ])('%s → %s', (raw, e164, type, formatted) => {
    expect(normalisePhone(raw)).toBe(e164);
    expect(guessPhoneType(e164)).toBe(type);
    expect(formatPhone(e164)).toBe(formatted);
  });

  it.each(['', '   ', '12', 'not a phone', '0412 345'])('rejects %j', (raw) => {
    expect(normalisePhone(raw)).toBeNull();
  });
});

describe('postcodes', () => {
  it.each([
    ['NSW', '2000', true],
    ['NSW', '2600', false],
    ['ACT', '2600', true],
    ['ACT', '0200', true],
    ['VIC', '3000', true],
    ['VIC', '2000', false],
    ['QLD', '4000', true],
    ['SA', '5000', true],
    ['WA', '6000', true],
    ['WA', '6798', false],
    ['TAS', '7000', true],
    ['NT', '0800', true],
    ['NT', '800', false],
    ['XX', '2000', false],
  ])('%s %s → %s', (state, postcode, ok) => {
    expect(postcodeMatchesState(state, postcode)).toBe(ok);
  });
});

describe('duplicate scoring', () => {
  it('Jaro-Winkler matches the textbook values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('', 'abc')).toBe(0);
  });

  it('treats one-digit, transposed and day/month-swapped dates as near', () => {
    expect(nearDate('1950-03-12', '1950-03-13')).toBe(true);
    expect(nearDate('1950-03-12', '1950-03-21')).toBe(true);
    expect(nearDate('1950-03-12', '1950-03-24')).toBe(false);
    expect(nearDate('1950-03-12', '1950-12-03')).toBe(true);
    expect(nearDate('1950-03-12', '1962-07-30')).toBe(false);
  });

  // The CORE-01 fixture: ten near-duplicates of stored contacts (at least nine must be found) and
  // stored contacts that only look alike (at most one may be offered).
  const stored = {
    ellis: person({ givenNames: 'Margaret Anne', familyName: 'Ellis', dateOfBirth: '1941-05-17' }),
    nguyen: person({ givenNames: 'Thi Mai', familyName: 'Nguyễn', dateOfBirth: '1958-11-02' }),
    obrien: person({ givenNames: 'Patrick', familyName: "O'Brien", dateOfBirth: '1949-08-30' }),
    teuila: person({ givenNames: 'Teuila', phones: [{ type: 'mobile', number: '+61400111222' }] }),
    zhang: person({
      givenNames: 'Wei',
      familyName: 'Zhang',
      emails: [{ type: 'personal', address: 'wei.z@example.test' }],
    }),
    harbour: person({ kind: 'organisation', orgName: 'Harbour Trustees Pty Ltd', abn: '51824753556' }),
    macdonald: person({ givenNames: 'Catherine', familyName: 'MacDonald', dateOfBirth: '1937-02-14' }),
    papadopoulos: person({ givenNames: 'Georgios', familyName: 'Papadopoulos', dateOfBirth: '1945-09-09' }),
    singh: person({ givenNames: 'Harpreet', familyName: 'Singh', phones: [{ type: 'home', number: '+61298765432' }] }),
    whitfield: person({ givenNames: 'Robert', familyName: 'Whitfield', dateOfBirth: '1952-04-21' }),
  } satisfies Record<string, DuplicateCandidate>;
  type StoredId = keyof typeof stored;
  const nearDuplicates: [StoredId, DuplicateProbe][] = [
    ['ellis', { givenNames: 'Margaret', familyName: 'Elis', dateOfBirth: '1941-05-17' }],
    ['nguyen', { givenNames: 'Mai', familyName: 'Nguyen', dateOfBirth: '1958-11-02' }],
    ['obrien', { givenNames: 'Patrick', familyName: 'OBrien', dateOfBirth: '1949-08-03' }],
    ['teuila', { givenNames: 'Teuila', phones: ['0400 111 222'] }],
    ['zhang', { givenNames: 'Zhang', familyName: 'Wei', emails: ['Wei.Z@example.test'] }],
    ['harbour', { kind: 'organisation', orgName: 'Harbour Trustees', abn: '51 824 753 556' }],
    ['macdonald', { givenNames: 'Catherine', familyName: 'McDonald', dateOfBirth: '1937-02-14' }],
    ['papadopoulos', { givenNames: 'George', familyName: 'Papadopoulos', dateOfBirth: '1945-09-09' }],
    ['singh', { givenNames: 'Harpreet', familyName: 'Singh', phones: ['(02) 9876 5432'] }],
    // Two digits of the date of birth typed the wrong way round.
    ['whitfield', { givenNames: 'Robert', familyName: 'Whitfeld', dateOfBirth: '1952-04-12' }],
  ];
  const lookalikes: DuplicateProbe[] = [
    { givenNames: 'Margaret', familyName: 'Ellison', dateOfBirth: '1970-01-01' },
    { givenNames: 'Thomas', familyName: 'Nguyen', dateOfBirth: '1990-06-15' },
    { givenNames: 'Patricia', familyName: "O'Brien", dateOfBirth: '1975-03-03' },
    { givenNames: 'Robert', familyName: 'Whitfield', dateOfBirth: '1984-10-10' },
    { kind: 'organisation', orgName: 'Harbour Legal Pty Ltd' },
  ];

  it('finds at least 9 of the 10 seeded near-duplicates', () => {
    const found = nearDuplicates.filter(
      ([id, probe]) => scoreDuplicate(probe, stored[id]).score >= DUPLICATE_THRESHOLD,
    );
    expect(found.length).toBeGreaterThanOrEqual(9);
  });

  it('offers at most one false positive across the look-alikes', () => {
    const offered = lookalikes.flatMap((probe) =>
      Object.entries(stored)
        .filter(([, contact]) => scoreDuplicate(probe, contact).score >= DUPLICATE_THRESHOLD)
        .map(([id]) => `${JSON.stringify(probe)} → ${id}`),
    );
    expect(offered.length).toBeLessThanOrEqual(1);
  });

  it('says why: name, date of birth, email, phone, ABN', () => {
    const probe = (id: StoredId) => nearDuplicates.find(([key]) => key === id)?.[1] ?? {};
    expect(scoreDuplicate(probe('ellis'), stored.ellis).reasons).toEqual(['name', 'dateOfBirth']);
    expect(scoreDuplicate(probe('zhang'), stored.zhang).reasons).toEqual(['name', 'email']);
    expect(scoreDuplicate(probe('harbour'), stored.harbour).reasons).toEqual(['name', 'abn']);
  });
});

describe('MergeContactsInput', () => {
  it('refuses merging a contact into itself', () => {
    const requestId = '00000000-0000-4000-8000-000000000000';
    expect(MergeContactsInput.safeParse({ requestId, keepId: 'a', mergeId: 'a' }).success).toBe(false);
    expect(MergeContactsInput.safeParse({ requestId, keepId: 'a', mergeId: 'b' }).success).toBe(true);
  });
});
