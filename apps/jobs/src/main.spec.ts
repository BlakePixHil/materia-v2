import { resolveJob } from './main';

describe('resolveJob', () => {
  it('accepts known jobs and rejects anything else', () => {
    expect(resolveJob('pdf')).toBe('pdf');
    expect(resolveJob('court-book')).toBe('court-book');
    expect(resolveJob('nope')).toBeNull();
    expect(resolveJob(undefined)).toBeNull();
  });
});
