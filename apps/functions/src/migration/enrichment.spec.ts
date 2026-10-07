import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import {
  CLERK_DISCLOSURE_VERSION,
  DomainError,
  MIG_W_DOCUMENT_UNREADABLE,
  type ContextManifest,
  type Role,
} from '@materia/domain';

import { enqueueStep, runEnrichmentStep } from './enrich';
import { estimateCostCents } from './estimate';
import { toProposals } from './events';
import { decideEnrichmentDefinition, onRunWriteHandler, startEnrichment } from './index';
import { meteredGateway, orgBudgetNearlyUsed, pauseReason } from './meter';
import { ENRICH_QUEUE, enrichmentPath, readEnrichment, type EnrichDeps, type EnrichTask } from './shared';
import { firestoreClerkStore } from '../clerk/firestore-store';
import { createClerkGateway, type ClerkGateway } from '../clerk/gateway';
import { eventsStep, FakeClerkModel } from '../clerk/providers/fake';
import { MemoryKeyring } from '../clerk/testing';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, isEnabled, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { IngestInterrupted } from '../documents/ingest/pipeline';
import { textPdf } from '../documents/ingest/testing';
import { MemoryFiles } from '../documents/testing';
import { memoryFirestore } from '../orgs/testing';
import type { ClerkModelRequest } from '../ports';
import { FakeClock, fakePorts, FakeTaskQueue } from '../ports/fakes';
import { acceptDefinition } from '../suggestions/accept';

/**
 * MIG-09 (D-21) with fake ports and the fake Clerk model: a migration run's enrichment counted
 * and costed with no Clerk calls, approved through `migration-decideEnrichment`, every migrated
 * document read (a scan by OCR, an encrypted one listed for review), each open estate matter's
 * key dates proposed as `event` suggestions with checked citations, one accepted into deadlines,
 * the summary notification, and the pauses (allowance, the org's month, Clerk off) with resume.
 * Every person, matter and document is fictional.
 */

type Data = Record<string, unknown>;

const ORG = 'org-mig';
const RUN = 'run-rehearsal-1';
const M = `orgs/${ORG}/matters`;
const ESTATE = 'm-estate';
const CLOSED = 'm-closed';
const DISPUTE = 'm-dispute';
const OTHER_RUN = 'm-other-run';
const NOW = new Date('2026-10-07T01:00:00.000Z');

const meta = { createdBy: 'migration', updatedBy: 'migration', schemaVersion: 1 };
const stamp = (runId = RUN) => ({ migration: { runId, legacyPath: 'legacy/fictional', loadedAt: NOW } });
const member = (role: Role, status = 'active') => ({ ...meta, role, status, displayName: `Fictional ${role}` });
const matter = (extra: Data = {}) => ({
  ...meta,
  ...stamp(),
  number: 'MIG-2024-0001',
  title: 'Estate of Fictional Wren',
  type: 'probate',
  jurisdiction: 'VIC',
  status: 'open',
  stageId: 'intake',
  responsibleUid: 'u-lawyer',
  teamUids: [],
  clientContactIds: [],
  privileged: false,
  openTaskCount: 0,
  recomputeVersion: 0,
  deletedAt: null,
  createdAt: NOW,
  ...extra,
});

const LETTER = [
  'Letter to the executor (fictional). Your mother Elsie Fictional died on 12 March 2024 at Geelong.',
  'The notice of intention to apply for a grant was published on 2 May 2024 on the Supreme Court website.',
];
const NOTE = 'Phoned the executor (fictional). Probate was granted on 3 September 2024 by the Supreme Court.';

interface WorldOptions {
  flags?: Data;
  clerk?: Data;
  matters?: Record<string, Data>;
}

