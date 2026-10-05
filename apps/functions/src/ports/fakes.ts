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
  Ports,
  PushMessage,
  PushPort,
  PushResult,
  TaskQueuePort,
  TranscriptionPort,
  XeroPort,
} from './index';
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

/** Treats any object path containing "eicar" as infected (the standard test-virus name). */
export const fakeMalwareScan: MalwareScanPort = {
  async scan(_bucket, objectPath) {
    return objectPath.toLowerCase().includes('eicar') ? 'infected' : 'clean';
  },
};

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
    embedding: fakeEmbedding,
    calendar: new FakeCalendar(),
    xero: fakeXero,
    malwareScan: fakeMalwareScan,
    transcription: fakeTranscription,
    jobs: new FakeJobRunner(),
    ...overrides,
  };
}
