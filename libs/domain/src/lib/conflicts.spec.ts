import {
  adversePair,
  conflictAllowsOpening,
  DetermineConflictInput,
  hasAdverseHit,
  RunConflictCheckInput,
  subjectProbe,
  type ConflictHit,
} from './conflicts';
import { scoreDuplicate, DUPLICATE_THRESHOLD } from './contacts';

const requestId = '00000000-0000-4000-8000-000000000000';

describe('conflict subjects', () => {
  it('splits a person into given and family names and keeps organisations whole', () => {
    expect(subjectProbe({ name: 'Margaret Anne Ellis', role: 'client', dob: '1941-05-17' })).toMatchObject({
      kind: 'person',
      givenNames: 'Margaret Anne',
      familyName: 'Ellis',
      dateOfBirth: '1941-05-17',
    });
    expect(subjectProbe({ name: 'Teuila', role: 'executor' })).toMatchObject({ givenNames: 'Teuila' });
    expect(subjectProbe({ name: 'Harbour Trustees', role: 'executor', abn: '51 824 753 556' })).toMatchObject({
      kind: 'organisation',
      orgName: 'Harbour Trustees',
      abn: '51824753556',
    });
  });

  it('scores a subject against a stored contact with the duplicate scorer', () => {
    const probe = subjectProbe({ name: 'Patrick OBrien', role: 'beneficiary', dob: '1949-08-30' });
    const score = scoreDuplicate(probe, {
      kind: 'person',
      givenNames: 'Patrick',
      familyName: "O'Brien",
      dateOfBirth: '1949-08-30',
      emails: [],
      phones: [],
    } as never);
    expect(score.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });
});

describe('adverse roles', () => {
  it.each([
    ['client', 'defendant', undefined, true],
    ['defendant', 'client', undefined, true],
    ['executor', 'plaintiff', 'fp', true],
    ['executor', 'plaintiff', 'probate', false],
    ['beneficiary', 'plaintiff', 'will', true],
    ['executor', 'beneficiary', 'probate', false],
    ['client', 'client', 'will', false],
  ] as const)('%s against %s on a %s matter → %s', (subject, existing, type, adverse) => {
    expect(!!adversePair(subject, existing, type)).toBe(adverse);
  });

  it('spots an adverse hit', () => {
    const hit = (adverse?: string): ConflictHit => ({
      subject: 0,
      contactId: 'c1',
      displayName: 'Ada Quill',
      score: 0.9,
      reasons: ['name'],
      matters: [{ matterId: 'm1', number: 'M-1', title: 'x', status: 'open', type: 'fp', role: 'plaintiff', adverse }],
    });
    expect(hasAdverseHit([hit()])).toBe(false);
    expect(hasAdverseHit([hit(), hit('Executor against a family provision plaintiff')])).toBe(true);
  });
});

describe('determinations', () => {
  it('lets clear and potential open a matter, never pending or conflict', () => {
    expect(conflictAllowsOpening('clear')).toBe(true);
    expect(conflictAllowsOpening('potential')).toBe(true);
    expect(conflictAllowsOpening('conflict')).toBe(false);
    expect(conflictAllowsOpening('pending')).toBe(false);
    expect(conflictAllowsOpening(undefined)).toBe(false);
  });

  it('needs a reason for potential and conflict, and rejects pending', () => {
    const base = { requestId, checkId: 'k1', matterId: 'm1' };
    expect(DetermineConflictInput.safeParse({ ...base, status: 'clear' }).success).toBe(true);
    expect(DetermineConflictInput.safeParse({ ...base, status: 'potential' }).success).toBe(false);
    expect(
      DetermineConflictInput.safeParse({ ...base, status: 'potential', reason: 'Waived: unrelated' }).success,
    ).toBe(true);
    expect(DetermineConflictInput.safeParse({ ...base, status: 'conflict', reason: '  ' }).success).toBe(false);
    expect(DetermineConflictInput.safeParse({ ...base, status: 'pending' }).success).toBe(false);
  });

  it('runs on 1 to 20 subjects', () => {
    expect(RunConflictCheckInput.safeParse({ requestId, subjects: [] }).success).toBe(false);
    expect(RunConflictCheckInput.safeParse({ requestId, subjects: [{ name: 'Ada', role: 'client' }] }).success).toBe(
      true,
    );
  });
});
