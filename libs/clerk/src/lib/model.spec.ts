import { CLERK_FALLBACKS, CLERK_MODELS, clerkModelFor } from './model';

describe('clerk models', () => {
  it('defaults to Sonnet 5.5 with Opus 5.5 as the opt-in', () => {
    expect(CLERK_MODELS.default).toBe('claude-sonnet-5-5');
    expect(CLERK_MODELS.choices).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('has a fallback chain per primary', () => {
    expect(CLERK_FALLBACKS['claude-sonnet-5-5']).toEqual(['claude-sonnet-5']);
    expect(CLERK_FALLBACKS['claude-opus-5-5']).toEqual(['claude-opus-5', 'claude-sonnet-5-5']);
  });

  it('reads the stored choice, falling back to the default', () => {
    expect(clerkModelFor('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(clerkModelFor(undefined)).toBe('claude-sonnet-5-5');
    expect(clerkModelFor('claude-haiku-4-5')).toBe('claude-sonnet-5-5');
  });
});
