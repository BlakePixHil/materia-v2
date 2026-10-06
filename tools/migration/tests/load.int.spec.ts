import { createHash } from 'node:crypto';

import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { EMULATOR_FILES_BUCKET } from '../src/copy-files.ts';
import { FIXTURE_FILE, FIXTURE_ORG, FIXTURE_PATHS, FIXTURE_UID, fixtureRun } from '../src/load/fixture.ts';
import type { LoadReport } from '../src/load/load.ts';
import type { VerifyReport } from '../src/load/verify.ts';
import { emulatorReadAs, loadCommand, rollbackCommand, verifyCommand } from '../src/load-commands.ts';

/**
 * MIG-06 against the Auth, Firestore and Storage emulators: a transformed run (MIG-03's contract,
 * made up) with its attachment copied (as MIG-05 leaves it), then `materia-migrate load`,
 * `verify` (every record read back, and read as the person through the security rules),
 * the conflict rule on a second load, and `rollback`, which must leave the emulator as it found
 * it apart from what was there before. Fictional data only.
 */

const RUNS = 'materia-v2-dev-migration';
const OWNER = { authorization: 'Bearer owner' };
const P = FIXTURE_PATHS;
const host = process.env['FIREBASE_STORAGE_EMULATOR_HOST'] ?? '';
const ROOT = host.includes('://') ? host : `http://${host}`;

async function ok(res: Promise<Response>): Promise<Response> {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r;
}

async function upload(bucket: string, name: string, data: Buffer | string, metadata?: Record<string, string>) {
  const query = new URLSearchParams({ uploadType: 'media', name });
  await ok(fetch(`${ROOT}/upload/storage/v1/b/${bucket}/o?${query}`, { method: 'POST', headers: OWNER, body: data }));
  if (metadata) {
    await ok(
      fetch(`${ROOT}/b/${bucket}/o/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { ...OWNER, 'content-type': 'application/json' },
        body: JSON.stringify({ metadata }),
      }),
    );
  }
}

async function objectExists(bucket: string, name: string): Promise<boolean> {
  const res = await fetch(`${ROOT}/b/${bucket}/o/${encodeURIComponent(name)}`, { headers: OWNER });
  await res.arrayBuffer();
  return res.ok;
}

const runFile = async (runId: string, name: string) =>
  (
    await ok(fetch(`${ROOT}/b/${RUNS}/o/${encodeURIComponent(`runs/${runId}/${name}`)}?alt=media`, { headers: OWNER }))
  ).text();

/** Every document path under a document, found by walking its collections. */
async function under(db: Firestore, path: string): Promise<string[]> {
  const found: string[] = [];
  for (const collection of await db.doc(path).listCollections()) {
    for (const ref of await collection.listDocuments()) {
      if ((await ref.get()).exists) found.push(ref.path);
      found.push(...(await under(db, ref.path)));
    }
  }
  return found.sort();
}

let app: App;
let db: Firestore;
let logs: string[];
const io = () => ({ log: (line: string) => void logs.push(line), error: (line: string) => void logs.push(line) });

beforeAll(() => {
  app = initializeApp({ projectId: 'demo-materia' }, `load-int-${Date.now()}`);
  db = getFirestore(app);
});
afterAll(async () => {
  await deleteApp(app);
});

describe('materia-migrate load, verify and rollback on the emulators', () => {
  it('loads a run, verifies it through the rules, keeps a v2 edit on reload, and rolls back to empty', async () => {
    logs = [];
    const runId = `int-${Date.now()}`;
    const run = ['--run', runId, '--env', 'emulator'];
    // Something else already in v2 that the rollback must leave alone.
    await db.doc('orgs/org-someone-else').set({ name: 'Someone Else (Fictional)' });

    for (const [name, text] of fixtureRun({ runId })) await upload(RUNS, `runs/${runId}/${name}`, text);
    const sha256 = createHash('sha256').update(FIXTURE_FILE).digest('hex');
    await upload(EMULATOR_FILES_BUCKET, `${P.document}/v1`, FIXTURE_FILE, { sha256, migrationRunId: runId });
    await getAuth(app).createUser({ uid: FIXTURE_UID, email: 'alex.rivers@example.com' });

    // Load.
    expect(await loadCommand([...run, '--dry-run'], io())).toBe(0);
    expect((await db.doc(P.matter).get()).exists).toBe(false);
    expect(await loadCommand(run, io()), logs.join('\n')).toBe(0);
    const matter = (await db.doc(P.matter).get()).data();
    expect(matter).toMatchObject({ number: 'M-2024-0001', migration: { runId } });
    expect(matter?.['migration'].loadedAt).toBeInstanceOf(Timestamp);
    expect((await getAuth(app).getUser(FIXTURE_UID)).customClaims).toMatchObject({ orgId: FIXTURE_ORG, role: 'owner' });
    expect((await db.doc(`orgs/${FIXTURE_ORG}/migrations/${runId}`).get()).data()).toMatchObject({
      status: 'succeeded',
    });

    // Verify, reading every record as the person through the rules.
    expect(await verifyCommand(run, io()), logs.join('\n')).toBe(0);
    const verified = JSON.parse(await runFile(runId, 'verify/report.json')) as VerifyReport;
    expect(verified.passed).toBe(true);
    expect(verified.access).toEqual([
      { uid: FIXTURE_UID, claims: 'ok', reads: expect.stringMatching(/^all \d+ read$/) },
    ]);
    expect(verified.files).toEqual({ checked: 1, problems: [] });
    // The reads do go through the rules: someone outside the org is refused.
    const readAs = emulatorReadAs(process.env['FIRESTORE_EMULATOR_HOST'] ?? '', 'demo-materia');
    expect(await readAs('uid-stranger', {}, [P.matter, P.note])).toEqual([P.matter, P.note]);

    // The person edits a note in v2; a reload leaves it and says so.
    const edited = { bodyMd: 'Edited in v2 after the load.', updatedAt: Timestamp.now(), updatedBy: FIXTURE_UID };
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.doc(P.note).update(edited);
    expect(await loadCommand(run, io())).toBe(0);
    expect((await db.doc(P.note).get()).get('bodyMd')).toBe('Edited in v2 after the load.');
    const reloaded = JSON.parse(await runFile(runId, 'load/report.json')) as LoadReport;
    expect(reloaded.conflicts).toEqual([expect.objectContaining({ code: 'MIG_C_USER_EDITED', path: P.note })]);
    expect(reloaded.counts['matters']).toMatchObject({ unchanged: 1 });

    // Roll back: everything the run loaded goes, the org with it; what was there before stays.
    expect(await rollbackCommand(run, io()), logs.join('\n')).toBe(0);
    expect((await db.doc(P.org).get()).exists).toBe(false);
    expect(await under(db, P.org)).toEqual([]);
    expect((await db.doc(P.user).get()).exists).toBe(false);
    expect((await db.doc('orgs/org-someone-else').get()).exists).toBe(true);
    expect(await objectExists(EMULATOR_FILES_BUCKET, `${P.document}/v1`)).toBe(false);
    expect((await getAuth(app).getUser(FIXTURE_UID)).customClaims ?? {}).not.toHaveProperty('orgId');
    expect(JSON.parse(await runFile(runId, 'rollback/report.json'))).toMatchObject({
      complete: true,
      orgDeleted: true,
    });
  });
});
