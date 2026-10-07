/**
 * `materia-scripts demo-reset --project <id> [--dry-run] [--verify | --remove | --pdfs]`
 *
 * Loads the demo practice: the fictional Harbour & Vine Legal (`seed --scenario=demo`: a year and
 * a half of matters, time, invoices and payments, Clerk threads and suggestions, every built
 * feature switched on for the org) with its four accounts, into dev (`materia-v2-dev`, through the
 * `dev-script` workflow) or a `demo-` emulator project. Run it again to put the demo back as it
 * was: it removes the org, its files and its accounts' user documents first, so anything clicked
 * during a demo goes. Dates move with the day it runs.
 *
 * - Sign in as `demo@harbourvine.example` (the owner; `demo.lawyer@`, `demo.paralegal@` and
 *   `demo.readonly@` for the other roles). `.example` is a reserved domain: no mail can reach it,
 *   and the accounts' user documents are marked undeliverable so nothing tries.
 * - On dev the password is the Secret Manager secret `demo-login-password` (created with a random
 *   value the first time; never printed). In the emulators it is the seed's.
 * - Only the demo org (`orgs/org-harbour-vine/**`), the four accounts' `users/{uid}` documents, the
 *   accounts themselves and the org's files are touched. It refuses to run if an account or the
 *   org is not the demo's, or if anyone else is a member of the demo org.
 * - On dev it then starts the invoices' PDF renders, and restates the org's Insights metrics.
 *
 * `--dry-run` reads only and reports what it would do. `--verify` changes nothing and checks the
 * demo is complete: every document present and schema-valid, the accounts' claims right. `--remove`
 * deletes the demo (the org, its files, the accounts) and leaves the secret. On dev, `--verify` also
 * reports the invoice PDFs and their jobs (with Cloud Run's view of a render that never started),
 * and `--pdfs` starts again the renders that didn't finish.
 * Logs counts and ids only. Never prod: any other project is refused.
 */
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';

import { type App, deleteApp, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import * as domainModule from '@materia/domain';

import { adminStore, backfillMetrics, FROM_EARLIEST } from './backfills/metrics.ts';
import { apiDeps } from './backups/firestore.ts';
import {
  buildDataset,
  type FixtureName,
  SEED_ACCOUNTS,
  SEED_ORG_ID,
  SEED_PASSWORD,
  type SeedDataset,
  type SeedDoc,
  stripUndefined,
} from './seed/dataset.ts';
import { unwrap } from './seed/interop.ts';
import { FIXTURE_NAMES, fixtureInfo, readFixture } from './seed/pdfs.ts';
import { entityRegistry, fromFirestore } from './seed.ts';

const domain = unwrap(domainModule);

/** The only real project the demo goes into. */
export const DEMO_DEV_PROJECT = 'materia-v2-dev';
export const DEMO_SECRET = 'demo-login-password';
export const DEMO_ORG_NAME = 'Harbour & Vine Legal';
export const DEMO_APP_URL = 'https://materia-v2-dev.web.app';

/** The demo's sign-ins, by seed account. The owner's is the one to give out. */
export const DEMO_EMAILS: Readonly<Record<string, string>> = {
  'user-priya': 'demo@harbourvine.example',
  'user-jordan': 'demo.lawyer@harbourvine.example',
  'user-daniel': 'demo.paralegal@harbourvine.example',
  'user-sam': 'demo.readonly@harbourvine.example',
};
const DEMO_DOMAIN = '@harbourvine.example';

export class DemoGuardError extends Error {
  override readonly name = 'DemoGuardError';
}

export interface DemoTarget {
  kind: 'dev' | 'emulator';
  projectId: string;
  bucket: string;
  authHost: string | null;
}

/**
 * Dev, or a `demo-` project in the emulators; anything else (prod above all) is refused. Dev is
 * refused with emulator hosts set, so a stray variable can't point the "dev" load somewhere else.
 */
export function resolveDemoTarget(projectId: string | undefined, env: NodeJS.ProcessEnv): DemoTarget {
  const firestoreHost = env['FIRESTORE_EMULATOR_HOST']?.trim();
  const authHost = env['FIREBASE_AUTH_EMULATOR_HOST']?.trim();
  if (!projectId) throw new DemoGuardError('Pass --project (materia-v2-dev, or a demo- emulator project).');
  if (projectId === DEMO_DEV_PROJECT) {
    if (firestoreHost || authHost)
      throw new DemoGuardError(
        'Refusing: emulator hosts are set but the project is dev. Unset them, or use a demo- project.',
      );
    return { kind: 'dev', projectId, bucket: `${projectId}-files`, authHost: null };
  }
  if (projectId.startsWith('demo-')) {
    if (!firestoreHost || !authHost)
      throw new DemoGuardError(
        'Refusing: a demo- project needs FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST.',
      );
    return { kind: 'emulator', projectId, bucket: `${projectId}.appspot.com`, authHost };
  }
  throw new DemoGuardError(
    `Refusing project "${projectId}": the demo practice only goes into ${DEMO_DEV_PROJECT} or a demo- emulator project.`,
  );
}

export interface DemoArgs {
  project: string | undefined;
  dryRun: boolean;
  verify: boolean;
  remove: boolean;
  pdfs: boolean;
}

export function parseDemoArgs(argv: string[]): DemoArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      remove: { type: 'boolean', default: false },
      pdfs: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if ([values.verify, values.remove, values.pdfs].filter(Boolean).length > 1)
    throw new Error('Pass one of --verify, --remove and --pdfs, not more.');
  return {
    project: values.project ?? process.env['GCLOUD_PROJECT'],
    dryRun: values['dry-run'],
    verify: values.verify,
    remove: values.remove,
    pdfs: values.pdfs,
  };
}

