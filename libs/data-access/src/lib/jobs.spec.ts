import { pollingJobSource, toJobView } from './jobs';

describe('toJobView', () => {
  it('reads a job document with safe defaults', () => {
    expect(toJobView(undefined)).toBeNull();
    expect(toJobView({})).toEqual({ status: 'queued', progress: { done: 0, total: 0 }, warnings: [] });
    expect(
      toJobView({
        status: 'failed',
        progress: { done: 2, total: 5, stage: 'merging' },
        error: { code: 'PDF_ENCRYPTED', message: 'x', retryable: false, inputIndex: 1 },
        warnings: [],
        output: { storagePath: 'orgs/o/exports/j.pdf', pages: 3 },
        input: { secret: 'ignored' },
      }),
    ).toEqual({
      status: 'failed',
      progress: { done: 2, total: 5, stage: 'merging' },
      error: { code: 'PDF_ENCRYPTED', message: 'x', retryable: false, inputIndex: 1 },
      warnings: [],
      output: { storagePath: 'orgs/o/exports/j.pdf', pages: 3 },
    });
  });
});

describe('pollingJobSource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports changes only, and stops polling once the job finishes', async () => {
    const docs = [
      { status: 'queued' },
      { status: 'queued' },
      { status: 'running', progress: { done: 1, total: 2 } },
      { status: 'succeeded' },
    ];
    const read = vi.fn(async () => docs.shift());
    const next = vi.fn();
    pollingJobSource(read, 100).watch('o', 'j', next, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenCalledWith('o', 'j');
    expect(next.mock.calls.map(([job]) => job?.status)).toEqual(['queued', 'running', 'succeeded']);
  });

  it('retries failed reads, reports permission-denied and stops', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'permission-denied' });
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(denied);
    const error = vi.fn();
    pollingJobSource(read, 100).watch('o', 'j', vi.fn(), error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(denied);
  });

  it('stops when unsubscribed', async () => {
    const read = vi.fn(async () => ({ status: 'running' }));
    const next = vi.fn();
    const stop = pollingJobSource(read, 100).watch('o', 'j', next, vi.fn());
    await vi.advanceTimersByTimeAsync(250);
    stop();
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
