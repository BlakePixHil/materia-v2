/**
 * `materia-scripts seed [--scenario=default|minimal|empty] [--minimal] [--if-empty] [--verify]`
 *
 * Wipes the Firebase emulators and loads the fictional Harbour & Vine Legal practice (FND-06):
 * Auth users (one per role, with orgId/role claims), Firestore documents built with the
 * libs/test-utils factories, and fixture PDFs in Storage. Refuses to run unless the emulator host
 * variables are set and the project id starts with `demo-` (see seed/guard.ts).
 *
 * `--verify` reads every document back and validates it against its domain schema, and signs in as
 * each test account to check its claims. CI runs both (`nx run scripts:test-seed`).
 */
import { parseArgs } from 'node:util';

import { type App, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { type DocumentReference, type Firestore, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { z } from 'zod';

import * as domainModule from '@materia/domain';

import {
  buildDataset,
  type FixtureName,
  SEED_ACCOUNTS,
  SEED_ORG_ID,
  SEED_PASSWORD,
  SEED_SCENARIOS,
  type SeedScenario,
  stripUndefined,
} from './seed/dataset.ts';
import { resolveSeedTarget, type SeedTarget } from './seed/guard.ts';
import { unwrap } from './seed/interop.ts';
import { FIXTURE_NAMES, fixtureInfo, readFixture } from './seed/pdfs.ts';

const BATCH_SIZE = 400;

export interface SeedOptions {
  scenario: SeedScenario;
  ifEmpty: boolean;
  verify: boolean;
}

export function parseSeedArgs(argv: string[]): SeedOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: 'string', default: 'default' },
      minimal: { type: 'boolean', default: false },
      'if-empty': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const scenario = (values.minimal ? 'minimal' : values.scenario) as SeedScenario;
  if (!SEED_SCENARIOS.includes(scenario)) {
    throw new Error(`Unknown scenario "${scenario}". Use one of: ${SEED_SCENARIOS.join(', ')}.`);
  }
  return { scenario, ifEmpty: values['if-empty'], verify: values.verify };
}

async function emulatorDelete(url: string): Promise<void> {
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Emulator wipe failed (${response.status}) for ${url}`);
}

/** Clears Firestore, Auth and seeded Storage objects in the emulators. */
async function wipe(target: SeedTarget, bucketName: string, app: App): Promise<void> {
  await emulatorDelete(
    `http://${target.firestoreHost}/emulator/v1/projects/${target.projectId}/databases/(default)/documents`,
  );
  await emulatorDelete(`http://${target.authHost}/emulator/v1/projects/${target.projectId}/accounts`);
  if (target.storageHost) {
    const [files] = await getStorage(app).bucket(bucketName).getFiles({ prefix: 'orgs/' });
    await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
  }
}

async function writeDocs(db: Firestore, docs: { path: string; data: Record<string, unknown> }[]): Promise<void> {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { path, data } of docs.slice(i, i + BATCH_SIZE)) batch.set(db.doc(path), stripUndefined(data));
    await batch.commit();
  }
}

/** Domain entities by document path pattern, for --verify. */
export function entityRegistry(): { pattern: RegExp; name: string; schema: z.ZodType }[] {
  return Object.entries(unwrap(domainModule) as Record<string, unknown>)
    .filter(
      (entry): entry is [string, { path: string; schema: z.ZodType; docId?: string }] =>
        typeof entry[1] === 'object' &&
        entry[1] !== null &&
        'schema' in entry[1] &&
        'path' in entry[1] &&
        typeof (entry[1] as { path: unknown }).path === 'string',
    )
    .map(([name, entity]) => ({
      name,
      schema: entity.schema,
      // A settings document with its own id (`settings/letterhead`) is matched before the others.
      exact: typeof entity.docId === 'string',
      pattern: new RegExp(`^${entity.path.replace(/\{[^}]+\}/g, '[^/]+')}/${entity.docId ?? '[^/]+'}$`),
    }))
    .sort((a, b) => Number(b.exact) - Number(a.exact))
    .map(({ name, schema, pattern }) => ({ name, schema, pattern }));
}

/** Firestore Timestamps back to Dates, as the client converters do (ADR-008). */
export function fromFirestore(value: unknown): unknown {
  if (value && typeof value === 'object') {
    if ('toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
      return (value as { toDate: () => Date }).toDate();
    }
    if (Array.isArray(value)) return value.map(fromFirestore);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromFirestore(v)]));
  }
  return value;
}