function world(options: WorldOptions = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Corio Bay Legal',
      timezone: 'Australia/Melbourne',
      flags: {
        'clerk.enabled': true,
        'clerk.features.suggestions': true,
        'clerk.features.classification': true,
        'deadlines.ruleset.vic.v1': true,
        ...options.flags,
      },
      settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION, ...options.clerk } },
    },
    [`orgs/${ORG}/members/u-owner`]: member('owner'),
    [`orgs/${ORG}/members/u-admin`]: member('admin'),
    [`orgs/${ORG}/members/u-lawyer`]: member('lawyer'),
    ...Object.fromEntries(
      Object.entries(
        options.matters ?? {
          [ESTATE]: matter(),
          [CLOSED]: matter({ number: 'MIG-2023-0007', status: 'closed' }),
          [DISPUTE]: matter({ number: 'MIG-2024-0009', type: 'fp' }),
          [OTHER_RUN]: matter({ number: 'MIG-2024-0011', ...stamp('run-earlier') }),
        },
      ).map(([id, data]) => [`${M}/${id}`, data]),
    ),
    [`${M}/${ESTATE}/notes/n-call`]: {
      ...meta,
      ...stamp(),
      bodyMd: NOTE,
      privileged: false,
      deletedAt: null,
      createdAt: NOW,
    },
  });
  const db = store.db;
  const files = new MemoryFiles();
  const clock = new FakeClock(NOW);
  const tasks = new FakeTaskQueue();
  const ports = fakePorts({ tasks, clock });
  const logs: { message: string; entry: Data }[] = [];
  const log = createLog({ fn: 'test' }, (_s, message, entry) => void logs.push({ message, entry }));
  const model = new FakeClerkModel();
  const keyring = new MemoryKeyring();
  const gateway = createClerkGateway({
    model,
    store: firestoreClerkStore(db),
    keyring,
    flag: (orgId, key) => isEnabled({ orgId, db, clock }, key),
    sleep: async () => undefined,
  });
  let elapsed = 0;
  const deps = (over: Partial<EnrichDeps> = {}): EnrichDeps => ({
    db,
    ports,
    clock,
    log,
    files,
    gateway,
    now: () => (elapsed += 1_000),
    ...over,
  });

  /** A clean document the load wrote, version 1, with its file stored. */
  async function addDocument(matterId: string, docId: string, fileName: string, data: Buffer, extra: Data = {}) {
    const storagePath = `${M}/${matterId}/documents/${docId}/v1`;
    files.put(storagePath, data);
    await db.doc(`${M}/${matterId}/documents/${docId}`).set({
      ...meta,
      ...stamp(),
      orgId: ORG,
      matterId,
      name: fileName,
      category: 'other',
      privileged: false,
      deletedAt: null,
      scan: { status: 'clean' },
      ingest: { status: 'pending' },
      encrypted: false,
      version: 1,
      storagePath,
      versions: [
        {
          version: 1,
          storagePath,
          fileName,
          mime: 'application/pdf',
          sizeBytes: data.length,
          sha256: 'b'.repeat(64),
          uploadedAt: NOW,
          uploadedBy: 'migration',
          ...(extra['encrypted'] ? { encrypted: true } : {}),
        },
      ],
      createdAt: NOW,
      ...extra,
    });
  }

  /** The run's usual files: a letter stating two dates, a scan, an encrypted file, one already read. */
  async function seedFiles() {
    await addDocument(ESTATE, 'd-1-letter', 'Letter to executor.pdf', await textPdf(LETTER));
    await addDocument(ESTATE, 'd-2-scan', 'Scanned receipt.pdf', await textPdf([null]));
    await addDocument(ESTATE, 'd-3-locked', 'Bank statement.pdf', await textPdf(['Locked (fictional).']), {
      encrypted: true,
    });
    await addDocument(ESTATE, 'd-4-read', 'Already read.pdf', await textPdf(['Read before (fictional).']), {
      ingest: { status: 'done', version: 1 },
    });
    await addDocument(CLOSED, 'd-5-closed', 'Final account.pdf', await textPdf(['Final account (fictional).']));
  }

  const callableDeps = (): CallableDeps => ({
    db: () => db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = <T>(def: unknown, data: Data, role: Role = 'owner', uid = `u-${role}`) =>
    runCallable(
      def as CallableDefinition<never, T>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid, token: { orgId: ORG, role } } },
      callableDeps(),
    );
  const decide = (data: Data, role: Role = 'owner') =>
    call<{ status: string }>(decideEnrichmentDefinition, { runId: RUN, ...data }, role);

  const record = async () => readEnrichment((await db.doc(enrichmentPath(ORG, RUN)).get()).data());
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const under = (path: string) =>
    [...store.docs.entries()]
      .filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1)
      .map(([p, data]): Data & { id: string } => ({ ...data, id: p.split('/').at(-1) as string }));
  const notifications = () => under(`orgs/${ORG}/notifications`);
  const suggestions = (matterId = ESTATE) => under(`${M}/${matterId}/suggestions`);

  /** Runs the queued steps in order (delays are skipped) until none is left; returns their outcomes. */
  let ran = 0;
  async function drain(over: Partial<EnrichDeps> = {}, limit = 50) {
    const outcomes: string[] = [];
    while (ran < tasks.queued.length) {
      const next = tasks.queued[ran++];
      if (next?.queue !== ENRICH_QUEUE) continue;
      outcomes.push(await runEnrichmentStep(next.payload as EnrichTask, deps(over)));
      if (outcomes.length > limit) throw new Error('the enrichment never finished');
    }
    return outcomes;
  }

  return {
    ...store,
    files,
    clock,
    tasks,
    ports,
    logs,
    model,
    keyring,
    gateway,
    deps,
    addDocument,
    seedFiles,
    call,
    decide,
    record,
    doc,
    under,
    notifications,
    suggestions,
    drain,
  };
}