const ORG_PATH = `orgs/${SEED_ORG_ID}`;
const INVOICE_PATH = /^orgs\/[^/]+\/invoices\/[^/]+$/;
const DEMO_UIDS = SEED_ACCOUNTS.map((account) => account.uid);

/**
 * What the demo writes: the org's documents and the accounts' user documents with the demo's
 * emails (the global calendars and rule set the local seed adds are deployed data on dev, so they
 * are left alone). The user documents are marked undeliverable, so notifications never email them.
 */
export function demoDocs(dataset: SeedDataset, now: Date): SeedDoc[] {
  const users = new Set(DEMO_UIDS.map((uid) => `users/${uid}`));
  return dataset.docs
    .filter((doc) => doc.path === ORG_PATH || doc.path.startsWith(`${ORG_PATH}/`) || users.has(doc.path))
    .map((doc) => {
      const [collection, id, sub, uid] = doc.path.split('/');
      const depth = doc.path.split('/').length;
      if (collection === 'users' && id && depth === 2)
        return {
          path: doc.path,
          data: {
            ...doc.data,
            email: DEMO_EMAILS[id],
            // notifications-deliver skips undeliverable addresses (FND-20): .example takes no mail.
            emailDeliverability: { status: 'undeliverable', reason: 'hard_bounce', at: now },
          },
        };
      if (sub === 'members' && uid && depth === 4)
        return { path: doc.path, data: { ...doc.data, email: DEMO_EMAILS[uid] } };
      return doc;
    });
}

/** The demo's accounts, with their demo emails. */
export function demoAccounts(dataset: SeedDataset) {
  return dataset.accounts.map((account) => ({ ...account, email: DEMO_EMAILS[account.uid] as string }));
}

/** A password that is easy to type from a screen and meets the policy (12 or more characters). */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `Vine-${group()}-${group()}-${group()}`;
}

// ---------- Google APIs (dev) ----------

const SECRET_MANAGER = 'https://secretmanager.googleapis.com/v1';
const CLOUD_RUN = 'https://run.googleapis.com/v2';
const LOGGING = 'https://logging.googleapis.com/v2';
const REGION = 'australia-southeast1';