async function allDocuments(refs: DocumentReference[]): Promise<{ path: string; data: unknown }[]> {
  const out: { path: string; data: unknown }[] = [];
  for (const ref of refs) {
    const snapshot = await ref.get();
    if (snapshot.exists) out.push({ path: ref.path, data: snapshot.data() });
    for (const collection of await ref.listCollections())
      out.push(...(await allDocuments(await collection.listDocuments())));
  }
  return out;
}

/** Validates every document against its schema and signs in as each account. Returns the doc count. */
async function verify(db: Firestore, target: SeedTarget): Promise<number> {
  const registry = entityRegistry();
  const roots = await db.listCollections();
  const docs = (await Promise.all(roots.map(async (c) => allDocuments(await c.listDocuments())))).flat();
  const problems: string[] = [];
  for (const { path, data } of docs) {
    const entity = registry.find((e) => e.pattern.test(path));
    if (!entity) {
      problems.push(`${path}: no domain schema for this path`);
      continue;
    }
    const result = entity.schema.safeParse(fromFirestore(data));
    if (!result.success)
      problems.push(
        `${path} (${entity.name}): ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
  }
  for (const account of SEED_ACCOUNTS) {
    const response = await fetch(
      `http://${target.authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: account.email, password: SEED_PASSWORD, returnSecureToken: true }),
      },
    );
    const body = (await response.json()) as { idToken?: string };
    const claims = body.idToken
      ? (JSON.parse(Buffer.from(body.idToken.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>)
      : {};
    if (claims['orgId'] !== SEED_ORG_ID || claims['role'] !== account.role) {
      problems.push(
        `${account.email}: sign-in failed or claims are wrong (${JSON.stringify({ orgId: claims['orgId'], role: claims['role'] })})`,
      );
    }
  }
  if (problems.length) throw new Error(`Seed verification failed:\n  ${problems.join('\n  ')}`);
  return docs.length;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseSeedArgs(argv);
  const target = resolveSeedTarget(process.env);
  // Emulators only: skip google-auth's metadata-server probe (and its warning).
  process.env['METADATA_SERVER_DETECTION'] = 'none';
  const bucketName = `${target.projectId}.appspot.com`;
  const app = initializeApp({ projectId: target.projectId, storageBucket: bucketName }, `seed-${Date.now()}`);
  try {
    const db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });

    if (options.verify) {
      const count = await verify(db, target);
      console.log(
        `Seed verified: ${count} documents match their schemas; ${SEED_ACCOUNTS.length} accounts sign in with the right claims.`,
      );
      return;
    }

    if (options.ifEmpty && (await db.doc(`orgs/${SEED_ORG_ID}`).get()).exists) {
      console.log('Emulators already have data; skipping the seed (run `pnpm materia-scripts seed` to reset).');
      return;
    }

    const fixtures = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, fixtureInfo(name)])) as Record<
      FixtureName,
      ReturnType<typeof fixtureInfo>
    >;
    const dataset = buildDataset({
      scenario: options.scenario,
      anchor: unwrap(domainModule).today('Australia/Melbourne'),
      fixtures,
      now: new Date(),
    });

    await wipe(target, bucketName, app);
    const auth = getAuth(app);
    for (const account of dataset.accounts) {
      await auth.createUser({
        uid: account.uid,
        email: account.email,
        password: SEED_PASSWORD,
        displayName: account.displayName,
        emailVerified: true,
      });
      // The claims auth-syncClaims computes from the member documents (FND-17).
      await auth.setCustomUserClaims(account.uid, {
        orgId: SEED_ORG_ID,
        role: account.role,
        orgName: 'Harbour & Vine Legal',
        orgs: { [SEED_ORG_ID]: account.role },
      });
    }
    await writeDocs(db, dataset.docs);
    if (target.storageHost) {
      const bucket = getStorage(app).bucket(bucketName);
      await Promise.all(
        dataset.files.map((file) =>
          bucket
            .file(file.storagePath)
            .save(readFixture(file.fixture), { contentType: 'application/pdf', resumable: false }),
        ),
      );
    } else if (dataset.files.length) {
      console.warn('FIREBASE_STORAGE_EMULATOR_HOST is not set: document records are seeded without their PDFs.');
    }
    console.log(
      `Seeded "${options.scenario}": ${dataset.accounts.length} accounts, ${dataset.docs.length} documents, ${target.storageHost ? dataset.files.length : 0} files. Sign in with the accounts in AGENTS.md (Run locally).`,
    );
  } finally {
    await deleteApp(app);
  }
}
