import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import type { FlagKey } from '@materia/domain';

import { DEFAULT_OCR_DAILY_PAGES, nextBudgetDay, reserveOcrPages } from './budget';
import { chunkId } from './chunks';
import { gatewayIngestClerk, OcrUnavailableError, type IngestClerk } from './clerk';
import { backfillIngest, needsIngest, onIngestChangeHandler } from './index';
import { detectLanguage } from './language';
import {
  CHECKPOINT_PAGES,
  INGEST_QUEUE,
  ingestDocument,
  ingestErrorLabel,
  markIngestFailed,
  type IngestTask,
} from './pipeline';
import { chunkSearch, clampK, FakeChunkSearch } from './search';
import { sampleDocx, samplePng, textPdf } from './testing';
import { createClerkGateway } from '../../clerk/gateway';
import { FakeClerkModel } from '../../clerk/providers/fake';
import { MemoryClerkStore, MemoryKeyring } from '../../clerk/testing';
import { createLog } from '../../core/log';
import type { TriggerContext } from '../../core/trigger';
import { memoryFirestore } from '../../orgs/testing';
import type { ClerkModelRequest, Ports } from '../../ports';
import { FakeClock, fakeEmbedding, fakePorts, FakeTaskQueue } from '../../ports/fakes';
import { MemoryFiles, sampleEml, samplePdf } from '../testing';

/**
 * AI-04 ingestion with fake ports: extraction of each fixture type (text, scanned, mixed and
 * encrypted PDFs, DOCX, EML), OCR through the Clerk gateway, the daily OCR budget, checkpoints,
 * idempotency, re-ingest on a new version, the trigger (queueing, privileged propagation, the
 * delete cascade), vector search recall and the backfill. Every person and document is fictional.
 */

const ORG = 'org-a';
const MATTER = `orgs/${ORG}/matters/m1`;
const FIXTURES = path.resolve(__dirname, '../../../../../libs/test-utils/fixtures/pdfs');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

type Data = Record<string, unknown>;

const SCANNED: Record<number, string> = {
  1: 'Statutory declaration of Rowan Example (fictional), handwritten, about the missing original will.',
  2: 'Declared at Geelong before a justice of the peace, fictional witness Kit Placeholder.',
  3: 'Annexure A: a fictional photocopy of the will dated 3 May 2019.',
};

/** The fake model: OCR returns the scripted text for the page asked for; classification a fixed filing. */
function scriptedModel(options: { lowConfidencePages?: number[]; language?: string } = {}) {
  return new FakeClerkModel([], (request: ClerkModelRequest) => {
    const blocks = request.messages[0]?.content as { type: string; text?: string }[];
    const question = blocks.find((b) => b.type === 'text')?.text ?? '';
    if (request.output?.name === 'ocrPage') {
      const page = Number(/page (\d+)/.exec(question)?.[1] ?? 1);
      return {
        chunks: [
          JSON.stringify({
            text: SCANNED[page] ?? `Fictional scanned page ${page}.`,
            lowConfidence: options.lowConfidencePages?.includes(page) ?? false,
            language: options.language ?? 'en',
          }),
        ],
      };
    }
    return {
      chunks: [
        JSON.stringify({
          category: 'will',
          suggestedTitle: 'Will of Margaret Anne Doyle (3 May 2019)',
          documentDate: '2019-05-03',
          parties: ['Margaret Anne Doyle', 'Catherine Doyle'],
          language: 'en',
        }),
      ],
    };
  });
}

interface WorldOptions {
  flags?: Partial<Record<FlagKey, boolean>>;
  ocrDailyPages?: number;
  model?: FakeClerkModel;
}