type World = ReturnType<typeof world>;

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

const outputNames = (w: World) => w.model.requests.map((r) => r.output?.name);

/** Starts the run's enrichment and runs its estimate. */
async function estimated(w: World) {
  await w.seedFiles();
  expect(await startEnrichment(w.db, w.ports, w.clock, ORG, RUN)).toBe(true);
  expect(await w.drain()).toEqual(['waiting']);
}

beforeEach(() => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
});

describe('the estimate', () => {
  it('lists what the run loaded, counts the pages with no Clerk call, and asks the owners and admins', async () => {
    const w = world();
    await estimated(w);

    const r = await w.record();
    expect(r).toMatchObject({ status: 'awaiting_approval', phase: 'ingest', seq: 1, spentMicros: 0 });
    // Every unread document the run loaded (a closed matter's too); d-4 was read before.
    expect(r?.documents).toEqual([
      `${CLOSED}/d-5-closed`,
      `${ESTATE}/d-1-letter`,
      `${ESTATE}/d-2-scan`,
      `${ESTATE}/d-3-locked`,
    ]);
    // Only the open estate matter this run loaded is read for key dates.
    expect(r?.matters).toEqual([ESTATE]);
    // The encrypted file's pages can't be counted: 2 + 1 + 1 pages.
    expect(r?.estimate).toMatchObject({ documents: 4, pages: 4, ocrPages: 1, unreadable: 1, matters: 1 });
    const estimate = r?.estimate;
    if (!estimate) throw new Error('no estimate');
    expect(estimate.costCents).toBe(estimateCostCents(estimate, estimate.model));
    expect(estimate.costCents).toBeGreaterThan(0);
    expect(r.suggestedAllowanceCents).toBeGreaterThanOrEqual(estimate.costCents);

    expect(w.model.requests).toEqual([]);
    const asked = w.notifications();
    expect(asked.map((n) => n['recipientUid']).sort()).toEqual(['u-admin', 'u-owner']);
    expect(asked[0]).toMatchObject({
      kind: 'system',
      title: 'Clerk can read the migrated files',
      link: '/settings/clerk',
    });
    expect(String(asked[0]?.['body'])).toMatch(
      /^4 documents \(about 4 pages, 1 of them scanned\) and 1 estate matter: about .+\. Nothing is spent until you approve it/,
    );
  });

  it('finishes at once when the run loaded nothing to read', async () => {
    const w = world({ matters: { [DISPUTE]: matter({ type: 'fp' }) } });
    await startEnrichment(w.db, w.ports, w.clock, ORG, RUN);
    expect(await w.drain()).toEqual(['done']);
    expect(await w.record()).toMatchObject({ status: 'done', suggestionsWaiting: 0, documents: [], matters: [] });
    expect(w.notifications()).toEqual([]);
  });

  it('hands a long count over to the next step, keeping its place', async () => {
    const w = world();
    await w.seedFiles();
    await startEnrichment(w.db, w.ports, w.clock, ORG, RUN);
    // The test clock moves a second each time a step looks at it: a one-second budget counts one file a step.
    expect(await w.drain({ stepBudgetMs: 1_000 })).toEqual(['continued', 'continued', 'continued', 'waiting']);
    expect((await w.record())?.estimate).toMatchObject({ documents: 4, pages: 4, ocrPages: 1, unreadable: 1 });
  });

  it('starts once per run: a re-load keeps it, and only a cancelled one starts again', async () => {
    const w = world();
    await estimated(w);
    expect(await startEnrichment(w.db, w.ports, w.clock, ORG, RUN)).toBe(false);
    await w.db.doc(enrichmentPath(ORG, RUN)).update({ status: 'cancelled', seq: 2 });
    expect(await startEnrichment(w.db, w.ports, w.clock, ORG, RUN)).toBe(true);
    expect(await w.record()).toMatchObject({ status: 'estimating', seq: 3 });
  });
});

