import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

import { firebaseScryptHash, type HashParams } from '../src/auth/hash.ts';
import { authImportCommand } from '../src/auth-import.ts';

/**
 * MIG-04 against the Auth emulator: `materia-migrate auth-import` end to end, with a made-up
 * Google-only account (like the real subject) and a made-up scrypt password account. The
 * emulator stores hashes without checking them, so the password is proven on dev (runbook); here
 * Google sign-in proves the uid: a Google credential for the imported identity signs in to the
 * imported account, not a new one.
 */

const PROJECT = 'demo-materia';
const HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
const FIXTURE = `${import.meta.dirname}/../fixtures/legacy/auth-export.json`;
const UID = 'AlexRiversLegacyUid000000001';
const GOOGLE_SUB = 'fixture-google-sub-alex-rivers';

// A made-up key for this run, never a real one.
const PARAMS: HashParams = {
  base64_signer_key: randomBytes(64).toString('base64'),
  base64_salt_separator: 'Bw==',
  rounds: 8,
  mem_cost: 14,
};

let app: App;
let auth: Auth;
let lines: string[];
const log = (line: string) => void lines.push(line);

async function migrate(...argv: string[]): Promise<number> {
  return authImportCommand(['--target', PROJECT, ...argv], log, log, {
    ...process.env,
    LEGACY_SCRYPT_PARAMS: JSON.stringify(PARAMS),
  });
}

