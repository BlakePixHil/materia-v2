import { randomUUID } from 'node:crypto';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

import {
  CLERK_DISCLOSURE_VERSION,
  documentVersionPath,
  MIG_W_DOCUMENT_UNREADABLE,
  type AcceptSuggestionResult,
  type Role,
} from '@materia/domain';

import { anthropicKeyPath } from '../../src/clerk/keyring';
import { FakeClerkModel } from '../../src/clerk/providers/fake';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { createLog } from '../../src/core/log';
import { cachedMemberLookup } from '../../src/core/members';
import { storageFiles } from '../../src/documents/files';
import { textPdf } from '../../src/documents/ingest/testing';
import { decideEnrichmentDefinition, ENRICH_QUEUE, runEnrichmentStep, startEnrichment } from '../../src/migration';
import { enrichmentPath, readEnrichment, type EnrichTask } from '../../src/migration/shared';
import { systemClock } from '../../src/ports/container';
import { FakeKms, fakePorts, FakeTaskQueue } from '../../src/ports/fakes';
import { acceptDefinition } from '../../src/suggestions/accept';

/**
 * MIG-09 (D-21) against the Firestore and Storage emulators with the fake Clerk model: a migration
 * run's enrichment counts the migrated files and waits for an owner's approval (nothing spent),
 * then reads each one (the Storage files, chunks and vector search for real, an encrypted file
 * listed for review) and proposes the estate matter's key dates as `event` suggestions with
 * citations checked against the note and the page; a lawyer accepts the date of death, whose
 * recompute (CORE-10) makes deadlines already past (`pastOnCreation`), and the approver is told
 * what's waiting. The steps and callables run in this process, the queue's tasks one by one.
 * Every name and document is fictional.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = `${PROJECT_ID}.appspot.com`;
const ORG = 'org-mig-enrich';
const RUN = 'run-int-rehearsal';
const MATTER_ID = 'm-mig-estate';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const kms = new FakeKms();
const model = new FakeClerkModel();
const tasks = new FakeTaskQueue();
const ports = fakePorts({ clerkModel: model, clerkKms: kms, tasks });
const log = createLog({ fn: 'migration-enrichment-integration' }, () => undefined);

let admin: App;
let db: Firestore;

type Data = Record<string, unknown>;

const uidOf = (role: Role) => `mig9-${role}`;
const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'migration',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'migration',
  schemaVersion: 1,
};
const loadedAt = Timestamp.fromDate(new Date('2026-10-06T10:00:00.000Z'));
const stamp = { migration: { runId: RUN, legacyPath: 'legacy/fictional', loadedAt } };

const LETTER = [
  'Letter to the executor (fictional). Your father Ambrose Fictional died on 14 February 2024 at Geelong.',
  'The notice of intention to apply for a grant was published on 9 April 2024.',
];
const NOTE = 'Spoke to the executor (fictional). Probate was granted on 20 August 2024 by the Supreme Court.';

function call<T>(definition: unknown, role: Role, data: Data): Promise<T> {
  const clock = { now: () => new Date() };
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => ports,
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  return runCallable(
    definition as CallableDefinition<never, T>,
    { data: { requestId: randomUUID(), ...data }, auth: { uid: uidOf(role), token: { orgId: ORG, role } } },
    deps,
  );
}

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};
const record = async () => readEnrichment((await db.doc(enrichmentPath(ORG, RUN)).get()).data());
const suggestions = async () =>
  (await db.collection(`${MATTER}/suggestions`).get()).docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Data);

/** Runs the queue's tasks in order, as Cloud Tasks would (delays skipped), until none is left. */
let ran = 0;
async function drain(): Promise<string[]> {
  const outcomes: string[] = [];
  while (ran < tasks.queued.length) {
    const next = tasks.queued[ran++];
    if (next?.queue !== ENRICH_QUEUE) continue;
    outcomes.push(
      await runEnrichmentStep(next.payload as EnrichTask, {
        db,
        ports,
        clock: systemClock,
        log,
        files: storageFiles(BUCKET),
      }),
    );
    if (outcomes.length > 40) throw new Error('the enrichment never finished');
  }
  return outcomes;
}

