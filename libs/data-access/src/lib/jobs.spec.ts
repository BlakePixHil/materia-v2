import { toJobView } from './jobs';

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