/**
 * terraform-agent belongs to the admin project, where Firebase Auth (Identity Toolkit) and the
 * other APIs are off, and some Google APIs bill quota to the caller's project. So on dev every
 * call names the target project instead, as remote-config.ts does: firebase-admin's own requests
 * through GOOGLE_CLOUD_QUOTA_PROJECT, and this script's REST calls through the header.
 */
export function billToTarget(target: DemoTarget, env: NodeJS.ProcessEnv): void {
  if (target.kind === 'dev') env['GOOGLE_CLOUD_QUOTA_PROJECT'] = target.projectId;
}

async function call(project: string, url: string, init: RequestInit = {}): Promise<Response> {
  const { fetch: doFetch, token } = apiDeps();
  return doFetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      'x-goog-user-project': project,
      ...init.headers,
    },
  });
}

/** The demo password from Secret Manager; created with a new random value when it isn't there yet. */
async function devPassword(project: string, create: boolean): Promise<{ password: string | null; created: boolean }> {
  const secret = `${SECRET_MANAGER}/projects/${project}/secrets/${DEMO_SECRET}`;
  const latest = await call(project, `${secret}/versions/latest:access`);
  if (latest.ok) {
    const body = (await latest.json()) as { payload?: { data?: string } };
    return { password: Buffer.from(body.payload?.data ?? '', 'base64').toString('utf8'), created: false };
  }
  if (latest.status !== 404) throw new Error(`Secret Manager: reading ${DEMO_SECRET} failed (${latest.status})`);
  if (!create) return { password: null, created: false };
  const made = await call(project, `${SECRET_MANAGER}/projects/${project}/secrets?secretId=${DEMO_SECRET}`, {
    method: 'POST',
    body: JSON.stringify({ replication: { automatic: {} }, labels: { purpose: 'demo-login' } }),
  });
  if (!made.ok && made.status !== 409)
    throw new Error(`Secret Manager: creating ${DEMO_SECRET} failed (${made.status})`);
  const password = generatePassword();
  const added = await call(project, `${secret}:addVersion`, {
    method: 'POST',
    body: JSON.stringify({ payload: { data: Buffer.from(password, 'utf8').toString('base64') } }),
  });
  if (!added.ok) throw new Error(`Secret Manager: adding a version of ${DEMO_SECRET} failed (${added.status})`);
  return { password, created: true };
}

/** Starts the `pdf` Cloud Run job for one queued job document, as jobs-startPdf does (ADR-014). */
async function startPdfJob(project: string, jobId: string): Promise<string> {
  const response = await call(project, `${CLOUD_RUN}/projects/${project}/locations/${REGION}/jobs/pdf:run`, {
    method: 'POST',
    body: JSON.stringify({
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: 'JOB_ORG_ID', value: SEED_ORG_ID },
              { name: 'JOB_ID', value: jobId },
            ],
          },
        ],
      },
    }),
  });
  if (!response.ok) throw new Error(`Cloud Run job pdf did not start (${response.status})`);
  const operation = (await response.json()) as { name?: string; metadata?: { name?: string } };
  const execution = operation.metadata?.name ?? operation.name ?? '';
  return execution.split('/').pop() ?? execution;
}

// ---------- steps ----------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => console.log(line);

/** The account, or null when there is none (any other failure is thrown). */
async function findUser<T>(lookup: Promise<T>): Promise<T | null> {
  try {
    return await lookup;
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') return null;
    throw error;
  }
}