describe('approval', () => {
  it('needs clerk.configure, an allowance above the spend, and Clerk on', async () => {
    const w = world();
    await estimated(w);
    expect((await failure(w.decide({ decision: 'approve', allowanceCents: 500 }, 'lawyer'))).code).toBe(
      'permission-denied',
    );
    expect((await failure(w.decide({ decision: 'approve', allowanceCents: 5 }))).code).toBe('invalid-argument');

    await w.db.doc(`orgs/${ORG}`).update({ 'settings.clerk.features': { suggestions: false } });
    clearFlagCaches();
    const off = await failure(w.decide({ decision: 'approve', allowanceCents: 500 }));
    expect(off.code).toBe('failed-precondition');
    expect((await w.record())?.status).toBe('awaiting_approval');
  });

  it('declines for now, then approves later; both audited', async () => {
    const w = world();
    await estimated(w);
    expect(await w.decide({ decision: 'decline' })).toEqual({ status: 'declined' });
    expect(await w.record()).toMatchObject({ status: 'declined', seq: 2 });
    expect((await failure(w.decide({ decision: 'decline' }))).code).toBe('failed-precondition');

    expect(await w.decide({ decision: 'approve', allowanceCents: 2_500 }, 'admin')).toEqual({ status: 'running' });
    expect(await w.record()).toMatchObject({ status: 'running', seq: 3, allowanceCents: 2_500, approvedBy: 'u-admin' });
    expect(w.tasks.queued.at(-1)).toMatchObject({ queue: ENRICH_QUEUE, payload: { orgId: ORG, runId: RUN, seq: 3 } });

    const audits = w.under(`orgs/${ORG}/audit`).map((a) => a['action']);
    expect(audits).toEqual(expect.arrayContaining(['migration.enrichment_declined', 'migration.enrichment_approved']));
    // Nothing is counted twice: a second approval of a running reading is refused.
    expect((await failure(w.decide({ decision: 'approve', allowanceCents: 2_500 }))).code).toBe('failed-precondition');
  });
});

