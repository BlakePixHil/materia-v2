import { DomainError, ERROR_CODES, isErrorCode } from './errors';

describe('DomainError', () => {
  it('carries a stable code, its status and details', () => {
    const error = new DomainError('ORG_CLAIM_MISMATCH', 'refresh', { orgId: 'org-a' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('ORG_CLAIM_MISMATCH');
    expect(error.status).toBe('failed-precondition');
    expect(error.details).toEqual({ orgId: 'org-a' });
    expect(new DomainError('NOT_FOUND').message).toBe('NOT_FOUND');
  });

  it('recognises codes', () => {
    expect(isErrorCode('PERMISSION_DENIED')).toBe(true);
    expect(isErrorCode('permission-denied')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(Object.keys(ERROR_CODES)).toContain('REQUEST_IN_PROGRESS');
  });
});
