import type {
  CalendarEvent,
  CalendarPort,
  Clock,
  EmbeddingPort,
  MailMessage,
  MailPort,
  MalwareScanPort,
  JobRunnerPort,
  Ports,
  SignedUrlPort,
  SignedUrlRequest,
  TranscriptionPort,
  XeroPort,
} from './index';
import { ScannerUnavailableError } from './index';
import { FakeClerkModel } from '../clerk/providers/fake';

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
    clerkModel: fakeClerkModel,
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