describe('reading the run', () => {
  it('reads every document, lists the unreadable one, proposes the key dates with citations, and tells the approver', async () => {
    const w = world();
    await estimated(w);
    const asked = w.notifications().length;
    await w.decide({ decision: 'approve', allowanceCents: 2_500 });
    const outcomes = await w.drain();
    expect(outcomes.at(-1)).toBe('done');

    const r = await w.record();
    expect(r).toMatchObject({
      status: 'done',
      unreadable: 1,
      progress: { read: 3, skipped: 1, failed: 0, mattersRead: 1, events: 3 },
    });
    expect(r?.spentMicros).toBeGreaterThan(0);
    // OCR for the scan, classification for each readable document, one key-dates call.
    expect(outputNames(w).filter((n) => n === 'eventsFromFile')).toHaveLength(1);
    expect(outputNames(w)).toContain('ocrPage');

    // The encrypted file is listed for the migration review queue (MIG-08).
    expect(w.doc(`${M}/${ESTATE}/documents/d-3-locked`)?.['needsReview']).toEqual([MIG_W_DOCUMENT_UNREADABLE]);
    expect(w.doc(`${M}/${ESTATE}/documents/d-1-letter`)?.['needsReview']).toBeUndefined();
    expect(w.doc(`${M}/${ESTATE}/documents/d-1-letter`)?.['ingest']).toMatchObject({ status: 'done', pages: 2 });

    const events = w.suggestions().filter((s) => s['kind'] === 'event');
    const byKind = Object.fromEntries(events.map((s) => [(s['payload'] as Data)['kind'], s]));
    expect(Object.keys(byKind).sort()).toEqual(['date_of_death', 'grant_issued', 'notice_published']);
    expect(byKind['date_of_death']).toMatchObject({
      status: 'proposed',
      payload: { kind: 'date_of_death', date: '2024-03-12', sourceDocumentId: 'd-1-letter' },
      citations: [{ kind: 'document', documentId: 'd-1-letter', docVersion: 1, page: 1 }],
      promptId: 'events-from-file',
      promptVersion: '1.0.0',
    });
    expect(byKind['notice_published']).toMatchObject({
      payload: { kind: 'notice_published', date: '2024-05-02' },
      citations: [{ kind: 'document', documentId: 'd-1-letter', page: 2 }],
    });
    expect(byKind['grant_issued']).toMatchObject({
      payload: { kind: 'grant_issued', date: '2024-09-03' },
      citations: [{ kind: 'record', recordRef: { collection: 'notes', id: 'n-call' }, quote: NOTE.split('. ')[1] }],
    });
    // No key dates on the closed matter; no per-document "Clerk has suggestions" notifications.
    expect(w.suggestions(CLOSED).filter((s) => s['kind'] === 'event')).toEqual([]);
    expect(w.notifications().filter((n) => n['kind'] === 'suggestion')).toEqual([]);

    const waiting = w.under(`${M}/${ESTATE}/suggestions`).length + w.suggestions(CLOSED).length;
    expect(r?.suggestionsWaiting).toBe(waiting);
    const done = w.notifications().slice(asked);
    expect(done.map((n) => n['recipientUid']).sort()).toEqual(['u-admin', 'u-owner']);
    expect(done[0]).toMatchObject({ title: 'Clerk has read the migrated files', link: '/inbox' });
    expect(done[0]?.['body']).toBe(
      `3 documents read and 3 key dates found: ${waiting} suggestions are waiting for review. ` +
        '1 document couldn’t be read and is listed for migration review.',
    );
  });

  it('an accepted key date records the event, whose deadlines are computed, past ones flagged', async () => {
    const w = world();
    await estimated(w);
    await w.decide({ decision: 'approve', allowanceCents: 2_500 });
    await w.drain();
    const death = w
      .suggestions()
      .find((s) => s['kind'] === 'event' && (s['payload'] as Data)['kind'] === 'date_of_death');
    const accepted = await w.call<{ resultRef: string }>(
      acceptDefinition,
      { matterId: ESTATE, suggestionId: death?.id },
      'lawyer',
    );
    expect(w.doc(accepted.resultRef)).toMatchObject({ kind: 'date_of_death', date: '2024-03-12' });
    const deadlines = w.under(`${M}/${ESTATE}/deadlines`);
    expect(deadlines.length).toBeGreaterThan(0);
    // Dated from March 2024, they were all past when computed in October 2026.
    const dated = deadlines.filter((d) => typeof d['dueDate'] === 'string');
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.every((d) => d['pastOnCreation'] === true)).toBe(true);
    expect(w.doc(`${M}/${ESTATE}`)?.['recomputeVersion']).toBe(1);
  });

  it('pauses when the allowance is used and resumes where it stopped', async () => {
    const w = world();
    await estimated(w);
    // A micro-dollar short of the allowance: the next call is made and takes it over; the one after isn't.
    await w.decide({ decision: 'approve', allowanceCents: 100 });
    await w.db.doc(enrichmentPath(ORG, RUN)).update({ spentMicros: 999_999 });
    expect(await w.drain()).toEqual(['paused']);
    const paused = await w.record();
    expect(paused).toMatchObject({ status: 'paused', pausedFor: 'allowance' });
    expect(paused?.cursor).toBe(1);
    expect(w.notifications().at(-1)).toMatchObject({ title: 'Clerk stopped reading the migrated files' });
    expect(String(w.notifications().at(-1)?.['body'])).toContain('it used the allowance you approved');

    // Resuming needs more than it spent.
    expect((await failure(w.decide({ decision: 'approve', allowanceCents: 100 }))).code).toBe('invalid-argument');
    await w.decide({ decision: 'approve', allowanceCents: 5_000 });
    expect((await w.record())?.pausedFor).toBeUndefined();
    expect((await w.drain()).at(-1)).toBe('done');
    expect(await w.record()).toMatchObject({ status: 'done', progress: { read: 3, mattersRead: 1 } });
  });

  it('pauses when the org’s month is nearly used, leaving the rest for people', async () => {
    const w = world({ clerk: { monthlyTokenBudget: 1_000_000 } });
    await estimated(w);
    await w.db.doc(`orgs/${ORG}/metrics/clerk-2026-10`).set({ values: { tokens: 800_000, costMicros: 0 } });
    await w.decide({ decision: 'approve', allowanceCents: 2_500 });
    expect(await w.drain()).toEqual(['paused']);
    expect(await w.record()).toMatchObject({ status: 'paused', pausedFor: 'budget', cursor: 0 });
    expect(w.model.requests).toEqual([]);
  });

  it('pauses when Clerk is switched off for the org', async () => {
    const w = world();
    await estimated(w);
    await w.decide({ decision: 'approve', allowanceCents: 2_500 });
    w.keyring.key = { state: 'missing' };
    expect(await w.drain()).toEqual(['paused']);
    expect(await w.record()).toMatchObject({ status: 'paused', pausedFor: 'clerk_off' });
  });

  it('retries a failing document, then marks it failed and lists it for review', async () => {
    const w = world();
    await estimated(w);
    await w.decide({ decision: 'approve', allowanceCents: 2_500 });
    // The closed matter's file (first in the list) can't be read from storage.
    w.files.put(`${M}/${CLOSED}/documents/d-5-closed/v1`, Buffer.from('not a pdf'));
    const read = w.files.read.bind(w.files);
    w.files.read = async (path: string) => {
      if (path.includes('d-5-closed')) throw new Error('storage unavailable');
      return read(path);
    };
    const outcomes = await w.drain();
    expect(outcomes.slice(0, 3)).toEqual(['continued', 'continued', 'continued']);
    expect(outcomes.at(-1)).toBe('done');
    expect(w.doc(`${M}/${CLOSED}/documents/d-5-closed`)?.['ingest']).toMatchObject({ status: 'failed' });
    expect(w.doc(`${M}/${CLOSED}/documents/d-5-closed`)?.['needsReview']).toEqual([MIG_W_DOCUMENT_UNREADABLE]);
    expect(await w.record()).toMatchObject({ unreadable: 2, progress: { failed: 1, read: 2 } });
    // Each retry waited before it ran.
    const retries = w.tasks.queued.filter((t) => t.options.scheduleTime);
    expect(retries).toHaveLength(2);
  });

  it('a stale or duplicate step changes nothing, and a lost hand-over is queued again', async () => {
    const w = world();
    await estimated(w);
    const deps = w.deps();
    expect(await runEnrichmentStep({ orgId: ORG, runId: RUN, seq: 0 }, deps)).toBe('stale');
    expect(await runEnrichmentStep({ orgId: ORG, runId: 'run-none', seq: 0 }, deps)).toBe('stale');
    // Waiting for approval: a step with its seq does nothing either.
    expect(await runEnrichmentStep({ orgId: ORG, runId: RUN, seq: 1 }, deps)).toBe('stale');

    await w.decide({ decision: 'approve', allowanceCents: 2_500 });
    const queued = w.tasks.queued.length;
    // Step 1 is retried after the approval moved the record to seq 2: it re-queues step 2 (deduped).
    expect(await runEnrichmentStep({ orgId: ORG, runId: RUN, seq: 1 }, deps)).toBe('stale');
    expect(w.tasks.queued.slice(queued)).toEqual([
      expect.objectContaining({
        payload: { orgId: ORG, runId: RUN, seq: 2 },
        options: { dedupeKey: `enrich#${ORG}#${RUN}#2` },
      }),
    ]);
  });
});

