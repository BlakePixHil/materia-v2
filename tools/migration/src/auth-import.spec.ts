import type { UserImportOptions, UserImportRecord } from 'firebase-admin/auth';

import type { HashParams } from './auth/hash.ts';
import type { TargetUser } from './auth/plan.ts';
import { readAuthRecordFile, type LegacyAuthRecord } from './auth/record.ts';
import type { TargetAuth } from './auth/target.ts';
import {
  authImportCommand,
  ImportAbortedError,
  runAuthImport,
  type AuthImportArgs,
  type AuthImportDeps,
} from './auth-import.ts';

const FIXTURE = `${import.meta.dirname}/../fixtures/legacy/auth-export.json`;
const UID = 'AlexRiversLegacyUid000000001';
const PARAMS: HashParams = { base64_signer_key: 'a2V5', base64_salt_separator: 'Bw==', rounds: 8, mem_cost: 14 };

/** An in-memory Identity Platform that keeps what it imports, as the real one does. */
function memoryTarget(seed: TargetUser[] = []) {
  const users = new Map(seed.map((user) => [user.uid, user]));
  const imports: { user: UserImportRecord; options: UserImportOptions | undefined }[] = [];
  const deleted: string[] = [];
  const target: TargetAuth = {
    getUser: async (uid) => users.get(uid) ?? null,
    getUserByEmail: async (email) =>
      [...users.values()].find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null,
    getUserByIdentity: async (providerId, rawId) =>
      [...users.values()].find((u) => u.providers.some((p) => p.providerId === providerId && p.uid === rawId)) ?? null,
    async importUser(user, options) {
      imports.push({ user, options });
      users.set(user.uid, {
        uid: user.uid,
        ...(user.email ? { email: user.email.toLowerCase() } : {}),
        providers: [
          ...(user.providerData ?? []).map((p) => ({ providerId: p.providerId, uid: p.uid })),
          ...(user.passwordHash && user.email ? [{ providerId: 'password', uid: user.email }] : []),
        ],
        hasCustomClaims: false,
      });
    },
    async deleteUser(uid) {
      deleted.push(uid);
      users.delete(uid);
    },
  };
  return { target, users, imports, deleted };
}

const ARGS: AuthImportArgs = {
  uid: UID,
  target: 'materia-v2-dev',
  dryRun: false,
  rollback: false,
  replaceUids: [],
  confirmProd: false,
};

function deps(target: TargetAuth, record: () => Promise<LegacyAuthRecord> = () => readAuthRecordFile(FIXTURE, UID)) {
  const lines: string[] = [];
  const value: AuthImportDeps = {
    record,
    target,
    enabledProviders: async () => new Set(['password', 'google.com']),
    hashParams: async () => PARAMS,
    log: (line) => void lines.push(line),
  };
  return { deps: value, lines };
}