function world(options: WorldOptions = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Harbour & Vine Legal (fictional)',
      ...(options.ocrDailyPages !== undefined ? { settings: { clerk: { ocrDailyPages: options.ocrDailyPages } } } : {}),
    },
    [MATTER]: { title: 'Estate of Margaret Doyle (fictional)', privileged: false, deletedAt: null },
  });
  const db = store.db;
  const files = new MemoryFiles();
  const clock = new FakeClock(new Date('2026-10-05T01:00:00.000Z'));
  const tasks = new FakeTaskQueue();
  const logs: { message: string; entry: Data }[] = [];
  const log = createLog({ fn: 'test' }, (_s, message, entry) => void logs.push({ message, entry }));
  const flags = options.flags ?? { 'clerk.enabled': true, 'clerk.features.classification': true };
  const model = options.model ?? scriptedModel();
  const gateway = createClerkGateway({
    model,
    store: new MemoryClerkStore(),
    keyring: new MemoryKeyring(),
    flag: async (_org, key) => flags[key] ?? false,
    sleep: async () => undefined,
  });
  const clerk = gatewayIngestClerk(gateway, (orgId) => ({
    orgId,
    uid: 'system',
    role: 'admin',
    requestId: 'ingest-test',
    log,
    clock,
  }));
  let elapsed = 0;
  const deps = (over: { clerk?: IngestClerk; timeBudgetMs?: number } = {}) => ({
    db,
    files,
    embedding: fakeEmbedding,
    clerk: over.clerk ?? clerk,
    tasks,
    clock,
    log,
    ...(over.timeBudgetMs !== undefined ? { timeBudgetMs: over.timeBudgetMs, now: () => (elapsed += 1000) } : {}),
  });

  /** Stores a clean version of a document, as the upload pipeline leaves it. */
  async function addDocument(
    docId: string,
    fileName: string,
    data: Buffer,
    extra: Data = {},
    version = 1,
  ): Promise<IngestTask> {
    const storagePath = `${MATTER}/documents/${docId}/v${version}`;
    files.put(storagePath, data);
    const ref = db.doc(`${MATTER}/documents/${docId}`);
    const existing = (await ref.get()).data();
    const entry = {
      version,
      storagePath,
      fileName,
      mime: 'application/octet-stream',
      sizeBytes: data.length,
      sha256: 'a'.repeat(64),
      uploadedAt: clock.now(),
      uploadedBy: 'user-lawyer',
      ...(extra['encrypted'] ? { encrypted: true } : {}),
    };
    await ref.set({
      ...existing,
      orgId: ORG,
      matterId: 'm1',
      name: fileName,
      category: 'other',
      privileged: false,
      deletedAt: null,
      scan: { status: 'clean' },
      ingest: { status: 'pending' },
      encrypted: false,
      versions: [...((existing?.['versions'] as Data[]) ?? []), entry],
      storagePath,
      ...extra,
      version,
    });
    return { orgId: ORG, matterId: 'm1', docId, version };
  }

  const docData = async (docId: string) => (await db.doc(`${MATTER}/documents/${docId}`).get()).data() as Data;
  const chunks = async (docId: string) => {
    const snap = await db.collection(`${MATTER}/documents/${docId}/chunks`).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Data) }) as Data & { id: string });
  };
  const suggestions = async () => (await db.collection(`${MATTER}/suggestions`).get()).docs.map((d) => d.data());

  return { db, files, clock, tasks, logs, model, deps, addDocument, docData, chunks, suggestions, flags };
}

const ingestOf = (doc: Data) => doc['ingest'] as Data;