describe('migration-onRunWrite', () => {
  const ctx = (w: World): TriggerContext =>
    ({
      eventId: 'e1',
      time: NOW.toISOString(),
      params: { orgId: ORG, runId: RUN },
      log: createLog({ fn: 'test' }, () => undefined),
      clock: w.clock,
      db: w.db,
      ports: w.ports,
    }) as unknown as TriggerContext;
  const change = (before: Data | undefined, after: Data | undefined): TriggerChange =>
    ({
      before: before ? { exists: true, data: () => before } : undefined,
      after: after ? { exists: true, data: () => after } : undefined,
    }) as unknown as TriggerChange;

  it('starts on success, cancels on a rollback, and goes with the run record', async () => {
    const w = world();
    await onRunWriteHandler(change({ status: 'running' }, { status: 'running' }), ctx(w));
    expect(await w.record()).toBeNull();
    await onRunWriteHandler(change({ status: 'running' }, { status: 'succeeded' }), ctx(w));
    expect(await w.record()).toMatchObject({ status: 'estimating', seq: 0 });
    expect(w.tasks.queued).toHaveLength(1);
    // A later write to a succeeded run (its counts) doesn't start another.
    await onRunWriteHandler(change({ status: 'succeeded' }, { status: 'succeeded' }), ctx(w));
    expect(w.tasks.queued).toHaveLength(1);

    await onRunWriteHandler(change({ status: 'succeeded' }, { status: 'rolling_back' }), ctx(w));
    expect(await w.record()).toMatchObject({ status: 'cancelled', seq: 1 });
    // The step queued before the rollback finds it cancelled.
    expect(await w.drain()).toEqual(['stale']);

    await onRunWriteHandler(change({ status: 'rolled_back' }, undefined), ctx(w));
    expect(w.doc(enrichmentPath(ORG, RUN))).toBeUndefined();
  });
});