describe('runAuthImport', () => {
  it('plans without writing on a dry run, imports with the same uid, then is a no-op', async () => {
    const memory = memoryTarget();
    const { deps: d, lines } = deps(memory.target);
    expect(await runAuthImport({ ...ARGS, dryRun: true }, d)).toBe('would-import');
    expect(memory.imports).toEqual([]);
    expect(lines.at(-1)).toMatch(
      /^Dry run: would import AlexRiversLegacyUid000000001 into materia-v2-dev with google\.com \(provider uids kept\) and no password\.$/,
    );

    expect(await runAuthImport(ARGS, d)).toBe('imported');
    expect(memory.imports).toHaveLength(1);
    expect(memory.imports[0]?.options).toBeUndefined();
    expect(memory.users.get(UID)?.providers).toEqual([
      { providerId: 'google.com', uid: 'fixture-google-sub-alex-rivers' },
    ]);

    expect(await runAuthImport(ARGS, d)).toBe('skipped');
    expect(memory.imports).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('@');
  });

  it('imports a password hash with the scrypt parameters, and stops without them', async () => {
    const withPassword = async (): Promise<LegacyAuthRecord> => ({
      ...(await readAuthRecordFile(FIXTURE, UID)),
      password: 'hash',
      passwordHash: 'aGFzaA==',
      passwordSalt: 'c2FsdA==',
    });
    const memory = memoryTarget();
    const { deps: d, lines } = deps(memory.target, withPassword);
    await expect(runAuthImport(ARGS, { ...d, hashParams: async () => null })).rejects.toThrow(
      /no LEGACY_SCRYPT_PARAMS secret/,
    );
    expect(await runAuthImport(ARGS, d)).toBe('imported');
    expect(memory.imports[0]?.options?.hash).toMatchObject({ algorithm: 'SCRYPT', rounds: 8, memoryCost: 14 });
    expect(lines.join('\n')).not.toContain('a2V5');
  });

  it('stops for a person on an abort, and deletes a conflicting user only when named', async () => {
    const tester: TargetUser = {
      uid: 'v2-tester',
      email: 'alex.rivers@example.com',
      providers: [{ providerId: 'google.com', uid: 'fixture-google-sub-alex-rivers' }],
      hasCustomClaims: false,
    };
    const memory = memoryTarget([tester]);
    const { deps: d } = deps(memory.target);
    const stopped = runAuthImport(ARGS, d);
    await expect(stopped).rejects.toBeInstanceOf(ImportAbortedError);
    await expect(runAuthImport(ARGS, d)).rejects.toThrow(/--replace-user v2-tester/);
    expect(memory.deleted).toEqual([]);

    expect(await runAuthImport({ ...ARGS, replaceUids: ['v2-tester'], dryRun: true }, d)).toBe('would-import');
    expect(memory.deleted).toEqual([]);
    expect(await runAuthImport({ ...ARGS, replaceUids: ['v2-tester'] }, d)).toBe('imported');
    expect(memory.deleted).toEqual(['v2-tester']);
  });

  it('fails loudly when the imported account does not check out', async () => {
    const memory = memoryTarget();
    const { deps: d } = deps({ ...memory.target, importUser: async () => undefined });
    await expect(runAuthImport(ARGS, d)).rejects.toThrow(/isn't in v2 after the import/);
  });

  it('rolls back a rehearsal import, and in prod only while it has never signed in', async () => {
    const memory = memoryTarget();
    const { deps: d } = deps(memory.target);
    expect(await runAuthImport({ ...ARGS, rollback: true }, d)).toBe('skipped');
    await runAuthImport(ARGS, d);
    expect(await runAuthImport({ ...ARGS, rollback: true, dryRun: true }, d)).toBe('would-roll-back');
    expect(memory.deleted).toEqual([]);
    expect(await runAuthImport({ ...ARGS, rollback: true }, d)).toBe('rolled-back');
    expect(memory.deleted).toEqual([UID]);

    const signIn = () => {
      const user = memory.users.get(UID);
      if (user) user.lastSignInAt = 'Mon, 06 Oct 2026 01:00:00 GMT';
    };
    await runAuthImport(ARGS, d);
    signIn();
    expect(await runAuthImport({ ...ARGS, rollback: true }, d)).toBe('rolled-back');

    const prod = { ...ARGS, target: 'materia-v2-prod', confirmProd: true };
    await runAuthImport(prod, d);
    signIn();
    await expect(runAuthImport({ ...prod, rollback: true }, d)).rejects.toThrow(/would lock the user out/);
    expect(memory.users.has(UID)).toBe(true);
  });

  it('never writes to a legacy project, and needs --confirm-prod to change prod', async () => {
    const memory = memoryTarget();
    const { deps: d } = deps(memory.target);
    await expect(runAuthImport({ ...ARGS, target: 'matt-r-1fe15' }, d)).rejects.toThrow(/legacy project/);
    await expect(runAuthImport({ ...ARGS, target: 'materia-v2-prod' }, d)).rejects.toThrow(/--confirm-prod/);
    expect(await runAuthImport({ ...ARGS, target: 'materia-v2-prod', dryRun: true }, d)).toBe('would-import');
    expect(memory.imports).toEqual([]);
  });

  it('refuses a record for another uid', async () => {
    const memory = memoryTarget();
    const { deps: d } = deps(memory.target);
    await expect(runAuthImport({ ...ARGS, uid: 'someone-else' }, d)).rejects.toThrow(/not someone-else/);
  });
});

describe('authImportCommand', () => {
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);

  it('prints usage, and refuses missing or mismatched targets before connecting', async () => {
    expect(await authImportCommand(['--help'], log, log, {})).toBe(0);
    expect(await authImportCommand(['--uid', UID], log, log, {})).toBe(1);
    lines.length = 0;
    expect(await authImportCommand(['--uid', UID, '--target', 'demo-materia'], log, log, {})).toBe(1);
    expect(lines.at(-1)).toMatch(/only exists on the emulator/);
    const emulator = { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
    expect(await authImportCommand(['--uid', UID, '--target', 'materia-v2-dev'], log, log, emulator)).toBe(1);
    expect(lines.at(-1)).toMatch(/must be a demo- project/);
    expect(await authImportCommand(['--uid', UID, '--target', 'materia-v2-prod'], log, log, {})).toBe(1);
    expect(lines.at(-1)).toMatch(/--confirm-prod/);
    expect(await authImportCommand(['--uid', UID, '--target', 'matt-r-1fe15'], log, log, {})).toBe(1);
    expect(lines.at(-1)).toMatch(/legacy project/);
  });

  it('takes the uid from a mapping profile', async () => {
    lines.length = 0;
    const profile = `${import.meta.dirname}/../fixtures/legacy/mapping-profile.json`;
    expect(await authImportCommand(['--profile', profile, '--target', 'matt-r-1fe15'], log, log, {})).toBe(1);
    expect(lines.at(-1)).toMatch(/legacy project/);
  });
});