/** Refuses unless every account and the org found is the demo's, and nobody else is a member. */
async function checkOwnership(auth: Auth, db: Firestore, accounts: ReturnType<typeof demoAccounts>): Promise<string[]> {
  const problems: string[] = [];
  for (const account of accounts) {
    const byUid = await findUser(auth.getUser(account.uid));
    if (byUid && !byUid.email?.endsWith(DEMO_DOMAIN))
      problems.push(`account ${account.uid} exists and isn't a demo account`);
    const byEmail = await findUser(auth.getUserByEmail(account.email));
    if (byEmail && byEmail.uid !== account.uid)
      problems.push(`${account.email} is already used by another account (${byEmail.uid})`);
  }
  const org = await db.doc(ORG_PATH).get();
  if (org.exists && org.get('name') !== DEMO_ORG_NAME) problems.push(`${ORG_PATH} exists and isn't the demo practice`);
  const members = await db.collection(`${ORG_PATH}/members`).listDocuments();
  const others = members.map((ref) => ref.id).filter((uid) => !DEMO_UIDS.includes(uid));
  if (others.length)
    problems.push(`the demo org has other members (${others.join(', ')}); remove them in Settings → Members first`);
  return problems;
}

/** Whether anything is left under the org: the document itself or any collection. */
async function leftovers(db: Firestore): Promise<number> {
  const org = await db.doc(ORG_PATH).get();
  const collections = await db.doc(ORG_PATH).listCollections();
  return (org.exists ? 1 : 0) + collections.length;
}

/**
 * Removes the org (every subcollection), the accounts' user documents and the org's files (every
 * version). On dev the functions react to the deletes (audit, activity, counts) and some write
 * back under the org, so it deletes again until nothing has come back for `settleMs`.
 */
async function wipe(app: App, target: DemoTarget, settleMs: number): Promise<void> {
  const db = getFirestore(app);
  const removeAll = async () => {
    await db.recursiveDelete(db.doc(ORG_PATH));
    for (const uid of DEMO_UIDS) await db.recursiveDelete(db.doc(`users/${uid}`));
  };
  await removeAll();
  const bucket = getStorage(app).bucket(target.bucket);
  const [files] = await bucket.getFiles({ prefix: `${ORG_PATH}/`, versions: target.kind === 'dev' });
  for (let i = 0; i < files.length; i += 20) {
    await Promise.all(files.slice(i, i + 20).map((file) => file.delete({ ignoreNotFound: true })));
  }
  log(`Removed the demo org and ${files.length} file versions.`);
  if (!settleMs) return;
  // Settle: wait for the delete triggers, sweeping up what they write, until a quiet period.
  const deadline = Date.now() + 10 * 60_000;
  let quietSince = Date.now();
  while (Date.now() - quietSince < settleMs) {
    if (Date.now() > deadline) throw new Error('The demo org keeps getting written to; is something else using it?');
    await sleep(15_000);
    if (await leftovers(db)) {
      await removeAll();
      quietSince = Date.now();
      log('Swept up what the delete triggers wrote; waiting for them to finish.');
    }
  }
}

async function upsertAccounts(auth: Auth, accounts: ReturnType<typeof demoAccounts>, password: string): Promise<void> {
  for (const account of accounts) {
    const fields = {
      email: account.email,
      password,
      displayName: account.displayName,
      emailVerified: true,
      disabled: false,
    };
    const existing = await findUser(auth.getUser(account.uid));
    if (existing) await auth.updateUser(account.uid, fields);
    else await auth.createUser({ uid: account.uid, ...fields });
    // The claims auth-syncClaims computes from the member documents (FND-17), set now so the first
    // sign-in doesn't wait for it.
    await auth.setCustomUserClaims(
      account.uid,
      domain.computeClaims([{ orgId: SEED_ORG_ID, role: account.role, name: DEMO_ORG_NAME }], SEED_ORG_ID),
    );
  }
}

async function writeAll(db: Firestore, docs: readonly SeedDoc[], batchSize: number, pauseMs: number): Promise<void> {
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    for (const { path, data } of docs.slice(i, i + batchSize)) batch.set(db.doc(path), stripUndefined(data));
    await batch.commit();
    if (pauseMs && i + batchSize < docs.length) await sleep(pauseMs);
  }
}

