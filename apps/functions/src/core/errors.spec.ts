import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';

import { DomainError } from '@materia/domain';

import { fieldErrors, toHttpsError } from './errors';
import { createLog } from './log';

const logged: Record<string, unknown>[] = [];
const log = createLog({ fn: 'test' }, (_s, _m, e) => logged.push(e));

describe('toHttpsError', () => {
  it('maps a DomainError to its status with details.code', () => {
    const error = toHttpsError(new DomainError('FAILED_PRECONDITION', 'Matter is closed', { matterId: 'm1' }), log);
    expect(error).toBeInstanceOf(HttpsError);
    expect(error.code).toBe('failed-precondition');
    expect(error.message).toBe('Matter is closed');
    expect(error.details).toEqual({ matterId: 'm1', code: 'FAILED_PRECONDITION' });
  });

  it('maps zod errors to INVALID_ARGUMENT with field paths', () => {
    const result = z
      .object({ lines: z.array(z.object({ amountCents: z.number().int() })) })
      .safeParse({ lines: [{ amountCents: 1.5 }] });
    if (result.success) throw new Error('expected failure');
    const error = toHttpsError(result.error, log);
    expect(error.code).toBe('invalid-argument');
    expect((error.details as { fields: Record<string, string[]> }).fields).toHaveProperty(['lines.0.amountCents']);
    expect(fieldErrors(result.error)['lines.0.amountCents']?.length).toBe(1);
  });

  it('passes HttpsErrors through', () => {
    const original = new HttpsError('not-found', 'nope');
    expect(toHttpsError(original, log)).toBe(original);
  });

  it('turns anything else into a bare INTERNAL error and logs it without the message', () => {
    logged.length = 0;
    const error = toHttpsError(new Error('Failure for Margaret Whitfield'), log);
    expect(error.code).toBe('internal');
    expect(error.message).toBe('Internal error');
    expect(error.details).toEqual({ code: 'INTERNAL' });
    expect(JSON.stringify(logged)).not.toContain('Whitfield');
    expect(logged[0]).toMatchObject({ errorType: 'Error' });
    expect(toHttpsError('a string', log).code).toBe('internal');
  });
});
