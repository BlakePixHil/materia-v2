import { firebaseScryptHash, parseHashParams, scryptImportOptions } from './hash.ts';

// The worked example in Firebase's scrypt repository (github.com/firebase/scrypt), not a real key,
// so the secret scan is told to let it through.
const EXAMPLE = {
  base64_signer_key: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==', // gitleaks:allow
  base64_salt_separator: 'Bw==',
  rounds: 8,
  mem_cost: 14,
};

describe('the legacy scrypt parameters', () => {
  it('parses the console fields', () => {
    expect(parseHashParams(JSON.stringify(EXAMPLE))).toEqual(EXAMPLE);
  });

  it('never echoes the values when they are wrong', () => {
    expect(() => parseHashParams('{not json')).toThrow('LEGACY_SCRYPT_PARAMS is not JSON.');
    const bad = { ...EXAMPLE, rounds: 99, base64_salt_separator: undefined };
    let message = '';
    try {
      parseHashParams(JSON.stringify(bad));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/bad fields: (rounds, base64_salt_separator|base64_salt_separator, rounds)\./);
    expect(message).not.toContain(EXAMPLE.base64_signer_key);
  });

  it('becomes the Admin SDK scrypt options', () => {
    const { hash } = scryptImportOptions(EXAMPLE);
    expect(hash).toMatchObject({ algorithm: 'SCRYPT', rounds: 8, memoryCost: 14 });
    expect(hash.key?.toString('base64')).toBe(EXAMPLE.base64_signer_key);
    expect(hash.saltSeparator?.toString('base64')).toBe('Bw==');
  });

  it("hashes like Firebase does (the scrypt repository's example)", () => {
    const hash = firebaseScryptHash('user1password', Buffer.from('42xEC+ixf3L2lw==', 'base64'), EXAMPLE);
    expect(hash.toString('base64')).toBe(
      'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
    );
  });
});