/** Starts the `pdf` job for each job document; one that can't start is left failed and retryable. */
async function startRenders(db: Firestore, project: string, renders: readonly { jobId: string; invoice: string }[]) {
  for (let i = 0; i < renders.length; i += 4) {
    await Promise.all(
      renders.slice(i, i + 4).map(async ({ jobId, invoice }) => {
        const ref = db.doc(`${ORG_PATH}/jobs/${jobId}`);
        try {
          await ref.update({ executionId: await startPdfJob(project, jobId) });
        } catch {
          // As jobs-startPdf leaves it: failed and retryable; the invoice offers a retry.
          const now = new Date();
          await ref.update({
            status: 'failed',
            error: { code: 'UNAVAILABLE', message: 'The job could not be started', retryable: true },
            finishedAt: now,
            updatedAt: now,
          });
          await db.doc(invoice).update({ pdfStatus: 'failed', updatedAt: now, updatedBy: 'system' });
        }
      }),
    );
    await sleep(5_000);
  }
}

/**
 * Where the invoice PDFs are: invoices by `pdfStatus`, their jobs by status, and the first few
 * that haven't succeeded (status, attempts, execution, heartbeat, error code). Ids and codes only.
 */
export async function pdfReport(db: Firestore, now = new Date()): Promise<string[]> {
  const [invoices, jobs] = await Promise.all([
    db.collection(`${ORG_PATH}/invoices`).get(),
    db.collection(`${ORG_PATH}/jobs`).get(),
  ]);
  const tally = (values: unknown[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
    return [...counts].map(([key, n]) => `${n} ${key}`).join(', ') || 'none';
  };
  const lines = [
    `Invoice PDFs: ${tally(invoices.docs.map((doc) => doc.get('pdfStatus')))}.`,
    `PDF jobs: ${tally(jobs.docs.map((doc) => doc.get('status')))}.`,
  ];
  const at = (value: unknown) => (value as { toDate?: () => Date } | undefined)?.toDate?.();
  for (const doc of jobs.docs.filter((job) => job.get('status') !== 'succeeded').slice(0, 5)) {
    const heartbeat = at(doc.get('heartbeatAt'));
    const error = doc.get('error') as { code?: string; message?: string } | undefined;
    lines.push(
      [
        `  ${doc.id}: ${String(doc.get('status'))}, attempts ${String(doc.get('attempts'))}`,
        doc.get('executionId') ? `execution ${String(doc.get('executionId'))}` : 'no execution',
        heartbeat ? `heartbeat ${Math.round((now.getTime() - heartbeat.getTime()) / 1000)} s ago` : 'no heartbeat',
        error ? `${error.code ?? 'error'}: ${error.message ?? ''}` : '',
      ]
        .filter(Boolean)
        .join(', '),
    );
  }
  return lines;
}

/**
 * What Cloud Run says about the first PDF job that never started (queued, with an execution): the
 * execution's task counts and unmet conditions, and its last log lines (the job logs ids and codes).
 */
async function stuckPdfDiagnosis(db: Firestore, project: string): Promise<string[]> {
  const stuck = await db.collection(`${ORG_PATH}/jobs`).where('status', '==', 'queued').limit(5).get();
  const executionId = stuck.docs.map((doc) => doc.get('executionId') as string | undefined).find(Boolean);
  if (!executionId) return [];
  const lines: string[] = [];
  const execution = await call(
    project,
    `${CLOUD_RUN}/projects/${project}/locations/${REGION}/jobs/pdf/executions/${executionId}`,
  );
  if (execution.ok) {
    const body = (await execution.json()) as {
      runningCount?: number;
      succeededCount?: number;
      failedCount?: number;
      cancelledCount?: number;
      conditions?: { type?: string; state?: string; reason?: string; executionReason?: string; message?: string }[];
    };
    lines.push(
      `Execution ${executionId}: ${body.runningCount ?? 0} running, ${body.succeededCount ?? 0} succeeded, ${body.failedCount ?? 0} failed, ${body.cancelledCount ?? 0} cancelled.`,
    );
    for (const condition of body.conditions ?? []) {
      if (condition.state === 'CONDITION_SUCCEEDED') continue;
      const reason = condition.reason ?? condition.executionReason;
      lines.push(
        `  ${condition.type ?? '?'}: ${condition.state ?? '?'}${reason ? ` (${reason})` : ''}${condition.message ? ` ${condition.message.slice(0, 300)}` : ''}`,
      );
    }
  } else lines.push(`Execution ${executionId}: Cloud Run answered ${execution.status}.`);
  const logs = await call(project, `${LOGGING}/entries:list`, {
    method: 'POST',
    body: JSON.stringify({
      resourceNames: [`projects/${project}`],
      filter: `resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${executionId}"`,
      orderBy: 'timestamp desc',
      pageSize: 15,
    }),
  });
  if (logs.ok) {
    const body = (await logs.json()) as {
      entries?: { severity?: string; textPayload?: string; jsonPayload?: Record<string, unknown> }[];
    };
    const entries = (body.entries ?? []).reverse();
    lines.push(`  ${entries.length} log lines:`);
    for (const entry of entries)
      lines.push(
        `    ${entry.severity ?? ''} ${(entry.textPayload ?? JSON.stringify(entry.jsonPayload ?? {})).slice(0, 300)}`,
      );
  } else lines.push(`  Cloud Logging answered ${logs.status}.`);
  return lines;
}

/**
 * Starts again the renders of invoices whose PDF isn't ready, when their job can run again
 * (queued, failed and retryable, or running with a stale heartbeat; the job's claim decides).
 */
async function restartPdfs(db: Firestore, project: string): Promise<number> {
  const invoices = await db.collection(`${ORG_PATH}/invoices`).get();
  const renders: { jobId: string; invoice: string }[] = [];
  for (const invoice of invoices.docs) {
    const jobId = invoice.get('pdfJobId') as string | undefined;
    if (invoice.get('pdfStatus') === 'ready' || !jobId) continue;
    const job = await db.doc(`${ORG_PATH}/jobs/${jobId}`).get();
    const status = job.get('status') as string | undefined;
    const heartbeat = (job.get('heartbeatAt') as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    const runnable =
      status === 'queued' ||
      (status === 'failed' && (job.get('error') as { retryable?: boolean } | undefined)?.retryable === true) ||
      (status === 'running' && Date.now() - heartbeat > 2 * 60_000);
    if (!job.exists || !runnable) continue;
    if (invoice.get('pdfStatus') !== 'pending')
      await invoice.ref.update({ pdfStatus: 'pending', updatedAt: new Date(), updatedBy: 'system' });
    renders.push({ jobId, invoice: invoice.ref.path });
  }
  await startRenders(db, project, renders);
  return renders.length;
}

/** Starts the queued invoice PDF renders a few at a time and waits for their invoices. */
async function renderPdfs(
  db: Firestore,
  project: string,
  docs: readonly SeedDoc[],
): Promise<{ ready: number; failed: number }> {
  const invoices = docs.filter((doc) => INVOICE_PATH.test(doc.path));
  await startRenders(
    db,
    project,
    docs
      .filter((doc) => doc.path.startsWith(`${ORG_PATH}/jobs/`))
      .map((doc) => {
        const jobId = doc.path.split('/').at(-1) as string;
        const invoice = invoices.find((inv) => inv.data['pdfJobId'] === jobId);
        return { jobId, invoice: invoice?.path ?? `${ORG_PATH}/invoices/${jobId}` };
      }),
  );
  return waitForPdfs(db);
}

async function waitForPdfs(db: Firestore, minutes = 12): Promise<{ ready: number; failed: number }> {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const snap = await db.collection(`${ORG_PATH}/invoices`).get();
    const pending = snap.docs.filter((doc) => doc.get('pdfStatus') === 'pending').length;
    const failed = snap.docs.filter((doc) => doc.get('pdfStatus') === 'failed').length;
    if (!pending || Date.now() > deadline) {
      if (pending) log(`${pending} invoice PDFs are still rendering; they finish on their own.`);
      return { ready: snap.size - pending - failed, failed };
    }
    await sleep(15_000);
  }
}

/** Every document the demo wrote is there and schema-valid, and the accounts' claims are right. */
async function verify(
  app: App,
  target: DemoTarget,
  docs: readonly SeedDoc[],
  password: string | null,
): Promise<string[]> {
  const db = getFirestore(app);
  const registry = entityRegistry();
  const problems: string[] = [];
  // Today's debtors report is replaced nightly under a new day's id; the rest stays where it was written.
  const expected = docs.filter((doc) => !doc.path.startsWith(`${ORG_PATH}/metrics/`));
  let present = 0;
  for (let i = 0; i < expected.length; i += 300) {
    const chunk = expected.slice(i, i + 300);
    const snaps = await db.getAll(...chunk.map((doc) => db.doc(doc.path)));
    snaps.forEach((snap, k) => {
      const path = (chunk[k] as SeedDoc).path;
      if (!snap.exists) return void problems.push(`${path}: missing`);
      present++;
      const entity = registry.find((e) => e.pattern.test(path));
      const result = entity?.schema.safeParse(fromFirestore(snap.data()));
      if (!result?.success)
        problems.push(
          `${path}: ${result?.error.issues.map((issue) => issue.path.join('.')).join(', ') ?? 'no schema'}`,
        );
    });
  }
  log(`${present} of ${expected.length} documents present.`);
  const auth = getAuth(app);
  for (const account of SEED_ACCOUNTS) {
    const email = DEMO_EMAILS[account.uid] as string;
    const user = await findUser(auth.getUser(account.uid));
    const claims = user?.customClaims ?? {};
    if (user?.email !== email || claims['orgId'] !== SEED_ORG_ID || claims['role'] !== account.role)
      problems.push(`${account.uid}: account or claims are wrong`);
    if (target.kind === 'emulator' && password) {
      const response = await fetch(
        `http://${target.authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        },
      );
      if (!response.ok) problems.push(`${account.uid}: can't sign in`);
    }
  }
  return problems;
}

export async function main(argv: string[] = []): Promise<void> {
  const args = parseDemoArgs(argv);
  const target = resolveDemoTarget(args.project, process.env);
  const dev = target.kind === 'dev';
  if (!dev) process.env['METADATA_SERVER_DETECTION'] = 'none';
  billToTarget(target, process.env);
  const now = new Date();
  const fixtures = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, fixtureInfo(name)])) as Record<
    FixtureName,
    ReturnType<typeof fixtureInfo>
  >;
  const dataset = buildDataset({ scenario: 'demo', anchor: domain.today('Australia/Melbourne', now), fixtures, now });
  const docs = demoDocs(dataset, now);
  const accounts = demoAccounts(dataset);
  const app = initializeApp({ projectId: target.projectId, storageBucket: target.bucket }, `demo-reset-${Date.now()}`);
  try {
    const db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
    const auth = getAuth(app);
    const mode = args.dryRun ? ' (dry run: nothing is changed)' : '';
    log(`Demo practice on ${target.projectId}${mode}.`);

    if (args.verify) {
      const password = dev ? null : SEED_PASSWORD;
      const problems = await verify(app, target, docs, password);
      if (problems.length) throw new Error(`The demo practice is incomplete:\n  ${problems.slice(0, 50).join('\n  ')}`);
      log('The demo practice is complete.');
      if (dev) log([...(await pdfReport(db)), ...(await stuckPdfDiagnosis(db, target.projectId))].join('\n'));
      return;
    }

    if (args.pdfs) {
      if (!dev) throw new DemoGuardError('--pdfs is for dev: the emulators have no PDF job.');
      if (args.dryRun) {
        log([...(await pdfReport(db)), ...(await stuckPdfDiagnosis(db, target.projectId))].join('\n'));
        return;
      }
      log(`Started ${await restartPdfs(db, target.projectId)} invoice PDF renders again.`);
      await waitForPdfs(db, 6);
      log([...(await pdfReport(db)), ...(await stuckPdfDiagnosis(db, target.projectId))].join('\n'));
      return;
    }

    const problems = await checkOwnership(auth, db, accounts);
    if (problems.length) throw new DemoGuardError(`Refusing to touch the demo:\n  ${problems.join('\n  ')}`);

    if (args.dryRun) {
      const org = await db.doc(ORG_PATH).get();
      const existing = org.exists ? (await db.collection(`${ORG_PATH}/matters`).count().get()).data().count : 0;
      const secret = dev ? await devPassword(target.projectId, false) : { password: SEED_PASSWORD };
      log(
        [
          org.exists
            ? `Would remove the demo org (${existing} matters now) and its files.`
            : 'The demo org is not there yet.',
          args.remove
            ? `Would delete the ${accounts.length} demo accounts.`
            : `Would write ${docs.length} documents and ${dataset.files.length} files, and set up ${accounts.length} accounts.`,
          dev ? `The ${DEMO_SECRET} secret ${secret.password ? 'exists' : 'would be created'}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }

    await wipe(app, target, dev ? 60_000 : 0);
    if (args.remove) {
      for (const account of accounts) if (await findUser(auth.getUser(account.uid))) await auth.deleteUser(account.uid);
      log(
        `Removed the demo practice and its ${accounts.length} accounts${dev ? `; the ${DEMO_SECRET} secret stays` : ''}.`,
      );
      return;
    }

    const { password, created } = dev
      ? await devPassword(target.projectId, true)
      : { password: SEED_PASSWORD, created: false };
    if (!password) throw new Error(`No password in ${DEMO_SECRET}`);
    await upsertAccounts(auth, accounts, password);

    // The files first: ingestion (AI-04) reads each document's file as soon as its record lands.
    const bucket = getStorage(app).bucket(target.bucket);
    for (const file of dataset.files) {
      await bucket
        .file(file.storagePath)
        .save(readFixture(file.fixture), { contentType: 'application/pdf', resumable: false });
    }
    // On dev every write runs the triggers: smaller batches with a pause keep them from piling up.
    await writeAll(db, docs, dev ? 150 : 400, dev ? 3_000 : 0);
    log(`Wrote ${docs.length} documents and ${dataset.files.length} files.`);

    if (dev) {
      const pdfs = await renderPdfs(db, target.projectId, docs);
      if (pdfs.ready === docs.filter((doc) => INVOICE_PATH.test(doc.path)).length)
        log(`Invoice PDFs: all ${pdfs.ready} ready.`);
      else log([...(await pdfReport(db)), ...(await stuckPdfDiagnosis(db, target.projectId))].join('\n'));
      // Let the metrics sync triggers finish before restating from the records.
      await sleep(60_000);
    }
    const report = await backfillMetrics(adminStore(db), { from: FROM_EARLIEST, org: SEED_ORG_ID, now, log });
    log(`Insights restated: ${report.documents} metrics documents.`);

    const missing = await verify(app, target, docs, dev ? null : password);
    if (missing.length) throw new Error(`The demo practice is incomplete:\n  ${missing.slice(0, 50).join('\n  ')}`);
    log(
      dev
        ? `Ready. Sign in at ${DEMO_APP_URL} as ${DEMO_EMAILS['user-priya']}; the password is the ${DEMO_SECRET} secret in Secret Manager${created ? ' (just created)' : ''}.`
        : `Ready. Sign in as ${DEMO_EMAILS['user-priya']} with the seed password.`,
    );
  } finally {
    await deleteApp(app);
  }
}