describe('key dates (events.ts)', () => {
  const manifest = (extra: Partial<ContextManifest> = {}) =>
    ({
      privileged: false,
      records: [{ kind: 'note', id: 'n-call' }],
      documents: [],
      chunks: [{ documentId: 'd-1-letter', version: 1, page: 1 }],
      ...extra,
    }) as unknown as ContextManifest;
  const pages = {
    pages: async () => [
      { page: 1, text: LETTER[0] ?? '' },
      { page: 2, text: LETTER[1] ?? '' },
    ],
  };
  const event = (extra: Data) => ({
    kind: 'date_of_death',
    date: '2024-03-12',
    rationale: 'The letter says so.',
    citations: [
      { source: 'excerpt', id: 'd-1-letter', page: 1, quote: 'Elsie Fictional died on 12 March 2024 at Geelong.' },
    ],
    ...extra,
  });

  it('keeps only quotes found where they are cited that state the date, and fills gaps only', async () => {
    const w = world();
    const propose = (events: Data[], recorded: string[] = []) =>
      toProposals({ db: w.db, text: pages }, ORG, ESTATE, events as never, {
        manifest: manifest(),
        recorded: new Set(recorded),
        today: '2026-10-07',
      });

    const [kept] = await propose([event({})]);
    expect(kept).toMatchObject({
      kind: 'event',
      payload: { kind: 'date_of_death', date: '2024-03-12', sourceDocumentId: 'd-1-letter' },
      dedupeKey: 'event#migration#date_of_death#2024-03-12',
    });
    // A quote not on its page, one that doesn't state the date, a page the context didn't read.
    expect(
      await propose([
        event({
          citations: [
            {
              source: 'excerpt',
              id: 'd-1-letter',
              page: 2,
              quote: 'Elsie Fictional died on 12 March 2024 at Geelong.',
            },
          ],
        }),
      ]),
    ).toEqual([]);
    expect(await propose([event({ date: '2024-03-13' })])).toEqual([]);
    expect(
      await propose([
        event({ citations: [{ source: 'excerpt', id: 'd-9', page: 1, quote: 'died on 12 March 2024' }] }),
      ]),
    ).toEqual([]);
    // The note's quote, checked against the note itself.
    expect(
      await propose([
        event({
          kind: 'grant_issued',
          date: '2024-09-03',
          citations: [{ source: 'note', id: 'n-call', quote: 'Probate was granted on 3 September 2024' }],
        }),
      ]),
    ).toHaveLength(1);
    expect(
      await propose([
        event({
          kind: 'grant_issued',
          date: '2024-09-03',
          citations: [{ source: 'note', id: 'n-other', quote: 'Probate was granted on 3 September 2024' }],
        }),
      ]),
    ).toEqual([]);
    // Already recorded, given twice, in the future, or custom without a label: left out.
    expect(await propose([event({})], ['date_of_death'])).toEqual([]);
    expect(await propose([event({}), event({})])).toEqual([]);
    expect(
      await propose([
        event({
          date: '2026-12-01',
          citations: [{ source: 'excerpt', id: 'd-1-letter', page: 1, quote: 'died on 1 December 2026' }],
        }),
      ]),
    ).toEqual([]);
    expect(await propose([event({ kind: 'custom' })])).toEqual([]);
    const [custom] = await propose([event({ kind: 'custom', label: 'Funeral' })]);
    expect(custom).toMatchObject({
      payload: { kind: 'custom', label: 'Funeral' },
      dedupeKey: 'event#migration#custom#2024-03-12#funeral',
    });
  });

  it('the fake model cites each sentence that dates an estate step, verbatim', () => {
    const request = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `<matter_note id="n-call" written="2026-10-07">\n${NOTE}\n</matter_note>` },
            {
              type: 'search_result',
              text: `<excerpt document="d-1-letter" version="1" page="1">\n${LETTER[0]}\n</excerpt>`,
            },
          ],
        },
      ],
      output: { name: 'eventsFromFile' },
    } as unknown as ClerkModelRequest;
    const reply = JSON.parse(eventsStep(request).chunks?.[0] ?? '{}') as { events: Data[] };
    expect(reply.events).toEqual([
      expect.objectContaining({
        kind: 'grant_issued',
        date: '2024-09-03',
        citations: [
          { source: 'note', id: 'n-call', quote: 'Probate was granted on 3 September 2024 by the Supreme Court.' },
        ],
      }),
      expect.objectContaining({
        kind: 'date_of_death',
        date: '2024-03-12',
        citations: [
          {
            source: 'excerpt',
            id: 'd-1-letter',
            page: 1,
            quote: 'Your mother Elsie Fictional died on 12 March 2024 at Geelong.',
          },
        ],
      }),
    ]);
  });
});

