import { resolveJob, runJob } from './main';

describe('resolveJob', () => {
  it('accepts known jobs and rejects anything else', () => {
    expect(resolveJob('pdf')).toBe('pdf');
    expect(resolveJob('court-book')).toBe('court-book');
    expect(resolveJob('nope')).toBeNull();
    expect(resolveJob(undefined)).toBeNull();
  });
});

describe('runJob', () => {
  it('returns 1 for an unknown job and 2 for a known but unimplemented job', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runJob('nope')).toBe(1);
    expect(runJob('ocr')).toBe(2);
    error.mockRestore();
  });
});