describe('ingestDocument', () => {
  it('ingests a text PDF: one chunk per page here, with provenance, embeddings and a classification suggestion', async () => {
    const w = world();
    const task = await w.addDocument('d-will', 'Will.pdf', fixture('will.pdf'));
    await expect(ingestDocument(task, w.deps())).resolves.toBe('done');

    const ingest = ingestOf(await w.docData('d-will'));
    expect(ingest).toMatchObject({ status: 'done', version: 1, pages: 2, ocrPages: 0, chunks: 2, ocr: false });
    expect(ingest['chars']).toBeGreaterThan(500);
    expect(ingest).not.toHaveProperty('checkpoint');
    expect(ingest).not.toHaveProperty('language');

    const stored = await w.chunks('d-will');
    expect(stored.map((c) => c.id)).toEqual([chunkId(1, 0), chunkId(1, 1)]);
    expect(stored[0]).toMatchObject({
      orgId: ORG,
      matterId: 'm1',
      page: 1,
      docVersion: 1,
      ordinal: 0,
      privileged: false,
    });
    expect(String(stored[0]?.['text'])).toContain('I appoint my daughter Catherine Doyle');
    expect(String(stored[1]?.['text'])).toContain('governed by the law of Victoria');
    expect((stored[0]?.['embedding'] as { toArray(): number[] }).toArray()).toHaveLength(768);

    // No OCR was needed; classification ran once, at low effort, and became a suggestion.
    expect(w.model.requests.map((r) => r.output?.name)).toEqual(['documentClassification']);
    expect(w.model.requests[0]?.effort).toBe('low');
    expect(await w.suggestions()).toEqual([
      expect.objectContaining({
        kind: 'document_meta',
        status: 'proposed',
        payload: {
          documentId: 'd-will',
          category: 'will',
          title: 'Will of Margaret Anne Doyle (3 May 2019)',
          date: '2019-05-03',
          parties: ['Margaret Anne Doyle', 'Catherine Doyle'],
        },
        promptId: 'classify-document',
        promptVersion: '1.0.0',
        dedupeKey: 'document_meta#d-will#v1',
      }),
    ]);
    // The document's own name and category are untouched (Clerk proposes, never commits).
    expect(await w.docData('d-will')).toMatchObject({ name: 'Will.pdf', category: 'other' });
  });

  it('OCRs a scanned PDF page by page through the gateway, flagging low-confidence pages', async () => {
    const w = world({ model: scriptedModel({ lowConfidencePages: [1] }) });
    const task = await w.addDocument('d-scan', 'Declaration.pdf', await textPdf([null, null]));
    await expect(ingestDocument(task, w.deps())).resolves.toBe('done');

    expect(ingestOf(await w.docData('d-scan'))).toMatchObject({
      status: 'done',
      pages: 2,
      ocrPages: 2,
      ocr: true,
      chunks: 2,
      lowConfidencePages: [1],
    });
    const stored = await w.chunks('d-scan');
    expect(stored.map((c) => [c['page'], c['ocr'], c['text']])).toEqual([
      [1, true, SCANNED[1]],
      [2, true, SCANNED[2]],
    ]);
    const ocrCalls = w.model.requests.filter((r) => r.output?.name === 'ocrPage');
    expect(ocrCalls).toHaveLength(2);
    // Each call carries a one-page PDF, at low effort, with no citations (structured output).
    const block = (
      ocrCalls[0]?.messages[0]?.content as { type: string; source?: { kind: string; base64: string } }[]
    )[0];
    expect(block?.type).toBe('document');
    expect(block?.source?.kind).toBe('pdf');
    expect(
      Buffer.from(block?.source?.base64 ?? '', 'base64')
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    expect(ocrCalls[0]?.effort).toBe('low');
  });

  it('OCRs only the scanned pages of a mixed PDF', async () => {
    const w = world();
    const task = await w.addDocument(
      'd-mixed',
      'Affidavit.pdf',
      await textPdf([
        'Affidavit of Peter Hale (fictional) sworn about the estate accounts.',
        null,
        'Exhibit list: fictional bank statements PH-1 to PH-4.',
      ]),
    );
    await ingestDocument(task, w.deps());
    expect(ingestOf(await w.docData('d-mixed'))).toMatchObject({ status: 'done', pages: 3, ocrPages: 1, chunks: 3 });
    expect((await w.chunks('d-mixed')).map((c) => [c['page'], c['ocr'] ?? false])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it('skips a password-protected PDF (reason encrypted) and stores no chunks', async () => {
    const w = world();
    const task = await w.addDocument('d-locked', 'Locked.pdf', await samplePdf({ encrypted: true }), {
      encrypted: true,
    });
    await expect(ingestDocument(task, w.deps())).resolves.toBe('skipped');
    expect(ingestOf(await w.docData('d-locked'))).toMatchObject({ status: 'skipped', reason: 'encrypted', version: 1 });
    expect(await w.chunks('d-locked')).toEqual([]);
    expect(w.model.requests).toEqual([]);
  });

  it('reads a DOCX as paragraph pseudo-pages', async () => {
    const w = world();
    const paragraph = (n: number) =>
      `Paragraph ${n}. The fictional executor Peter Hale reports on the sale of 1 Example Street, Geelong, ` +
      'and the distribution of the residue. '.repeat(8);
    const task = await w.addDocument(
      'd-docx',
      'Executor report.docx',
      sampleDocx(Array.from({ length: 12 }, (_, i) => paragraph(i + 1))),
    );
    await ingestDocument(task, w.deps());
    const ingest = ingestOf(await w.docData('d-docx'));
    expect(ingest['status']).toBe('done');
    expect(ingest['pages']).toBeGreaterThan(1);
    const stored = await w.chunks('d-docx');
    expect(stored[0]?.['text']).toMatch(/^Paragraph 1\./);
    expect(new Set(stored.map((c) => c['page'])).size).toBe(ingest['pages']);
  });

  it('reads an email as headers and body; its attachments are separate documents', async () => {
    const w = world();
    const task = await w.addDocument(
      'd-eml',
      'Valuation.eml',
      sampleEml({ subject: 'Fictional valuation of 1 Example Street', text: 'The property is valued at $850,000.' }),
    );
    await ingestDocument(task, w.deps());
    expect(ingestOf(await w.docData('d-eml'))).toMatchObject({ status: 'done', pages: 1, chunks: 1 });
    const [chunk] = await w.chunks('d-eml');
    expect(chunk?.['text']).toContain('Subject: Fictional valuation of 1 Example Street');
    expect(chunk?.['text']).toContain('From: Rowan Example <rowan@example.test>');
    expect(chunk?.['text']).toContain('Attachments: Inventory of assets.txt');
    expect(chunk?.['text']).toContain('valued at $850,000');
    expect(chunk?.['text']).not.toContain('one bicycle');
  });

  it('OCRs a photo as one page', async () => {
    const w = world();
    const task = await w.addDocument('d-photo', 'Photo.png', samplePng());
    await ingestDocument(task, w.deps());
    expect(ingestOf(await w.docData('d-photo'))).toMatchObject({ status: 'done', pages: 1, ocrPages: 1 });
  });

  it('skips types Clerk does not read', async () => {
    const w = world();
    const task = await w.addDocument('d-xlsx', 'Ledger.xlsx', Buffer.from('PK fictional'));
    await expect(ingestDocument(task, w.deps())).resolves.toBe('skipped');
    expect(ingestOf(await w.docData('d-xlsx'))).toMatchObject({ status: 'skipped', reason: 'unsupported' });
  });

  it('skips a damaged PDF', async () => {
    const w = world();
    const task = await w.addDocument('d-bad', 'Bad.pdf', Buffer.from('%PDF-1.7 not really a pdf'));
    await ingestDocument(task, w.deps());
    expect(ingestOf(await w.docData('d-bad'))).toMatchObject({ status: 'skipped' });
  });

  it('without Clerk: a scanned PDF is skipped (ocr_unavailable); a mixed one keeps its text pages; no budget is used', async () => {
    const w = world({ flags: {} });
    const scanned = await w.addDocument('d-scan', 'Scan.pdf', await textPdf([null, null]));
    await expect(ingestDocument(scanned, w.deps())).resolves.toBe('skipped');
    expect(ingestOf(await w.docData('d-scan'))).toMatchObject({ status: 'skipped', reason: 'ocr_unavailable' });

    const mixed = await w.addDocument('d-mixed', 'Mixed.pdf', await textPdf(['A fictional typed letter page.', null]));
    await expect(ingestDocument(mixed, w.deps())).resolves.toBe('done');
    expect(ingestOf(await w.docData('d-mixed'))).toMatchObject({ status: 'done', chunks: 1, ocrUnavailablePages: 1 });
    expect(await w.suggestions()).toEqual([]);
    // Reserved pages were given back.
    expect(await reserveOcrPages(w.db, ORG, 1000, w.clock.now())).toBe(DEFAULT_OCR_DAILY_PAGES);
  });

  it('enforces the daily OCR budget: queues the rest for tomorrow ("Queued") and resumes there', async () => {
    const w = world({ ocrDailyPages: 1 });
    const task = await w.addDocument('d-scan', 'Scan.pdf', await textPdf([null, null, null]));
    await expect(ingestDocument(task, w.deps())).resolves.toBe('queued');

    const queued = ingestOf(await w.docData('d-scan'));
    expect(queued).toMatchObject({
      status: 'queued',
      ocrPages: 1,
      chunks: 1,
      checkpoint: { nextPage: 2, nextOrdinal: 1 },
    });
    const until = nextBudgetDay(w.clock.now());
    expect(w.tasks.queued).toEqual([
      expect.objectContaining({
        queue: INGEST_QUEUE,
        payload: task,
        options: expect.objectContaining({ scheduleTime: until }),
      }),
    ]);
    expect(w.model.requests.filter((r) => r.output?.name === 'ocrPage')).toHaveLength(1);

    // Still today: the budget is spent, so nothing more is read.
    await expect(ingestDocument(task, w.deps())).resolves.toBe('queued');
    expect(w.model.requests.filter((r) => r.output?.name === 'ocrPage')).toHaveLength(1);

    // Tomorrow and the day after: one page each, then done.
    w.clock.set(until);
    await expect(ingestDocument(task, w.deps())).resolves.toBe('queued');
    w.clock.set(nextBudgetDay(w.clock.now()));
    await expect(ingestDocument(task, w.deps())).resolves.toBe('done');
    expect(ingestOf(await w.docData('d-scan'))).toMatchObject({ status: 'done', ocrPages: 3, chunks: 3 });
    expect(ingestOf(await w.docData('d-scan'))).not.toHaveProperty('queuedUntil');
    expect((await w.chunks('d-scan')).map((c) => c['page'])).toEqual([1, 2, 3]);
  });

  it('nextBudgetDay is just after the next Melbourne midnight (AEDT and AEST)', () => {
    expect(nextBudgetDay(new Date('2026-10-05T01:00:00Z')).toISOString()).toBe('2026-10-05T13:10:00.000Z');
    expect(nextBudgetDay(new Date('2026-06-05T01:00:00Z')).toISOString()).toBe('2026-06-05T14:10:00.000Z');
  });

  it('checkpoints every 50 pages and hands a long PDF over to a continuation task', async () => {
    const w = world({ flags: {} });
    const pages = Array.from(
      { length: 120 },
      (_, i) => `Fictional ledger page ${i + 1}: rates notice and water account.`,
    );
    const task = await w.addDocument('d-long', 'Ledger.pdf', await textPdf(pages));
    // Each batch "takes" a second; the budget allows one batch per invocation.
    await expect(ingestDocument(task, w.deps({ timeBudgetMs: 1500 }))).resolves.toBe('continued');
    expect(ingestOf(await w.docData('d-long'))).toMatchObject({
      status: 'running',
      chunks: CHECKPOINT_PAGES,
      checkpoint: { nextPage: 51, nextOrdinal: 50 },
    });
    expect(w.tasks.queued.at(-1)).toMatchObject({ queue: INGEST_QUEUE, payload: task });
    expect(w.tasks.queued.at(-1)?.options.dedupeKey).toContain('#p51');

    await expect(ingestDocument(task, w.deps({ timeBudgetMs: 1500 }))).resolves.toBe('continued');
    await expect(ingestDocument(task, w.deps())).resolves.toBe('done');
    expect(ingestOf(await w.docData('d-long'))).toMatchObject({ status: 'done', pages: 120, chunks: 120 });
    const stored = await w.chunks('d-long');
    expect(stored.map((c) => c['ordinal'])).toEqual(Array.from({ length: 120 }, (_, i) => i));
    expect(stored.at(-1)).toMatchObject({ page: 120 });
  });

  it('is idempotent by (docId, version): a duplicate delivery does nothing', async () => {
    const w = world();
    const task = await w.addDocument('d-will', 'Will.pdf', fixture('will.pdf'));
    await ingestDocument(task, w.deps());
    const requests = w.model.requests.length;
    await expect(ingestDocument(task, w.deps())).resolves.toBe('already_done');
    expect(w.model.requests).toHaveLength(requests);
    expect(await w.chunks('d-will')).toHaveLength(2);
    expect(await w.suggestions()).toHaveLength(1);
  });

  it('re-ingests a new version and deletes the old version’s chunks; an old task is stale', async () => {
    const w = world();
    const v1 = await w.addDocument('d-order', 'Orders.pdf', fixture('court-order.pdf'));
    await ingestDocument(v1, w.deps());
    const v2 = await w.addDocument('d-order', 'Orders.pdf', fixture('will.pdf'), {}, 2);
    await expect(ingestDocument(v1, w.deps())).resolves.toBe('stale');
    await expect(ingestDocument(v2, w.deps())).resolves.toBe('done');
    const stored = await w.chunks('d-order');
    expect(stored.map((c) => c['docVersion'])).toEqual([2, 2]);
    expect(stored.map((c) => c.id)).toEqual([chunkId(2, 0), chunkId(2, 1)]);
    expect(await w.suggestions()).toHaveLength(2);
  });

  it('flags non-English text', async () => {
    const w = world({ flags: {} });
    const text = Array.from(
      { length: 30 },
      () => 'Testamento ficticio de Lucía Ejemplo, herencia y albacea designado.',
    ).join(' ');
    const task = await w.addDocument('d-es', 'Testamento.pdf', await textPdf([text]));
    await ingestDocument(task, w.deps());
    expect(ingestOf(await w.docData('d-es'))).toMatchObject({ status: 'done', language: 'und' });
    expect(detectLanguage('too short')).toBeNull();
    expect(
      detectLanguage(Array.from({ length: 20 }, () => 'I give the residue of my estate to my daughter').join(' ')),
    ).toBe('en');
  });

  it('takes the OCR model’s language for scanned pages', async () => {
    const w = world({ model: scriptedModel({ language: 'vi' }) });
    const task = await w.addDocument('d-vi', 'Scan.pdf', await textPdf([null]));
    await ingestDocument(task, w.deps());
    expect(ingestOf(await w.docData('d-vi'))).toMatchObject({ language: 'vi' });
  });

  it('retries on a Clerk outage: the error propagates and the budget is refunded', async () => {
    const w = world();
    const failing: IngestClerk = {
      ocr: async () => {
        throw new Error('provider down');
      },
      classify: async () => null,
    };
    const task = await w.addDocument('d-scan', 'Scan.pdf', await textPdf([null, null]));
    await expect(ingestDocument(task, w.deps({ clerk: failing }))).rejects.toThrow('provider down');
    expect(await reserveOcrPages(w.db, ORG, 1000, w.clock.now())).toBe(DEFAULT_OCR_DAILY_PAGES);
    await markIngestFailed(w.db, task, new Error('provider down'), w.clock.now());
    expect(ingestOf(await w.docData('d-scan'))).toMatchObject({ status: 'failed', error: 'Error: provider down' });
    expect(needsIngest(await w.docData('d-scan'))).toBe(false);
  });

  it('treats OcrUnavailableError as Clerk being off', async () => {
    const w = world();
    const off: IngestClerk = {
      ocr: async () => {
        throw new OcrUnavailableError('CLERK_DISABLED');
      },
      classify: async () => null,
    };
    const task = await w.addDocument('d-scan', 'Scan.pdf', await textPdf([null]));
    await expect(ingestDocument(task, w.deps({ clerk: off }))).resolves.toBe('skipped');
  });

  it('ignores removed, unscanned and missing documents', async () => {
    const w = world();
    const task = await w.addDocument('d-gone', 'Will.pdf', fixture('will.pdf'), { deletedAt: new Date() });
    await expect(ingestDocument(task, w.deps())).resolves.toBe('stale');
    await expect(ingestDocument({ ...task, docId: 'nope' }, w.deps())).resolves.toBe('stale');
    const pending = await w.addDocument('d-pending', 'Will.pdf', fixture('will.pdf'), { scan: { status: 'pending' } });
    await expect(ingestDocument(pending, w.deps())).resolves.toBe('stale');
  });
});

/** A trigger context over the world's Firestore and a fake task queue. */
function triggerContext(db: Firestore, eventId: string, docId: string): { ctx: TriggerContext; tasks: FakeTaskQueue } {
  const tasks = new FakeTaskQueue();
  const ports: Ports = fakePorts({ tasks });
  return {
    tasks,
    ctx: {
      eventId,
      time: new Date('2026-10-05T01:00:00Z'),
      params: { orgId: ORG, matterId: 'm1', docId },
      log: createLog({ fn: 'test' }, () => undefined),
      clock: new FakeClock(),
      db,
      ports,
    },
  };
}

describe('documents-onIngestChange', () => {
  async function ingested() {
    const w = world();
    const task = await w.addDocument('d-will', 'Will.pdf', fixture('will.pdf'));
    await ingestDocument(task, w.deps());
    const ref = w.db.doc(`${MATTER}/documents/d-will`);
    return { w, task, ref };
  }

  /** Runs the handler for a write from `before` to the document's current state. */
  async function fire(db: Firestore, docId: string, before: Data | undefined, eventId = 'event-1') {
    const ref = db.doc(`${MATTER}/documents/${docId}`);
    const now = await ref.get();
    const snap = (data: Data | undefined) => (data ? ({ ref, data: () => data, exists: true } as never) : undefined);
    const { ctx, tasks } = triggerContext(db, eventId, docId);
    await onIngestChangeHandler({ before: snap(before), after: now.exists ? snap(now.data()) : undefined }, ctx);
    return tasks;
  }

  it('queues ingestion once when a clean version arrives', async () => {
    const w = world();
    await w.addDocument('d-new', 'Will.pdf', fixture('will.pdf'));
    const before = { ...(await w.docData('d-new')), version: 0, versions: [], scan: { status: 'pending' } };
    const tasks = await fire(w.db, 'd-new', before);
    expect(tasks.queued).toEqual([
      {
        queue: INGEST_QUEUE,
        payload: { orgId: ORG, matterId: 'm1', docId: 'd-new', version: 1 },
        options: { dedupeKey: `ingest#${ORG}#m1#d-new#v1#event-1` },
      },
    ]);
    // A later edit (a rename) while it waits doesn't queue it again.
    const again = await fire(w.db, 'd-new', await w.docData('d-new'), 'event-2');
    expect(again.queued).toEqual([]);
  });

  it('copies a privileged change to every chunk', async () => {
    const { w, ref } = await ingested();
    const before = await w.docData('d-will');
    await ref.update({ privileged: true });
    await fire(w.db, 'd-will', before);
    expect((await w.chunks('d-will')).map((c) => c['privileged'])).toEqual([true, true]);
    const search = chunkSearch({ db: w.db, embedding: fakeEmbedding });
    const hidden = await search.searchChunks({
      orgId: ORG,
      matterId: 'm1',
      query: 'executors',
      allowPrivileged: false,
    });
    expect(hidden).toEqual([]);
    const shown = await search.searchChunks({ orgId: ORG, matterId: 'm1', query: 'executors', allowPrivileged: true });
    expect(shown.length).toBe(2);
  });

  it('deletes the chunks of a removed document, and re-ingests it when restored', async () => {
    const { w, ref } = await ingested();
    const live = await w.docData('d-will');
    await ref.update({ deletedAt: new Date(), deletedBy: 'user-lawyer' });
    await fire(w.db, 'd-will', live);
    expect(await w.chunks('d-will')).toEqual([]);
    expect(ingestOf(await w.docData('d-will'))).toEqual({ status: 'pending' });

    const removed = await w.docData('d-will');
    await ref.update({ deletedAt: null, deletedBy: null });
    const tasks = await fire(w.db, 'd-will', removed, 'event-restore');
    expect(tasks.queued).toHaveLength(1);
  });

  it('deletes the chunks of a hard-deleted document', async () => {
    const { w, ref } = await ingested();
    const live = await w.docData('d-will');
    await ref.delete();
    await fire(w.db, 'd-will', live);
    expect(await w.chunks('d-will')).toEqual([]);
  });

  it('needsIngest: only live, clean versions not yet ingested', () => {
    const base = { scan: { status: 'clean' }, version: 2, deletedAt: null };
    expect(needsIngest({ ...base, ingest: { status: 'pending' } })).toBe(true);
    expect(needsIngest({ ...base, ingest: { status: 'done', version: 1 } })).toBe(true);
    expect(needsIngest({ ...base, ingest: { status: 'done', version: 2 } })).toBe(false);
    expect(needsIngest({ ...base, ingest: { status: 'running', version: 2 } })).toBe(false);
    expect(needsIngest({ ...base, version: 0, ingest: { status: 'pending' } })).toBe(false);
    expect(needsIngest({ ...base, scan: { status: 'pending' }, ingest: { status: 'pending' } })).toBe(false);
    expect(needsIngest({ ...base, deletedAt: new Date(), ingest: { status: 'pending' } })).toBe(false);
    expect(needsIngest(undefined)).toBe(false);
  });
});

describe('searchChunks', () => {
  /** Fictional fixtures: the sample PDFs, a DOCX report, an email and a text file. */
  async function corpus() {
    const w = world({ flags: {} });
    const tasks = [
      await w.addDocument('d-will', 'Will.pdf', fixture('will.pdf')),
      await w.addDocument('d-death', 'Death certificate.pdf', fixture('death-certificate.pdf')),
      await w.addDocument('d-order', 'Orders.pdf', fixture('court-order.pdf')),
      await w.addDocument(
        'd-report',
        'Executor report.docx',
        sampleDocx([
          'Bank accounts: the fictional Westpac savings account held $42,310 at the date of death and was closed.',
          'Shares: 1,200 fictional Telstra shares were transferred to the beneficiary through the share registry.',
          'Superannuation: the fund trustee paid the death benefit to the legal personal representative.',
        ]),
      ),
      await w.addDocument(
        'd-email',
        'Valuation.eml',
        sampleEml({
          subject: 'Fictional valuation of the Geelong house',
          text: 'Our sworn valuer inspected the residence and assessed its market value at $850,000.',
          attachments: [],
        }),
      ),
      await w.addDocument(
        'd-notes',
        'Funeral.txt',
        Buffer.from('Funeral director invoice: the cremation and service cost $9,400, paid from the estate account.'),
      ),
    ];
    for (const task of tasks) await ingestDocument(task, w.deps());
    return w;
  }

  const QUERIES: [query: string, docId: string, page: number][] = [
    ['Who are the executors and trustees of the will?', 'd-will', 1],
    ['Which law governs the will?', 'd-will', 2],
    ['Where did the deceased die and what was her occupation?', 'd-death', 1],
    ['When must the plaintiff file and serve an affidavit?', 'd-order', 1],
    ['Was the proceeding referred to mediation?', 'd-order', 1],
    ['How much was in the Westpac savings account?', 'd-report', 1],
    ['What happened to the Telstra shares?', 'd-report', 1],
    ['What is the market value of the Geelong residence?', 'd-email', 1],
    ['How much did the funeral cremation cost?', 'd-notes', 1],
    ['Who was left without provision in the will (the son)?', 'd-will', 1],
  ];

  it('finds the relevant chunk for 10 seeded queries (recall@5 >= 0.9)', async () => {
    const w = await corpus();
    const search = chunkSearch({ db: w.db, embedding: fakeEmbedding });
    let hits = 0;
    for (const [query, docId, page] of QUERIES) {
      const results = await search.searchChunks({ orgId: ORG, matterId: 'm1', query, k: 5, allowPrivileged: true });
      expect(results.length).toBeLessThanOrEqual(5);
      if (results.some((r) => r.documentId === docId && r.page === page)) hits++;
    }
    expect(hits / QUERIES.length).toBeGreaterThanOrEqual(0.9);
  });

  it('returns hits in distance order with provenance, scoped to the org and matter', async () => {
    const w = await corpus();
    const search = chunkSearch({ db: w.db, embedding: fakeEmbedding });
    const [top, ...rest] = await search.searchChunks({
      orgId: ORG,
      matterId: 'm1',
      query: 'Telstra shares transferred',
      allowPrivileged: false,
    });
    expect(top).toMatchObject({ documentId: 'd-report', version: 1, page: 1, privileged: false });
    expect(top?.distance).toBeGreaterThanOrEqual(0);
    for (const hit of rest) expect(hit.distance).toBeGreaterThanOrEqual(top?.distance ?? 0);
    expect(
      await search.searchChunks({ orgId: ORG, matterId: 'm2', query: 'Telstra shares', allowPrivileged: true }),
    ).toEqual([]);
    expect(
      await search.searchChunks({ orgId: 'org-b', matterId: 'm1', query: 'Telstra', allowPrivileged: true }),
    ).toEqual([]);
    expect(await search.searchChunks({ orgId: ORG, matterId: 'm1', query: '  ', allowPrivileged: true })).toEqual([]);
  });

  it('clamps k to 1..50 (default 8)', () => {
    expect(clampK(undefined)).toBe(8);
    expect(clampK(0)).toBe(1);
    expect(clampK(12)).toBe(12);
    expect(clampK(500)).toBe(50);
  });

  it('FakeChunkSearch filters and ranks like the real one', async () => {
    const fake = new FakeChunkSearch([
      {
        orgId: ORG,
        matterId: 'm1',
        documentId: 'd1',
        version: 1,
        page: 1,
        ordinal: 0,
        text: 'executors of the will',
        privileged: false,
        distance: 0,
      },
      {
        orgId: ORG,
        matterId: 'm1',
        documentId: 'd2',
        version: 1,
        page: 2,
        ordinal: 0,
        text: 'privileged advice on the will',
        privileged: true,
        distance: 0,
      },
      {
        orgId: ORG,
        matterId: 'm2',
        documentId: 'd3',
        version: 1,
        page: 1,
        ordinal: 0,
        text: 'executors elsewhere',
        privileged: false,
        distance: 0,
      },
    ]);
    const hits = await fake.searchChunks({
      orgId: ORG,
      matterId: 'm1',
      query: 'executors will',
      allowPrivileged: false,
    });
    expect(hits.map((h) => h.documentId)).toEqual(['d1']);
    expect(hits[0]?.distance).toBe(0);
    expect(fake.queries).toHaveLength(1);
  });
});

describe('backfillIngest', () => {
  it('queues every live, clean document not ingested for its version', async () => {
    const w = world();
    const done = await w.addDocument('d-done', 'Will.pdf', fixture('will.pdf'));
    await ingestDocument(done, w.deps());
    await w.addDocument('d-old', 'Orders.pdf', fixture('court-order.pdf'), { ingest: { status: 'done', pages: 1 } });
    await w.addDocument('d-failed', 'Scan.pdf', fixture('court-order.pdf'), {
      ingest: { status: 'failed', version: 1 },
    });
    await w.addDocument('d-removed', 'Gone.pdf', fixture('will.pdf'), { deletedAt: new Date() });
    await w.addDocument('d-infected', 'Bad.pdf', fixture('will.pdf'), { scan: { status: 'infected' } });
    const tasks = new FakeTaskQueue();
    await expect(backfillIngest(w.db, tasks, { orgId: ORG, runId: 'run-1' })).resolves.toEqual({
      queued: 2,
      skipped: 3,
    });
    expect(tasks.queued.map((t) => t.payload['docId']).sort()).toEqual(['d-failed', 'd-old']);
    expect(tasks.queued[0]?.options.dedupeKey).toContain('backfill-run-1');
    // One matter only.
    const one = new FakeTaskQueue();
    await backfillIngest(w.db, one, { orgId: ORG, matterId: 'm-other', runId: 'run-2' });
    expect(one.queued).toEqual([]);
  });

  it('marks chunk vectors as Firestore vectors', () => {
    expect(FieldValue.vector([1, 2]).toArray()).toEqual([1, 2]);
  });
});

describe('ingestErrorLabel', () => {
  it('keeps the name, code and message, and drops everything from a path on', () => {
    const error = Object.assign(new Error('No such object: files/orgs/o1/matters/m1/Will of Example.pdf'), {
      code: 404,
    });
    expect(ingestErrorLabel(error)).toBe('Error (404): No such object: [path]');
    expect(ingestErrorLabel(new TypeError(''))).toBe('TypeError');
    expect(ingestErrorLabel('boom')).toBe('Error');
    expect(ingestErrorLabel(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(200);
  });
});
