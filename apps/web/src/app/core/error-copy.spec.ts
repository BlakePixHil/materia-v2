import { ERROR_CODES } from '@materia/domain';

import { ERROR_COPY, errorCodeOf, errorCopy, shouldRefreshTokenAndRetry } from './error-copy';

describe('error copy', () => {
  it('has copy for every error code', () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual(Object.keys(ERROR_CODES).sort());
    for (const text of Object.values(ERROR_COPY)) expect(text.length).toBeGreaterThan(10);
  });

  it('reads the code from a callable error and never shows the server message', () => {
    const error = {
      code: 'functions/permission-denied',
      message: 'Role readonly cannot call system-echo',
      details: { code: 'PERMISSION_DENIED' },
    };
    expect(errorCodeOf(error)).toBe('PERMISSION_DENIED');
    expect(errorCopy(error)).toBe(ERROR_COPY.PERMISSION_DENIED);
    expect(errorCopy(error)).not.toContain('system-echo');
  });

  it('falls back to INTERNAL for unknown errors', () => {
    expect(errorCodeOf(new Error('boom'))).toBe('INTERNAL');
    expect(errorCodeOf(null)).toBe('INTERNAL');
    expect(errorCodeOf({ details: { code: 'MADE_UP' } })).toBe('INTERNAL');
  });

  it('flags a stale org claim for a token refresh and one retry', () => {
    expect(shouldRefreshTokenAndRetry({ details: { code: 'ORG_CLAIM_MISMATCH' } })).toBe(true);
    expect(shouldRefreshTokenAndRetry({ details: { code: 'PERMISSION_DENIED' } })).toBe(false);
  });
});
