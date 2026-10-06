import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAuthUser, readAuthRecordFile } from './record.ts';

const FIXTURE = `${import.meta.dirname}/../../fixtures/legacy/auth-export.json`;
const UID = 'AlexRiversLegacyUid000000001';

describe('parseAuthUser', () => {
  it('keeps a Google identity with its provider uid and uses the Auth record email', () => {
    const record = parseAuthUser({
      localId: 'u1',
      email: 'auth@example.com',
      emailVerified: true,
      displayName: 'Alex',
      createdAt: '1640995200000',
      lastLoginAt: '1759708800000',
      providerUserInfo: [
        {
          providerId: 'google.com',
          rawId: 'g-1',
          federatedId: 'https://accounts.google.com/g-1',
          email: 'g@example.com',
        },
      ],
      someFieldTheImportIgnores: 1,
    });
    expect(record).toEqual({
      uid: 'u1',
      email: 'auth@example.com',
      emailVerified: true,
      displayName: 'Alex',
      createdAt: '1640995200000',
      disabled: false,
      identities: [{ providerId: 'google.com', rawId: 'g-1', email: 'g@example.com' }],
      password: 'none',
      phoneSignIn: false,
      mfaFactors: 0,
      hasCustomClaims: false,
    });
  });

  it('keeps every provider, and tells a usable hash from a redacted one', () => {
    const both = parseAuthUser({
      localId: 'u2',
      email: 'a@example.com',
      passwordHash: 'aGFzaA==',
      salt: 'c2FsdA==',
      createdAt: 1640995200000,
      providerUserInfo: [
        { providerId: 'password', rawId: 'a@example.com' },
        { providerId: 'google.com', rawId: 'g-2' },
        { providerId: 'microsoft.com', rawId: 'm-2' },
      ],
    });
    expect(both.identities.map((i) => i.providerId)).toEqual(['google.com', 'microsoft.com']);
    expect(both).toMatchObject({ password: 'hash', passwordHash: 'aGFzaA==', passwordSalt: 'c2FsdA==' });
    expect(both.createdAt).toBe('1640995200000');

    const redacted = parseAuthUser({ localId: 'u3', passwordHash: 'UkVEQUNURUQ=', salt: 'c2FsdA==' });
    expect(redacted.password).toBe('unavailable');
    expect(redacted).not.toHaveProperty('passwordHash');
    const providerOnly = parseAuthUser({ localId: 'u4', providerUserInfo: [{ providerId: 'password' }] });
    expect(providerOnly.password).toBe('unavailable');
  });

  it('flags what the import stops for', () => {
    const record = parseAuthUser({
      localId: 'u5',
      disabled: true,
      mfaInfo: [{ phoneInfo: '+61400000000' }],
      providerUserInfo: [{ providerId: 'phone', rawId: '+61400000000' }, { providerId: 'apple.com' }],
      customAttributes: '{"admin":true}',
      tenantId: 't1',
    });
    expect(record).toMatchObject({ disabled: true, mfaFactors: 1, phoneSignIn: true, hasCustomClaims: true });
    expect(record.identities).toEqual([{ providerId: 'apple.com', rawId: '' }]);
    expect(parseAuthUser({ localId: 'u6', customAttributes: '{}' }).hasCustomClaims).toBe(false);
  });

  it('refuses an account without a uid', () => {
    expect(() => parseAuthUser({ email: 'a@example.com' })).toThrow();
  });
});

describe('readAuthRecordFile', () => {
  it('reads the one user from a filtered export', async () => {
    const record = await readAuthRecordFile(FIXTURE, UID);
    expect(record).toMatchObject({ uid: UID, email: 'alex.rivers@example.com', password: 'none' });
    expect(record.identities).toEqual([
      expect.objectContaining({ providerId: 'google.com', rawId: 'fixture-google-sub-alex-rivers' }),
    ]);
  });

  it('reads a bare account object too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-04-'));
    const path = join(dir, 'one.json');
    await writeFile(path, JSON.stringify({ localId: UID }));
    expect((await readAuthRecordFile(path, UID)).uid).toBe(UID);
  });

  it('refuses a full export, and an export of someone else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-04-'));
    const full = join(dir, 'full.json');
    await writeFile(full, JSON.stringify({ users: [{ localId: UID }, { localId: 'other' }] }));
    await expect(readAuthRecordFile(full, UID)).rejects.toThrow(/holds 2 accounts\. Filter the export/);
    await expect(readAuthRecordFile(FIXTURE, 'other')).rejects.toThrow(/holds AlexRiversLegacyUid000000001, not other/);
  });
});
