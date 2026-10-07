/**
 * `materia-scripts seed-large [--scale 0.05] [--keep] [--dry-run] [--concurrency 4]` (SEC-07)
 *
 * Seeds the synthetic large practice (seed/large.ts) into the Firebase emulators: the target firm
 * (50 members, 10,000 matters, 500,000 document records, 2,000,000 time entries) at `--scale`
 * (1 = the target; the default 0.05 is what the perf CI job and the SEC-07 report use). Refuses to
 * run unless the emulator host variables are set and the project id starts with `demo-`, like
 * `seed`: it never touches a real project. Wipes the emulators first, unless `--keep` adds the
 * practice next to what is there (the Harbour & Vine seed, say). `--dry-run` prints the plan only.
 *
 * Run the Firestore and Auth emulators without Functions while seeding (every write would fire
 * the triggers), and export the result for the runs that need Functions:
 *
 *   firebase emulators:exec --only auth,firestore --project demo-materia --config firebase.json \
 *     --export-on-exit=.perf-data "node tools/scripts/bin/materia-scripts.mjs seed-large --scale 0.05"
 *
 * Accounts: `owner@large.example`, `lawyer1@large.example` (the full-load fee earner),
 * `paralegal1@large.example`, `readonly1@large.example` and so on, password `materia-local-dev`.
 * Every name is invented.
 */
import { parseArgs } from 'node:util';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import * as D from '@materia/domain';

import { type SeedDoc } from './seed/dataset.ts';
import { resolveSeedTarget } from './seed/guard.ts';
import { unwrap } from './seed/interop.ts';
import {
  describePlan,
  LARGE_ORG_NAME,
  LARGE_PASSWORD,
  largeOrgDocs,
  planLargeOrg,
  TARGET,
  type LargePlan,
} from './seed/large.ts';

const domain = unwrap(D);
const BATCH_SIZE = 500;

export interface SeedLargeOptions {
  scale: number;
  keep: boolean;
  dryRun: boolean;
  concurrency: number;
}

export function parseSeedLargeArgs(argv: string[]): SeedLargeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      scale: { type: 'string', default: '0.05' },
      keep: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '4' },
    },
    strict: true,
  });
  const scale = Number(values.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new Error('--scale is a number above 0 and at most 1 (1 is the target practice)');
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('--concurrency is a whole number from 1 to 32');
  }
  return { scale, keep: values.keep, dryRun: values['dry-run'], concurrency };
}

/**
 * Writes documents in batches of 500, `concurrency` commits at a time, pulling from the generator
 * as batches free up (so memory stays at a few batches whatever the scale). Returns the count.
 */
export async function writeStream(
  db: Firestore,
  docs: Iterable<SeedDoc>,
  options: { concurrency: number; onProgress?: (written: number) => void },
): Promise<number> {
  const iterator = docs[Symbol.iterator]();
  let written = 0;
  let done = false;
  const nextBatch = (): SeedDoc[] => {
    const batch: SeedDoc[] = [];
    while (!done && batch.length < BATCH_SIZE) {
      const step = iterator.next();
      if (step.done) done = true;
      else batch.push(step.value);
    }
    return batch;
  };
  const worker = async () => {
    for (let batch = nextBatch(); batch.length; batch = nextBatch()) {
      const write = db.batch();
      for (const { path, data } of batch) write.set(db.doc(path), data);
      await write.commit();
      written += batch.length;
      options.onProgress?.(written);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  return written;
}

async function emulatorDelete(url: string): Promise<void> {
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Emulator wipe failed (${response.status}) for ${url}`);
}

async function createAccounts(plan: LargePlan, app: ReturnType<typeof initializeApp>): Promise<void> {
  const auth = getAuth(app);
  for (const account of plan.accounts) {
    await auth.deleteUser(account.uid).catch(() => undefined);
    await auth.createUser({
      uid: account.uid,
      email: account.email,
      password: LARGE_PASSWORD,
      displayName: account.displayName,
      emailVerified: true,
    });
    // The claims auth-syncClaims computes from the member documents (FND-17).
    await auth.setCustomUserClaims(account.uid, {
      orgId: plan.orgId,
      role: account.role,
      orgName: LARGE_ORG_NAME,
      orgs: { [plan.orgId]: account.role },
    });
  }
}

export async function main(argv: string[]): Promise<void> {
  const options = parseSeedLargeArgs(argv);
  const plan = planLargeOrg(options.scale);
  console.log(describePlan(plan));
  if (options.dryRun) {
    console.log(
      `Target (scale 1): ${TARGET.members} members, ${TARGET.matters.toLocaleString('en-AU')} matters, ` +
        `${TARGET.documents.toLocaleString('en-AU')} documents, ${TARGET.timeEntries.toLocaleString('en-AU')} time entries.`,
    );
    return;
  }
  const target = resolveSeedTarget(process.env);
  // Emulators only: skip google-auth's metadata-server probe (and its warning).
  process.env['METADATA_SERVER_DETECTION'] = 'none';
  const app = initializeApp({ projectId: target.projectId }, `seed-large-${Date.now()}`);
  try {
    const db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
    if (!options.keep) {
      await emulatorDelete(
        `http://${target.firestoreHost}/emulator/v1/projects/${target.projectId}/databases/(default)/documents`,
      );
      await emulatorDelete(`http://${target.authHost}/emulator/v1/projects/${target.projectId}/accounts`);
    }
    await createAccounts(plan, app);
    const started = Date.now();
    let reported = 0;
    const written = await writeStream(
      db,
      largeOrgDocs(plan, { now: new Date(), today: domain.today(domain.DEFAULT_ORG_TIMEZONE) }),
      {
        concurrency: options.concurrency,
        onProgress: (count) => {
          if (count - reported < 50_000) return;
          reported = count;
          const seconds = (Date.now() - started) / 1000;
          console.log(`  ${count.toLocaleString('en-AU')} documents (${Math.round(count / seconds)}/s)`);
        },
      },
    );
    const seconds = (Date.now() - started) / 1000;
    console.log(
      `Seeded the large practice: ${plan.accounts.length} accounts, ${written.toLocaleString('en-AU')} documents ` +
        `in ${seconds.toFixed(0)} s (${Math.round(written / seconds)}/s). Sign in as lawyer1@large.example ` +
        `(password ${LARGE_PASSWORD}).`,
    );
  } finally {
    await deleteApp(app);
  }
}
