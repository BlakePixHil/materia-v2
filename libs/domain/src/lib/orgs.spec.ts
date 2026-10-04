import {
  AcceptInviteInput,
  CLAIMS_MAX_BYTES,
  CLAIMS_MAX_ORGS,
  claimsBytes,
  computeClaims,
  CreateOrgInput,
  InviteMemberInput,
  pickActiveOrg,
  type MembershipRole,
} from './orgs';

const requestId = '6f1c2f9e-3c1b-4f3e-9a51-2b7f0c8d9e10';
const membership = (i: number, role: MembershipRole['role'] = 'lawyer'): MembershipRole => ({
  orgId: `org-${i}`,
  role,
  name: `Fictional Practice ${i}`,
});

describe('computeClaims', () => {
  it('takes orgId, role and orgName from the active org and maps every membership', () => {
    const claims = computeClaims([membership(1, 'owner'), membership(2, 'paralegal')], 'org-2');
    expect(claims).toEqual({
      orgId: 'org-2',
      role: 'paralegal',
      orgName: 'Fictional Practice 2',
      orgs: { 'org-1': 'owner', 'org-2': 'paralegal' },
    });
  });

  it('is empty without an active membership', () => {
    expect(computeClaims([], null)).toEqual({});
    expect(computeClaims([membership(1)], 'org-9')).toEqual({});
  });

  it(`keeps only the active org in orgs beyond ${CLAIMS_MAX_ORGS} memberships`, () => {
    const many = Array.from({ length: CLAIMS_MAX_ORGS + 1 }, (_, i) => membership(i));
    const claims = computeClaims(many, 'org-5');
    expect(claims.orgs).toEqual({ 'org-5': 'lawyer' });
    expect(claimsBytes(claims)).toBeLessThan(CLAIMS_MAX_BYTES);
  });

  it('stays under 1000 bytes with 20 orgs with long ids and a long name', () => {
    const many = Array.from({ length: CLAIMS_MAX_ORGS }, (_, i) => ({
      orgId: `${'x'.repeat(40)}-${i}`,
      role: 'paralegal' as const,
      name: 'N'.repeat(200),
    }));
    const claims = computeClaims(many, many[0]?.orgId ?? null);
    expect(claims.orgName).toHaveLength(60);
    expect(claimsBytes(claims)).toBeLessThan(CLAIMS_MAX_BYTES);
  });
});

describe('pickActiveOrg', () => {
  it('keeps the preferred org while it is active, else the first', () => {
    expect(pickActiveOrg([membership(1), membership(2)], 'org-2')).toBe('org-2');
    expect(pickActiveOrg([membership(1), membership(2)], 'org-3')).toBe('org-1');
    expect(pickActiveOrg([], 'org-1')).toBeNull();
  });
});

describe('inputs', () => {
  it('normalises invite emails and ABNs', () => {
    expect(InviteMemberInput.parse({ requestId, email: ' New.Person@Example.TEST ', role: 'lawyer' }).email).toBe(
      'new.person@example.test',
    );
    const org = CreateOrgInput.parse({
      requestId,
      name: 'Fictional Legal',
      abn: '00 000 000 001',
      primaryJurisdiction: 'VIC',
    });
    expect(org).toMatchObject({ abn: '00000000001', timezone: 'Australia/Melbourne' });
    expect(CreateOrgInput.safeParse({ requestId, name: 'X', abn: '123', primaryJurisdiction: 'VIC' }).success).toBe(
      false,
    );
  });

  it('requires a long token to accept an invite', () => {
    expect(AcceptInviteInput.safeParse({ requestId, inviteId: 'i1', token: 'short' }).success).toBe(false);
  });
});