/** Google sign-in on the emulator, which accepts the id_token's claims as plain JSON. */
async function signInWithGoogle(sub: string, email: string): Promise<{ localId: string; isNewUser?: boolean }> {
  const idToken = JSON.stringify({ sub, email, email_verified: true });
  const res = await fetch(`http://${HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestUri: 'http://localhost',
      postBody: `id_token=${encodeURIComponent(idToken)}&providerId=google.com`,
      returnSecureToken: true,
    }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as { localId: string; isNewUser?: boolean };
}

async function exportFile(user: object): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'mig-04-int-')), 'auth-export.json');
  await writeFile(path, JSON.stringify({ users: [user] }));
  return path;
}

beforeAll(() => {
  if (!HOST) throw new Error('Needs the Auth emulator: run `pnpm nx run migration:test-integration`.');
  app = initializeApp({ projectId: PROJECT }, `mig-04-int-${Date.now()}`);
  auth = getAuth(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  lines = [];
  const res = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  expect(res.ok).toBe(true);
});

describe('auth-import on the Auth emulator', () => {
  it('imports a Google-only account with the same uid, and Google sign-in lands on it', async () => {
    expect(await migrate('--record', FIXTURE, '--uid', UID, '--dry-run')).toBe(0);
    await expect(auth.getUser(UID)).rejects.toMatchObject({ code: 'auth/user-not-found' });

    expect(await migrate('--record', FIXTURE, '--uid', UID)).toBe(0);
    const user = await auth.getUser(UID);
    expect(user).toMatchObject({
      uid: UID,
      email: 'alex.rivers@example.com',
      emailVerified: true,
      displayName: 'Alex Rivers',
    });
    expect(user.providerData.map((p) => ({ providerId: p.providerId, uid: p.uid }))).toEqual([
      { providerId: 'google.com', uid: GOOGLE_SUB },
    ]);
    expect(new Date(user.metadata.creationTime).toISOString()).toBe('2022-01-01T00:00:00.000Z');
    expect(user.metadata.lastSignInTime).toBeFalsy();
    expect(lines.join('\n')).not.toContain('@');

    const signIn = await signInWithGoogle(GOOGLE_SUB, 'alex.rivers@example.com');
    expect(signIn.localId).toBe(UID);
    expect(signIn.isNewUser).toBeFalsy();
  });

  it('is a no-op the second time', async () => {
    expect(await migrate('--record', FIXTURE, '--uid', UID)).toBe(0);
    const before = await auth.getUser(UID);
    lines = [];
    expect(await migrate('--record', FIXTURE, '--uid', UID)).toBe(0);
    expect(lines.at(-1)).toMatch(/same email, so there is nothing to do/);
    expect((await auth.getUser(UID)).toJSON()).toEqual(before.toJSON());
  });

  it('imports a scrypt password with every provider, from a filtered export', async () => {
    const salt = randomBytes(16);
    const passwordHash = firebaseScryptHash('a made-up password', salt, PARAMS).toString('base64');
    const path = await exportFile({
      localId: 'ScryptUserUid',
      email: 'sam.scrypt@example.com',
      emailVerified: false,
      passwordHash,
      salt: salt.toString('base64'),
      createdAt: '1640995200000',
      providerUserInfo: [
        { providerId: 'password', rawId: 'sam.scrypt@example.com', email: 'sam.scrypt@example.com' },
        { providerId: 'google.com', rawId: 'fixture-google-sub-sam', email: 'sam.scrypt@example.com' },
        { providerId: 'microsoft.com', rawId: 'fixture-microsoft-oid-sam' },
      ],
    });
    expect(await migrate('--record', path, '--uid', 'ScryptUserUid')).toBe(0);
    const user = await auth.getUser('ScryptUserUid');
    // The Admin SDK sends bytes as web-safe base64, so compare the bytes.
    expect(Buffer.from(user.passwordHash ?? '', 'base64').toString('base64')).toBe(passwordHash);
    expect(Buffer.from(user.passwordSalt ?? '', 'base64').equals(salt)).toBe(true);
    expect(user.providerData.map((p) => `${p.providerId}:${p.uid}`).sort()).toEqual([
      'google.com:fixture-google-sub-sam',
      'microsoft.com:fixture-microsoft-oid-sam',
      'password:sam.scrypt@example.com',
    ]);
    expect(lines.join('\n')).not.toContain(PARAMS.base64_signer_key);
    expect(lines.join('\n')).not.toContain(passwordHash);
  });

  it('stops for a person on a disabled account, and on a uid that is someone else', async () => {
    const disabled = await exportFile({ localId: 'DisabledUid', email: 'd@example.com', disabled: true });
    expect(await migrate('--record', disabled, '--uid', 'DisabledUid')).toBe(4);
    expect(lines.join('\n')).toMatch(/disabled\. Ask why/);
    await expect(auth.getUser('DisabledUid')).rejects.toMatchObject({ code: 'auth/user-not-found' });

    await auth.createUser({ uid: UID, email: 'someone.else@example.com' });
    expect(await migrate('--record', FIXTURE, '--uid', UID)).toBe(4);
    expect((await auth.getUser(UID)).email).toBe('someone.else@example.com');
  });

  it('replaces a test user holding the same email only when a person names it', async () => {
    await auth.createUser({ uid: 'v2-test-user', email: 'alex.rivers@example.com' });
    expect(await migrate('--record', FIXTURE, '--uid', UID)).toBe(4);
    expect(lines.join('\n')).toMatch(/--replace-user v2-test-user/);
    await expect(auth.getUser(UID)).rejects.toMatchObject({ code: 'auth/user-not-found' });

    expect(await migrate('--record', FIXTURE, '--uid', UID, '--replace-user', 'v2-test-user')).toBe(0);
    await expect(auth.getUser('v2-test-user')).rejects.toMatchObject({ code: 'auth/user-not-found' });
    expect((await auth.getUser(UID)).email).toBe('alex.rivers@example.com');
  });

  it('rolls back a rehearsal import, after a sign-in too', async () => {
    expect(await migrate('--record', FIXTURE, '--uid', UID)).toBe(0);
    expect(await migrate('--record', FIXTURE, '--uid', UID, '--rollback')).toBe(0);
    await expect(auth.getUser(UID)).rejects.toMatchObject({ code: 'auth/user-not-found' });

    expect(await migrate('--record', FIXTURE, '--uid', UID)).toBe(0);
    await signInWithGoogle(GOOGLE_SUB, 'alex.rivers@example.com');
    lines = [];
    expect(await migrate('--record', FIXTURE, '--uid', UID, '--rollback')).toBe(0);
    expect(lines.join('\n')).toMatch(/signed in .* during the rehearsal/);
    await expect(auth.getUser(UID)).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
});
