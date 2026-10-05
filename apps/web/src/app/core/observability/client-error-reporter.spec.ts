import type { LogClientErrorInput } from '@materia/domain';

import { clientErrorReporter } from './client-error-reporter';

describe('clientErrorReporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(send = vi.fn(async (input: LogClientErrorInput) => void input)) {
    let now = Date.parse('2026-10-05T10:00:00Z');
    const report = clientErrorReporter({
      send,
      version: '1.2.0+abc1234',
      now: () => now,
      route: () => '/matters/m-1',
      userAgent: 'test-agent',
      sessionId: 'session-1',
    });
    return { report, send, advance: (ms: number) => (now += ms) };
  }

  it('batches errors into one call after a short wait', async () => {
    const { report, send } = setup();
    report(new TypeError('a'));
    report('plain string');
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]?.[0];
    expect(input?.sessionId).toBe('session-1');
    expect(input?.errors).toEqual([
      expect.objectContaining({
        message: 'TypeError: a',
        route: '/matters/m-1',
        version: '1.2.0+abc1234',
        userAgent: 'test-agent',
      }),
      { message: 'plain string', route: '/matters/m-1', version: '1.2.0+abc1234', userAgent: 'test-agent' },
    ]);
    expect(input?.errors[0]?.stack).toContain('TypeError: a');
  });

  it('reports at most 20 errors a minute per session', async () => {
    const { report, send, advance } = setup();
    for (let i = 0; i < 30; i++) report(new Error(`e${i}`));
    await vi.advanceTimersByTimeAsync(2000);
    expect(send.mock.calls[0]?.[0].errors).toHaveLength(20);
    advance(60_000);
    report(new Error('next minute'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(send.mock.calls[1]?.[0].errors).toHaveLength(1);
  });

  it('swallows a failed send', async () => {
    const { report } = setup(vi.fn(async () => Promise.reject(new Error('offline'))));
    report(new Error('x'));
    await expect(vi.advanceTimersByTimeAsync(2000)).resolves.toBeDefined();
  });
});