describe('the meter', () => {
  it('says which errors pause the run', () => {
    expect(pauseReason(new DomainError('CLERK_BUDGET_EXCEEDED', 'x'))).toBe('budget');
    expect(pauseReason(new DomainError('CLERK_KEY_INVALID', 'x'))).toBe('clerk_off');
    expect(pauseReason(new DomainError('CLERK_DISABLED', 'x', { switch: 'clerk.enabled' }))).toBe('clerk_off');
    expect(pauseReason(new DomainError('CLERK_DISABLED', 'x', { switch: 'org.byok.missing' }))).toBe('clerk_off');
    // OCR or classification switched off on their own don't stop it.
    expect(pauseReason(new DomainError('CLERK_DISABLED', 'x', { switch: 'clerk.features.classification' }))).toBeNull();
    expect(pauseReason(new IngestInterrupted('allowance'))).toBe('allowance');
    expect(pauseReason(new Error('boom'))).toBeNull();
  });

  it('counts each call and makes none past the allowance', async () => {
    const calls: number[] = [];
    const inner = {
      run: async () => {
        calls.push(1);
        return { costMicros: 600_000 };
      },
      assertOn: async () => ({}),
    } as unknown as ClerkGateway;
    const metered = meteredGateway(inner, { spentMicros: 0, allowanceMicros: 1_000_000 });
    await metered.run({} as never);
    await metered.run({} as never);
    expect(metered.spentMicros()).toBe(1_200_000);
    await expect(metered.run({} as never)).rejects.toBeInstanceOf(IngestInterrupted);
    expect(calls).toHaveLength(2);

    const failing = meteredGateway(
      {
        ...inner,
        run: async () => Promise.reject(new DomainError('CLERK_BUDGET_EXCEEDED', 'x')),
      } as unknown as ClerkGateway,
      { spentMicros: 0, allowanceMicros: 1_000_000 },
    );
    await expect(failing.run({} as never)).rejects.toMatchObject({ reason: 'budget' });
  });

  it('reads the org’s month: tokens, or spend when it has a limit', async () => {
    const w = world({ clerk: { monthlyBudgetCents: 10_000 } });
    expect(await orgBudgetNearlyUsed(w.db, ORG, NOW)).toBe(false);
    await w.db.doc(`orgs/${ORG}/metrics/clerk-2026-10`).set({ values: { tokens: 10, costMicros: 80_000_000 } });
    expect(await orgBudgetNearlyUsed(w.db, ORG, NOW)).toBe(true);
  });

  it('enqueues a step once per seq', async () => {
    const tasks = new FakeTaskQueue();
    await enqueueStep({ ports: fakePorts({ tasks }) }, { orgId: ORG, runId: RUN, seq: 4 }, 60_000);
    expect(tasks.queued[0]).toMatchObject({ queue: ENRICH_QUEUE, options: { dedupeKey: `enrich#${ORG}#${RUN}#4` } });
    expect(tasks.queued[0]?.options.scheduleTime).toBeInstanceOf(Date);
  });
});
