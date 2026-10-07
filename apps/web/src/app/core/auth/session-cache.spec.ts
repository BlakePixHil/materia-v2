import { setFirestoreCacheMode, type SessionSecurity } from '@materia/data-access';
import { resolveSecurity } from '@materia/domain';

import {
  forgetCachedSession,
  readCachedSecurity,
  readCachedSession,
  saveCachedSecurity,
  saveCachedSession,
} from './session-cache';
import { testSession } from './testing';

/** The session and policy kept for a start-up drawn before Auth answers (MAT-177). */

const SECURITY: SessionSecurity = {
  policy: resolveSecurity({
    mfaRequired: true,
    sessionIdleMinutes: 30,
    mfaRequiredSince: new Date('2026-10-01T00:00:00.000Z'),
    mfaEnforceAfter: new Date('2026-10-08T00:00:00.000Z'),
  }),
  validAfter: new Date('2026-09-30T00:00:00.000Z'),
  termsAcceptedVersion: '2026-10',
  deletionScheduledAt: null,
};

describe('session cache', () => {
  afterEach(() => {
    forgetCachedSession();
    setFirestoreCacheMode('persistent');
  });

  it('keeps a session with an org for the next start-up, and forgets one without', () => {
    const session = testSession({ authTime: 1_700_000_000_000 });
    saveCachedSession(session);
    expect(readCachedSession()).toEqual(session);

    saveCachedSession(testSession({ claims: {} }));
    expect(readCachedSession()).toBeNull();
    saveCachedSession(session);
    saveCachedSession(null);
    expect(readCachedSession()).toBeNull();
  });

  it('ignores what it can’t trust', () => {
    localStorage.setItem('materia.session', '{not json');
    expect(readCachedSession()).toBeNull();
    localStorage.setItem('materia.session', JSON.stringify({ ...testSession(), uid: 7 }));
    expect(readCachedSession()).toBeNull();
    localStorage.setItem('materia.session', JSON.stringify({ ...testSession(), authTime: 'yesterday' }));
    expect(readCachedSession()).toBeNull();
  });

  it('keeps a shared-computer sign-in’s in this tab only', () => {
    setFirestoreCacheMode('memory');
    saveCachedSession(testSession({ authTime: 1 }));
    expect(localStorage.getItem('materia.session')).toBeNull();
    expect(readCachedSession()?.uid).toBe('user-jordan');
    forgetCachedSession();
    expect(sessionStorage.getItem('materia.session')).toBeNull();
  });

  it('keeps the org’s security policy, with its dates, for the same member and org only', () => {
    saveCachedSecurity('user-jordan', 'org-harbour-vine', SECURITY);
    expect(readCachedSecurity('user-jordan', 'org-harbour-vine')).toEqual(SECURITY);
    expect(readCachedSecurity('user-jordan', 'org-other')).toBeNull();
    expect(readCachedSecurity('someone-else', 'org-harbour-vine')).toBeNull();

    const broken = { uid: 'user-jordan', orgId: 'org-harbour-vine', security: { ...SECURITY, validAfter: 'soon' } };
    localStorage.setItem('materia.sessionSecurity', JSON.stringify(broken));
    expect(readCachedSecurity('user-jordan', 'org-harbour-vine')).toBeNull();
  });

  it('forgets both on sign-out', () => {
    saveCachedSession(testSession({ authTime: 1 }));
    saveCachedSecurity('user-jordan', 'org-harbour-vine', SECURITY);
    forgetCachedSession();
    expect(readCachedSession()).toBeNull();
    expect(readCachedSecurity('user-jordan', 'org-harbour-vine')).toBeNull();
  });

  it('leaves nothing older behind when storage refuses the write', () => {
    saveCachedSession(testSession({ authTime: 1 }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      saveCachedSession(testSession({ authTime: 2, claims: { orgId: 'org-other', role: 'owner' } }));
    } finally {
      setItem.mockRestore();
    }
    expect(readCachedSession()).toBeNull();
  });
});
