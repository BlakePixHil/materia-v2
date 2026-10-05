import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import type { CreateMatterResult, Role, UpdateOrgSettingsResult } from '@materia/domain';

/**
 * CORE-21 through the emulators: `orgs-updateSettings` as an owner (audited), refused for a
 * lawyer; a time zone change moves an upcoming deadline's reminder (`reminders-onOrgWrite`); a new
 * number format numbers the next matter while existing numbers stay; removing a jurisdiction an
 * open matter uses is refused. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-settings';
const PASSWORD = 'fictional-password-21';
const DEADLINE = `orgs/${ORG}/matters/m-tz/deadlines/d-1`;
/** 08:00 on a date at a UTC offset. */
const at8 = (date: string, offset: string) => new Date(`${date}T08:00:00${offset}`);

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const uidOf = (role: Role) => `settings-${role}`;

const practice = {
  name: 'Fictional Settings Practice',
  abn: '51 824 753 556',
  primaryJurisdiction: 'VIC',
  jurisdictions: ['VIC', 'NSW'],
  timezone: 'Australia/Melbourne',
  holidayLocality: 'VIC_MELBOURNE',
  retentionYears: 7,
};

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )({ requestId: randomUUID(), ...data }).then((result) => result.data);
}
const update = (data: Record<string, unknown>) => call<UpdateOrgSettingsResult>('orgs-updateSettings', data);

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const codeOf = (error: FunctionsError) => (error.details as { code?: string } | undefined)?.code;

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const nextReminder = async () => (await db.doc(DEADLINE).get()).get('nextReminderAt') as Timestamp | undefined;

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'org-settings-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  const adminAuth = getAdminAuth(admin);
  for (const role of ['owner', 'lawyer'] as const) {
    await adminAuth.deleteUser(uidOf(role)).catch(() => undefined);
    await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
    await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  }
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Settings Practice',
    jurisdictions: ['VIC', 'NSW'],
    primaryJurisdiction: 'VIC',
    timezone: 'Australia/Melbourne',
    holidayLocality: 'VIC_MELBOURNE',
    retentionYears: 7,
    matterNumberFormat: 'M-{YYYY}-{seq:4}',
  });
  for (const role of ['owner', 'lawyer'] as const) {
    await db
      .doc(`orgs/${ORG}/members/${uidOf(role)}`)
      .set({ role, status: 'active', displayName: `Fictional ${role}` });
  }
  await db.doc(`orgs/${ORG}/contacts/c-client`).set({
    kind: 'person',
    givenNames: 'Wren',
    familyName: 'Fictional',
    emails: [],
    phones: [],
    deletedAt: null,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'org-settings-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await db.doc(`emulatorClock/${ORG}`).delete();
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('orgs-updateSettings (CORE-21)', () => {
  it('is refused for a lawyer', async () => {
    await signInAs('lawyer');
    expect(codeOf(await failure(update({ practice })))).toBe('PERMISSION_DENIED');
  });

  it('saves for an owner and is audited', async () => {
    await signInAs('owner');
    const result = await update({ practice });
    expect(result.saved).toBe(true);
    expect((await db.doc(`orgs/${ORG}`).get()).get('abn')).toBe('51824753556');
    const entries = await poll(
      async () => (await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'org.settings_updated').get()).docs,
      (docs) => docs.length > 0,
    );
    expect(entries[0]?.get('actor')).toEqual({ uid: uidOf('owner') });
  });

  it('moves the reminders when the time zone changes', async () => {
    // The trigger reads the org's pinned clock: 11:00 on Monday 26 October 2026 in Melbourne.
    await db.doc(`emulatorClock/${ORG}`).set({ now: Timestamp.fromDate(new Date('2026-10-26T00:00:00Z')) });
    await db.doc(`orgs/${ORG}/matters/m-tz`).set({
      number: 'M-2026-0900',
      title: 'Estate of Fictional Timezone',
      status: 'open',
      jurisdiction: 'VIC',
      responsibleUid: uidOf('owner'),
      privileged: false,
      deletedAt: null,
    });
    await db.doc(DEADLINE).set({
      orgId: ORG,
      matterId: 'm-tz',
      title: 'File the fictional affidavit',
      dueDate: '2026-11-26',
      kind: 'court',
      critical: true,
      status: 'upcoming',
      assigneeUid: uidOf('owner'),
      reminders: [],
      pastOnCreation: false,
      deletedAt: null,
    });
    const melbourne = at8('2026-10-27', '+11:00').toISOString();
    expect((await poll(nextReminder, (v) => v?.toDate().toISOString() === melbourne))?.toDate().toISOString()).toBe(
      melbourne,
    );

    await signInAs('owner');
    const perth = { ...practice, timezone: 'Australia/Perth' };
    const dry = await update({ practice: perth, dryRun: true });
    expect(dry).toMatchObject({ saved: false, impact: { remindersRescheduled: 1 } });
    expect((await db.doc(`orgs/${ORG}`).get()).get('timezone')).toBe('Australia/Melbourne');

    await update({ practice: perth });
    const moved = at8('2026-10-27', '+08:00').toISOString();
    expect((await poll(nextReminder, (v) => v?.toDate().toISOString() === moved))?.toDate().toISOString()).toBe(moved);
  });

  it('numbers new matters with a new format; existing numbers stay', async () => {
    await signInAs('owner');
    await update({ matterNumberFormat: 'SET-{TYPE}-{YY}-{seq:3}' });
    const { number } = await call<CreateMatterResult>('matters-createMatter', {
      matter: {
        title: 'Estate of Fictional Format',
        type: 'probate',
        jurisdiction: 'VIC',
        responsibleUid: uidOf('owner'),
        teamUids: [],
        clientContactIds: ['c-client'],
        fee: { arrangement: 'hourly' },
        costsDisclosure: { status: 'required' },
        conflictCheck: { status: 'pending' },
      },
    });
    expect(number).toMatch(/^SET-PRB-\d{2}-\d{3}$/);
    expect((await db.doc(`orgs/${ORG}/matters/m-tz`).get()).get('number')).toBe('M-2026-0900');
  });

  it('refuses removing a jurisdiction an open matter uses', async () => {
    await db.doc(`orgs/${ORG}/matters/m-nsw`).set({
      number: 'M-2026-0901',
      title: 'Estate of Fictional Sydney',
      status: 'open',
      jurisdiction: 'NSW',
      deletedAt: null,
    });
    await signInAs('owner');
    const error = await failure(update({ practice: { ...practice, jurisdictions: ['VIC'] } }));
    expect(codeOf(error)).toBe('FAILED_PRECONDITION');
    expect((await db.doc(`orgs/${ORG}`).get()).get('jurisdictions')).toEqual(['VIC', 'NSW']);
  });
});
