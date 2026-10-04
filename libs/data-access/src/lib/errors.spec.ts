import { z } from 'zod';

import { DomainError } from '@materia/domain';

import { isTransient, toDomainError } from './errors';

describe('toDomainError', () => {
  it('keeps a DomainError and reads a callable error’s details.code', () => {
    const error = new DomainError('NOT_FOUND');
    expect(toDomainError(error)).toBe(error);
    const mapped = toDomainError(
      { code: 'functions/failed-precondition', message: 'stale', details: { code: 'ORG_CLAIM_MISMATCH' } },
      'callable',
    );
    expect(mapped.code).toBe('ORG_CLAIM_MISMATCH');
    expect((mapped as { cause?: unknown }).cause).toBeDefined();
  });

  it('maps SDK statuses; a refused read means access was revoked, a refused write is a permission error', () => {
    expect(toDomainError({ code: 'permission-denied' }, 'read').code).toBe('ACCESS_REVOKED');
    expect(toDomainError({ code: 'permission-denied' }, 'write').code).toBe('PERMISSION_DENIED');
    expect(toDomainError({ code: 'functions/permission-denied' }, 'callable').code).toBe('PERMISSION_DENIED');
    expect(toDomainError({ code: 'firestore/unavailable' }).code).toBe('UNAVAILABLE');
    expect(toDomainError({ code: 'functions/deadline-exceeded' }, 'callable').code).toBe('UNAVAILABLE');
    expect(toDomainError({ code: 'aborted' }, 'write').code).toBe('CONFLICT');
    expect(toDomainError(new Error('boom')).code).toBe('INTERNAL');
    expect(toDomainError(null).code).toBe('INTERNAL');
  });

  it('turns a schema failure into INVALID_ARGUMENT with field errors', () => {
    const result = z.object({ name: z.string().min(1) }).safeParse({ name: '' });
    const error = toDomainError(result.error, 'write');
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(Object.keys(error.details?.fields ?? {})).toEqual(['name']);
  });

  it('treats only UNAVAILABLE and REQUEST_IN_PROGRESS as transient', () => {
    expect(isTransient(new DomainError('UNAVAILABLE'))).toBe(true);
    expect(isTransient(new DomainError('REQUEST_IN_PROGRESS'))).toBe(true);
    expect(isTransient(new DomainError('PERMISSION_DENIED'))).toBe(false);
  });
});