/** A clean version the load wrote: its file in Storage and the document, stamped with the run. */
async function loadDocument(docId: string, fileName: string, bytes: Buffer, extra: Data = {}) {
  const storagePath = documentVersionPath(ORG, MATTER_ID, docId, 1);
  await getAdminStorage(admin).bucket(BUCKET).file(storagePath).save(bytes, { contentType: 'application/pdf' });
  await db.doc(`${MATTER}/documents/${docId}`).set({
    ...meta,
    ...stamp,
    orgId: ORG,
    matterId: MATTER_ID,
    name: fileName,
    category: 'other',
    privileged: false,
    tags: [],
    version: 1,
    versionSeq: 1,
    storagePath,
    versions: [
      {
        version: 1,
        storagePath,
        fileName,
        mime: 'application/pdf',
        sizeBytes: bytes.length,
        sha256: 'c'.repeat(64),
        uploadedAt: loadedAt,
        uploadedBy: 'migration',
        ...(extra['encrypted'] ? { encrypted: true } : {}),
      },
    ],
    scan: { status: 'clean' },
    ingest: { status: 'pending' },
    source: 'migration',
    encrypted: false,
    accessRestricted: false,
    search: [],
    deletedAt: null,
    ...extra,
  });
}

beforeAll(async () => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'migration-enrichment-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Barwon Heads Legal',
    timezone: 'Australia/Melbourne',
    flags: {
      'clerk.enabled': true,
      'clerk.features.suggestions': true,
      'clerk.features.classification': true,
      'deadlines.ruleset.vic.v1': true,
    },
    settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION } },
  });
  const sealed = await kms.encrypt('sk-ant-fictional-migration-integration-0000', anthropicKeyPath(ORG));
  await db.doc(anthropicKeyPath(ORG)).set({
    provider: 'anthropic',
    uid: null,
    status: 'valid',
    scopes: [],
    encryptedApiKey: sealed.ciphertext,
    kmsKeyVersion: sealed.keyVersion,
    last4: '0000',
  });
  for (const role of ['owner', 'lawyer'] as const)
    await db
      .doc(`orgs/${ORG}/members/${uidOf(role)}`)
      .set({ role, status: 'active', displayName: `Fictional ${role}` });
  await db.doc(MATTER).set({
    ...meta,
    ...stamp,
    number: 'MIG-2024-0042',
    title: 'Estate of Fictional Ambrose',
    type: 'probate',
    jurisdiction: 'VIC',
    status: 'open',
    stageId: 'intake',
    responsibleUid: uidOf('lawyer'),
    teamUids: [],
    clientContactIds: [],
    privileged: false,
    openTaskCount: 0,
    recomputeVersion: 0,
    deletedAt: null,
  });
  await db
    .doc(`${MATTER}/notes/n-mig-call`)
    .set({ ...meta, ...stamp, bodyMd: NOTE, privileged: false, deletedAt: null });
  await loadDocument('d-mig-letter', 'Letter to executor.pdf', await textPdf(LETTER));
  await loadDocument('d-mig-locked', 'Bank statement.pdf', await textPdf(['Locked (fictional).']), { encrypted: true });
});

afterAll(async () => {
  setRemoteFlagLoader();
  clearFlagCaches();
  await deleteAdminApp(admin);
});

