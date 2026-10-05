import { createHash } from 'node:crypto';

import type {
  CalendarEvent,
  CalendarPort,
  Clock,
  EmbeddingPort,
  EnqueueOptions,
  MailMessage,
  MailPort,
  MalwareScanPort,
  JobRunnerPort,
  KmsPort,
  Ports,
  PushMessage,
  PushPort,
  PushResult,
  TaskQueuePort,
  SignedUrlPort,
  SignedUrlRequest,
  TranscriptionPort,
  XeroPort,
} from './index';
import { ScannerUnavailableError } from './index';
import { FakeClerkModel } from '../clerk/providers/fake';

/**
 * Push (FND-20): records each message. Tokens starting `invalid-` are reported as gone (FCM's
 * "not registered"), `flaky-` ones as a transient failure.
 */
export class FakePush implements PushPort {
  readonly sent: { token: string; message: PushMessage }[] = [];
  async send(token: string, message: PushMessage): Promise<PushResult> {
    if (token.startsWith('invalid-')) return { ok: false, reason: 'invalid_token' };
    if (token.startsWith('flaky-')) return { ok: false, reason: 'transient' };
    this.sent.push({ token, message });
    return { ok: true, id: `push-${this.sent.length}` };
  }
}

/** Cloud Tasks (FND-20): records what would be enqueued; nothing runs. */
export class FakeTaskQueue implements TaskQueuePort {
  readonly queued: { queue: string; payload: Record<string, unknown>; options: EnqueueOptions }[] = [];
  async enqueue(queue: string, payload: Record<string, unknown>, options: EnqueueOptions = {}) {
    this.queued.push({ queue, payload, options });
  }
}

/** A clock tests can set and advance. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-03-14T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeMail implements MailPort {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
    return { id: `mail-${this.sent.length}` };
  }
}

/** The default fake model: a plain reply, or a sample object for structured output (AI-02). */
export const fakeClerkModel = new FakeClerkModel();

/**
 * KMS for the emulator and tests (AI-02a): a reversible scramble that never contains the plaintext,
 * bound to its `aad` like Cloud KMS (decrypting with another `aad` fails).
 */
export class FakeKms implements KmsPort {
  readonly calls: { op: 'encrypt' | 'decrypt'; aad: string }[] = [];
  constructor(private readonly keyVersion = 'fake-kms/cryptoKeyVersions/1') {}

  private static mask(data: Buffer, aad: string): Buffer {
    const pad = createHash('sha256').update(`materia-fake-kms:${aad}`).digest();
    return Buffer.from(data.map((byte, i) => byte ^ (pad[i % pad.length] as number) ^ 0x5a));
  }

  async encrypt(plaintext: string, aad: string) {
    this.calls.push({ op: 'encrypt', aad });
    const body = FakeKms.mask(Buffer.from(`ok:${plaintext}`), aad);
    return { ciphertext: `fakekms.${body.toString('base64')}`, keyVersion: this.keyVersion };
  }

  async decrypt(ciphertext: string, aad: string) {
    this.calls.push({ op: 'decrypt', aad });
    if (!ciphertext.startsWith('fakekms.')) throw new Error('Not a fake KMS ciphertext');
    const plain = FakeKms.mask(Buffer.from(ciphertext.slice('fakekms.'.length), 'base64'), aad).toString();
    if (!plain.startsWith('ok:')) throw new Error('Decryption failed (wrong additional authenticated data)');
    return plain.slice(3);
  }
}

/** Deterministic 768-d vectors, so similarity tests are stable. */
export const fakeEmbedding: EmbeddingPort = {
  async embed(texts) {
    return texts.map((text) => Array.from({ length: 768 }, (_, i) => ((text.length + i) % 7) / 7));
  },
};

export class FakeCalendar implements CalendarPort {
  readonly events = new Map<string, { uid: string; title: string }>();
  async upsertEvent(uid: string, event: CalendarEvent) {
    const externalId = event.externalId ?? `cal-${this.events.size + 1}`;
    this.events.set(externalId, { uid, title: event.title });
    return { externalId };
  }
  async deleteEvent(_uid: string, externalId: string) {
    this.events.delete(externalId);
  }
}

export const fakeXero: XeroPort = {
  async pushInvoice(_orgId, invoiceId) {
    return { xeroInvoiceId: `xero-${invoiceId}` };
  },
};

/**
 * The EICAR anti-virus test string, which every scanner reports as infected (it is harmless).
 * Built from two halves so this source file isn't flagged itself.
 */
export const EICAR_TEST_STRING = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/** Test hook: a file containing this makes the fake scanner time out ("Scanning delayed"). */
export const FAKE_SCANNER_TIMEOUT_MARKER = 'MATERIA-FAKE-SCANNER-TIMEOUT';

/**
 * The emulator's and tests' scanner (CORE-12): files containing the EICAR test string are
 * infected, files containing `FAKE_SCANNER_TIMEOUT_MARKER` time out, everything else is clean.
 */
export const fakeMalwareScan: MalwareScanPort = {
  async scan({ data }) {
    const content = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (content.includes(FAKE_SCANNER_TIMEOUT_MARKER)) throw new ScannerUnavailableError('timeout');
    return content.includes(EICAR_TEST_STRING)
      ? { verdict: 'infected', signature: 'Eicar-Test-Signature' }
      : { verdict: 'clean' };
  },
};

/** Signed URLs for unit tests: records each request and returns a recognisable fake URL. */
export class FakeSignedUrls implements SignedUrlPort {
  readonly signed: SignedUrlRequest[] = [];
  async sign(request: SignedUrlRequest) {
    this.signed.push(request);
    const expires = Math.round(request.expiresAt.getTime() / 1000);
    return `https://storage.example.test/${request.bucket}/${encodeURIComponent(request.path)}?expires=${expires}`;
  }
}

export const fakeTranscription: TranscriptionPort = {
  async transcribe() {
    return { text: 'Fictional transcript for tests.', durationSeconds: 3 };
  },
};

/** Records job starts; nothing runs (run the job image with `--local` to try a job by hand). */
export class FakeJobRunner implements JobRunnerPort {
  readonly started: { job: string; orgId: string; jobId: string }[] = [];
  async start(job: string, params: { orgId: string; jobId: string }) {
    this.started.push({ job, ...params });
    return { executionId: `fake-execution-${this.started.length}` };
  }
}

export function fakePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    clock: new FakeClock(),
    mail: new FakeMail(),
    push: new FakePush(),
    tasks: new FakeTaskQueue(),
    clerkModel: fakeClerkModel,
    clerkKms: new FakeKms(),
    embedding: fakeEmbedding,
    calendar: new FakeCalendar(),
    xero: fakeXero,
    malwareScan: fakeMalwareScan,
    signedUrls: new FakeSignedUrls(),
    transcription: fakeTranscription,
    jobs: new FakeJobRunner(),
    ...overrides,
  };
}
