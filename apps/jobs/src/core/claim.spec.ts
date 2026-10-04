import { decideClaim, STALE_AFTER_MS } from './claim';
import { jobDoc } from '../testing';

const now = new Date('2026-10-04T10:00:00Z');

describe('decideClaim', () => {
  it('claims a queued job and counts the attempt', () => {
    const result = decideClaim(jobDoc(), now);
    expect(result).toMatchObject({
      kind: 'claimed',
      job: { status: 'running', attempts: 1, startedAt: now, heartbeatAt: now },
    });
  });

  it('exits on a duplicate dispatch of a job that already succeeded', () => {
    expect(decideClaim(jobDoc({ status: 'succeeded' }), now)).toEqual({ kind: 'skip', reason: 'succeeded' });
  });

  it('leaves a running job alone while its heartbeat is fresh, and takes it over once stale', () => {
    const fresh = new Date(now.getTime() - 10_000);
    const stale = new Date(now.getTime() - STALE_AFTER_MS - 1);
    expect(decideClaim(jobDoc({ status: 'running', heartbeatAt: fresh, attempts: 1 }), now)).toEqual({
      kind: 'skip',
      reason: 'running',
    });
    expect(decideClaim(jobDoc({ status: 'running', heartbeatAt: stale, attempts: 1 }), now)).toMatchObject({
      kind: 'claimed',
      job: { attempts: 2 },
    });
  });

  it('retries a retryable failure only', () => {
    const timeout = { code: 'JOB_TIMEOUT', message: 'timeout', retryable: true };
    const encrypted = { code: 'PDF_ENCRYPTED', message: 'password', retryable: false };
    expect(decideClaim(jobDoc({ status: 'failed', error: timeout, attempts: 1 }), now)).toMatchObject({
      kind: 'claimed',
      job: { error: undefined },
    });
    expect(decideClaim(jobDoc({ status: 'failed', error: encrypted, attempts: 1 }), now)).toEqual({
      kind: 'skip',
      reason: 'failed',
    });
  });

  it('rejects a document that is not a job', () => {
    expect(() => decideClaim({ status: 'queued' }, now)).toThrow();
  });
});