describe('migration enrichment (MIG-09)', () => {
  it('counts the run’s files and waits for approval, spending nothing', async () => {
    expect(await startEnrichment(db, ports, systemClock, ORG, RUN)).toBe(true);
    expect(await drain()).toEqual(['waiting']);
    const r = await record();
    expect(r).toMatchObject({
      status: 'awaiting_approval',
      documents: [`${MATTER_ID}/d-mig-letter`, `${MATTER_ID}/d-mig-locked`],
      matters: [MATTER_ID],
      estimate: { documents: 2, pages: 2, ocrPages: 0, unreadable: 1, matters: 1 },
      spentMicros: 0,
    });
    expect(model.requests).toEqual([]);
    // Nothing reads the migrated files before the approval: the ingest trigger left them alone.
    expect((await data(`${MATTER}/documents/d-mig-letter`))['ingest']).toEqual({ status: 'pending' });
    const asked = await db.doc(`orgs/${ORG}/notifications/migration-enrich-${RUN}-estimate`).get();
    expect(asked.data()).toMatchObject({ recipientUid: uidOf('owner'), link: '/settings/clerk' });
  });

  it('reads the files once approved and proposes the key dates with checked citations', async () => {
    expect(
      await call(decideEnrichmentDefinition, 'owner', { runId: RUN, decision: 'approve', allowanceCents: 2_500 }),
    ).toEqual({ status: 'running' });
    expect((await drain()).at(-1)).toBe('done');

    const r = await record();
    expect(r).toMatchObject({
      status: 'done',
      approvedBy: uidOf('owner'),
      unreadable: 1,
      progress: { read: 1, mattersRead: 1, events: 3 },
    });
    expect(r?.spentMicros).toBeGreaterThan(0);
    expect((await data(`${MATTER}/documents/d-mig-letter`))['ingest']).toMatchObject({ status: 'done', pages: 2 });
    expect((await data(`${MATTER}/documents/d-mig-locked`))['needsReview']).toEqual([MIG_W_DOCUMENT_UNREADABLE]);

    const events = (await suggestions()).filter((s) => s['kind'] === 'event');
    const byKind = Object.fromEntries(events.map((s) => [(s['payload'] as Data)['kind'], s]));
    expect(byKind['date_of_death']).toMatchObject({
      status: 'proposed',
      payload: { kind: 'date_of_death', date: '2024-02-14', sourceDocumentId: 'd-mig-letter' },
      citations: [{ kind: 'document', documentId: 'd-mig-letter', docVersion: 1, page: 1 }],
    });
    expect(byKind['notice_published']).toMatchObject({
      payload: { date: '2024-04-09' },
      citations: [{ kind: 'document', documentId: 'd-mig-letter', page: 2 }],
    });
    expect(byKind['grant_issued']).toMatchObject({
      payload: { date: '2024-08-20' },
      citations: [{ kind: 'record', recordRef: { collection: 'notes', id: 'n-mig-call' } }],
    });

    const done = await data(`orgs/${ORG}/notifications/migration-enrich-${RUN}-done`);
    expect(done).toMatchObject({
      recipientUid: uidOf('owner'),
      title: 'Clerk has read the migrated files',
      link: '/inbox',
    });
    expect(String(done['body'])).toContain(`${r?.suggestionsWaiting} suggestions are waiting for review`);
    expect(String(done['body'])).toContain('1 document couldn’t be read and is listed for migration review.');
  });

  it('an accepted date of death records the event and proposes its deadlines, already past', async () => {
    const death = (await suggestions()).find(
      (s) => s['kind'] === 'event' && (s['payload'] as Data)['kind'] === 'date_of_death',
    );
    const result = await call<AcceptSuggestionResult>(acceptDefinition, 'lawyer', {
      matterId: MATTER_ID,
      suggestionId: death?.['id'],
    });
    expect(await data(result.resultRef)).toMatchObject({ kind: 'date_of_death', date: '2024-02-14' });
    expect((await data(MATTER))['recomputeVersion']).toBe(1);
    const deadlines = (await db.collection(`${MATTER}/deadlines`).get()).docs.map((doc) => doc.data());
    const dated = deadlines.filter((d) => typeof d['dueDate'] === 'string');
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.every((d) => d['pastOnCreation'] === true)).toBe(true);
  });
});
