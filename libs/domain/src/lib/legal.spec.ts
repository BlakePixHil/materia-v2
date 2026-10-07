import { AcceptTermsInput, LEGAL_DOCUMENTS, legalDocument } from './legal';
import { CreateOrgInput } from './orgs';
import { Org } from './schemas/tenancy';
import { TERMS_STATUS, TERMS_VERSION, termsAcceptanceNeeded, termsAskedIn } from './terms';
import { isDateOnly } from './values/date-only';

describe('the legal documents registry (SEC-01)', () => {
  it('publishes every SEC-01 document once, in index order', () => {
    const keys = LEGAL_DOCUMENTS.map((doc) => doc.key);
    expect(keys).toEqual([
      'privacy',
      'collection-notice',
      'terms',
      'dpa',
      'subprocessors',
      'retention',
      'accessibility',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives each a title, summary, version, effective date, status and source', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.title).not.toBe('');
      expect(doc.summary).not.toBe('');
      expect(doc.version).toMatch(/^\d+\.\d+$/);
      expect(isDateOnly(doc.effectiveDate)).toBe(true);
      expect(['draft', 'final']).toContain(doc.status);
      expect(doc.source).toMatch(/^docs\/compliance\/[a-z-]+\.md$/);
    }
  });

  it('versions the terms and the DPA together, as the version owners accept', () => {
    expect(legalDocument('terms')?.version).toBe(TERMS_VERSION);
    expect(legalDocument('dpa')?.version).toBe(TERMS_VERSION);
    expect(legalDocument('terms')?.status).toBe(TERMS_STATUS);
  });

  it('asks owners to accept draft terms only outside prod, and signed-off terms everywhere', () => {
    for (const env of ['local', 'e2e', 'dev']) {
      expect(termsAskedIn(env, 'draft')).toBe(true);
      expect(termsAskedIn(env, 'final')).toBe(true);
    }
    expect(termsAskedIn('prod', 'draft')).toBe(false);
    expect(termsAskedIn('prod', 'final')).toBe(true);
  });

  it('finds a document by its path, and nothing for an unknown one', () => {
    expect(legalDocument('privacy')?.title).toBe('Privacy policy');
    expect(legalDocument('accessibility-statement')).toBeUndefined();
    expect(legalDocument('')).toBeUndefined();
  });
});

describe('terms acceptance (SEC-01)', () => {
  it('asks owners until their org has accepted the current version', () => {
    expect(termsAcceptanceNeeded('owner', undefined)).toBe(true);
    expect(termsAcceptanceNeeded('owner', null)).toBe(true);
    expect(termsAcceptanceNeeded('owner', '0.0')).toBe(true);
    expect(termsAcceptanceNeeded('owner', TERMS_VERSION)).toBe(false);
  });

  it('never blocks anyone else', () => {
    for (const role of ['admin', 'lawyer', 'paralegal', 'readonly'] as const)
      expect(termsAcceptanceNeeded(role, undefined)).toBe(false);
    expect(termsAcceptanceNeeded(null, undefined)).toBe(false);
    expect(termsAcceptanceNeeded(undefined, undefined)).toBe(false);
  });

  it('takes the version the page showed, with a request id', () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    expect(AcceptTermsInput.parse({ requestId, version: ` ${TERMS_VERSION} ` }).version).toBe(TERMS_VERSION);
    expect(AcceptTermsInput.safeParse({ requestId, version: '' }).success).toBe(false);
    expect(AcceptTermsInput.safeParse({ version: TERMS_VERSION }).success).toBe(false);
  });

  it('records the acceptance on the org, where only the server writes it', () => {
    expect(Org.schema.shape.termsAcceptedVersion.safeParse(TERMS_VERSION).success).toBe(true);
    expect(Org.schema.shape.termsAcceptedAt.safeParse(new Date()).success).toBe(true);
    expect(Org.schema.shape.termsAcceptedBy.safeParse('user-priya').success).toBe(true);
    for (const field of ['termsAcceptedVersion', 'termsAcceptedAt', 'termsAcceptedBy'])
      expect(Object.keys(Org.update.shape)).not.toContain(field);
  });

  it('lets onboarding accept the terms with the new org', () => {
    const base = {
      requestId: '00000000-0000-4000-8000-000000000002',
      name: 'Fictional Legal',
      primaryJurisdiction: 'VIC',
    };
    expect(CreateOrgInput.parse(base).acceptTermsVersion).toBeUndefined();
    expect(CreateOrgInput.parse({ ...base, acceptTermsVersion: TERMS_VERSION }).acceptTermsVersion).toBe(TERMS_VERSION);
  });
});
