import { CLERK_MODEL } from './model';

describe('clerk model', () => {
  it('uses Claude Opus 5.5', () => {
    expect(CLERK_MODEL).toBe('claude-opus-5-5');
  });
});
