import { secretValue } from './secrets';

describe('secretValue', () => {
  it('returns a real value, trimmed', () => {
    expect(secretValue(() => '  fictional-token  ')).toBe('fictional-token');
  });

  it('treats empty values and placeholders as not set', () => {
    for (const value of ['', '   ', 'unset', 'UNSET', 'placeholder', 'none', 'changeme', '-']) {
      expect(secretValue(() => value)).toBe('');
    }
  });

  it('treats a secret that can’t be read as not set', () => {
    expect(
      secretValue(() => {
        throw new Error('not declared for this function');
      }),
    ).toBe('');
    expect(secretValue(() => undefined as unknown as string)).toBe('');
  });
});
