import * as D from '@materia/domain';

import {
  billToTarget,
  DEMO_EMAILS,
  demoAccounts,
  demoDocs,
  DemoGuardError,
  generatePassword,
  main,
  parseDemoArgs,
  resolveDemoTarget,
} from './demo-reset.ts';
import { buildDataset, type FixtureName, SEED_ORG_ID } from './seed/dataset.ts';
import { FIXTURE_NAMES, fixtureInfo } from './seed/pdfs.ts';

const EMULATOR_ENV = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
};

describe('demo-reset guard', () => {
  it('targets dev and its files bucket, never with emulator hosts set', () => {
    expect(resolveDemoTarget('materia-v2-dev', {})).toEqual({
      kind: 'dev',
      projectId: 'materia-v2-dev',
      bucket: 'materia-v2-dev-files',
      authHost: null,
    });
    expect(() => resolveDemoTarget('materia-v2-dev', EMULATOR_ENV)).toThrow(DemoGuardError);
  });

  it('targets a demo- project only in the emulators', () => {
    expect(resolveDemoTarget('demo-materia', EMULATOR_ENV)).toMatchObject({
      kind: 'emulator',
      bucket: 'demo-materia.appspot.com',
      authHost: '127.0.0.1:9099',
    });
    expect(() => resolveDemoTarget('demo-materia', {})).toThrow(/needs FIRESTORE_EMULATOR_HOST/);
  });

  it('refuses prod and every other project, and a missing one', () => {
    for (const project of ['materia-v2-prod', 'materia-v2-admin', 'matt-r-1fe15', 'dev'])
      expect(() => resolveDemoTarget(project, EMULATOR_ENV)).toThrow(/Refusing project/);
    expect(() => resolveDemoTarget(undefined, {})).toThrow(/Pass --project/);
  });

  it('bills Google API calls on dev to dev, not to terraform-agent’s admin project', () => {
    const env: NodeJS.ProcessEnv = { GOOGLE_CLOUD_PROJECT: 'materia-v2-admin' };
    billToTarget(resolveDemoTarget('materia-v2-dev', env), env);
    expect(env['GOOGLE_CLOUD_QUOTA_PROJECT']).toBe('materia-v2-dev');
    const emulator: NodeJS.ProcessEnv = { ...EMULATOR_ENV };
    billToTarget(resolveDemoTarget('demo-materia', emulator), emulator);
    expect(emulator['GOOGLE_CLOUD_QUOTA_PROJECT']).toBeUndefined();
  });

  it('stops main() before touching anything when the guard fails', async () => {
    await expect(main(['--project', 'materia-v2-prod'])).rejects.toThrow(DemoGuardError);
  });
});

describe('demo-reset arguments', () => {
  it('parses the modes', () => {
    expect(parseDemoArgs(['--project', 'materia-v2-dev', '--dry-run'])).toEqual({
      project: 'materia-v2-dev',
      dryRun: true,
      verify: false,
      remove: false,
    });
    expect(parseDemoArgs(['--project=demo-x', '--remove'])).toMatchObject({ remove: true, dryRun: false });
    expect(() => parseDemoArgs(['--verify', '--remove'])).toThrow(/not both/);
    expect(() => parseDemoArgs(['--apply'])).toThrow();
  });
});

describe('demo-reset documents', () => {
  const fixtures = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, fixtureInfo(name)])) as Record<
    FixtureName,
    ReturnType<typeof fixtureInfo>
  >;
  const now = new Date('2026-10-07T01:00:00Z');
  const dataset = buildDataset({ scenario: 'demo', anchor: D.dateOnly('2026-10-07'), fixtures, now });
  const docs = demoDocs(dataset, now);

  it('writes only the demo org and its accounts’ user documents', () => {
    for (const doc of docs) {
      expect(
        doc.path === `orgs/${SEED_ORG_ID}` ||
          doc.path.startsWith(`orgs/${SEED_ORG_ID}/`) ||
          /^users\/user-(priya|jordan|daniel|sam)$/.test(doc.path),
        doc.path,
      ).toBe(true);
    }
    // The global calendars and rule set the local seed adds are left to the deployed data.
    expect(dataset.docs.some((doc) => doc.path.startsWith('calendars/'))).toBe(true);
    expect(docs.some((doc) => doc.path.startsWith('calendars/') || doc.path.startsWith('ruleSets/'))).toBe(false);
  });

  it('signs the accounts in with the demo emails, which never get mail', () => {
    expect(demoAccounts(dataset).map((a) => [a.role, a.email])).toEqual([
      ['owner', 'demo@harbourvine.example'],
      ['lawyer', 'demo.lawyer@harbourvine.example'],
      ['paralegal', 'demo.paralegal@harbourvine.example'],
      ['readonly', 'demo.readonly@harbourvine.example'],
    ]);
    for (const [uid, email] of Object.entries(DEMO_EMAILS)) {
      const user = D.User.schema.parse(docs.find((doc) => doc.path === `users/${uid}`)?.data);
      expect(user.email).toBe(email);
      expect(user.emailDeliverability?.status).toBe('undeliverable');
      const member = docs.find((doc) => doc.path === `orgs/${SEED_ORG_ID}/members/${uid}`)?.data;
      expect(member?.['email']).toBe(email);
    }
  });

  it('makes passwords that meet the policy and are easy to read', () => {
    const passwords = Array.from({ length: 50 }, generatePassword);
    for (const password of passwords) {
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(password).toMatch(/^Vine-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/);
    }
    expect(new Set(passwords).size).toBe(50);
  });
});
