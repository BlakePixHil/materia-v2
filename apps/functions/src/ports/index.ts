/**
 * Ports for everything outside our code (FND-15, ADR-014). Feature tickets add the real adapters;
 * the container picks fakes in the emulator and tests. Payloads carry ids and content only as
 * needed for the call; adapters must not log content.
 */
import { DomainError } from '@materia/domain';

export interface Clock {
  now(): Date;
}

export interface MailMessage {
  to: string;
  template: string;
  model: Record<string, unknown>;
  idempotencyKey?: string;
}
export interface MailPort {
  /** Sends one email, or throws a `MailError` saying why not. */
  send(message: MailMessage): Promise<{ id: string }>;
}

/**
 * Why an email wasn't sent (FND-20): `not_configured` (no POSTMARK_TOKEN yet), `inactive_recipient`
 * (the provider suppresses the address after a bounce or complaint), `rejected` (a request the
 * provider refuses, such as an unverified sender) or `transient` (worth retrying).
 */
export type MailFailure = 'not_configured' | 'inactive_recipient' | 'rejected' | 'transient';

/** A mail failure, classified. Never carries the address or content. */
export class MailError extends DomainError {
  constructor(
    readonly failure: MailFailure,
    message: string = failure,
    readonly providerCode?: number,
  ) {
    super('UNAVAILABLE', message, { failure, ...(providerCode !== undefined ? { providerCode } : {}) });
    this.name = 'MailError';
  }
}

/** A push notification (FND-20): what a lock screen may show, and where a tap goes. */
export interface PushMessage {
  title: string;
  body: string;
  /** An app path (`/matters/m1`). */
  link: string;
}
export type PushResult =
  | { ok: true; id: string }
  /** `invalid_token`: the device is gone (the caller deletes it); `transient`: worth retrying. */
  | { ok: false; reason: 'invalid_token' | 'transient' | 'rejected' };
export interface PushPort {
  send(token: string, message: PushMessage): Promise<PushResult>;
}

export interface EnqueueOptions {
  scheduleTime?: Date;
  /** Tasks with the same key are created once (Cloud Tasks deduplicates by task id). */
  dedupeKey?: string;
}
/** Cloud Tasks, as a port so code that enqueues can be tested without them (FND-20). */
export interface TaskQueuePort {
  enqueue(queue: string, payload: Record<string, unknown>, options?: EnqueueOptions): Promise<void>;
}

/**
 * One content block in a Clerk request (AI-02). Documents and retrieved chunks are separate block
 * kinds so the model can cite them; `cache` marks the end of the stable prefix (prompt caching).
 */
export type ClerkContentBlock =
  | { type: 'text'; text: string; cache?: boolean }
  | {
      type: 'document';
      title?: string;
      source: { kind: 'text'; text: string } | { kind: 'pdf'; base64: string };
      cache?: boolean;
    }
  | { type: 'search_result'; source: string; title: string; text: string; cache?: boolean };

export interface ClerkTurn {
  role: 'user' | 'assistant';
  /** User turns: our blocks. Assistant turns: the provider's blocks, verbatim (thinking included). */
  content: ClerkContentBlock[] | readonly unknown[];
}

export type ClerkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClerkModelRequest {
  model: string;
  /** The stable system prompt, always cached. */
  system: string;
  messages: ClerkTurn[];
  maxTokens: number;
  effort: ClerkEffort;
  /** Structured output: the reply is JSON matching this schema (`output_config.format`). */
  output?: { name: string; schema: import('zod').ZodType };
  timeoutMs: number;
  signal?: AbortSignal;
  /** Let the API reroute refusals to another model itself (first-party API only, ADR-011a). */
  serverFallbacks: boolean;
}

export type ClerkStreamEvent = { type: 'text'; text: string };

export interface ClerkModelResult {
  /** The model that served the reply (differs from the request after a server-side fallback). */
  model: string;
  stopReason: string;
  text: string;
  /** The provider's raw citation locations; the gateway maps them to documents. */
  citations: unknown[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** The assistant turn verbatim, for replay (never edited; preserved thinking). */
  content: readonly unknown[];
  serverFallback: boolean;
}

export type ClerkModelErrorKind =
  'rate_limited' | 'overloaded' | 'server' | 'timeout' | 'disconnected' | 'aborted' | 'bad_request' | 'auth';

/** A provider failure, classified so the gateway can retry, fall back or give up. Never carries content. */
export class ClerkModelError extends Error {
  constructor(
    readonly kind: ClerkModelErrorKind,
    message: string = kind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ClerkModelError';
  }
}

/** The only way Functions reach a Claude model (ADR-011a). Adapters live in `clerk/providers/`. */
export interface ClerkModelPort {
  run(request: ClerkModelRequest, onEvent?: (event: ClerkStreamEvent) => void): Promise<ClerkModelResult>;
}

export interface EmbeddingPort {
  /** One 768-dimension vector per input. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface CalendarEvent {
  externalId?: string;
  title: string;
  start: Date;
  end: Date;
}
export interface CalendarPort {
  upsertEvent(uid: string, event: CalendarEvent): Promise<{ externalId: string }>;
  deleteEvent(uid: string, externalId: string): Promise<void>;
}

export interface XeroPort {
  pushInvoice(orgId: string, invoiceId: string): Promise<{ xeroInvoiceId: string }>;
}

export type ScanVerdict = 'clean' | 'infected' | 'error';
export interface MalwareScanPort {
  scan(bucket: string, objectPath: string): Promise<ScanVerdict>;
}

export interface TranscriptionPort {
  transcribe(bucket: string, objectPath: string): Promise<{ text: string; durationSeconds: number }>;
}

/** A Cloud Run job image (ADR-014). `pdf` runs `pdf.render` and `pdf.merge` (FND-24). */
export type CloudRunJobName = 'pdf';

/**
 * Starts a Cloud Run job execution for one job document, `orgs/{orgId}/jobs/{jobId}` (FND-24). The
 * execution reads everything else from that document.
 */
export interface JobRunnerPort {
  start(job: CloudRunJobName, params: { orgId: string; jobId: string }): Promise<{ executionId: string }>;
}

export interface Ports {
  clock: Clock;
  mail: MailPort;
  push: PushPort;
  tasks: TaskQueuePort;
  clerkModel: ClerkModelPort;
  embedding: EmbeddingPort;
  calendar: CalendarPort;
  xero: XeroPort;
  malwareScan: MalwareScanPort;
  transcription: TranscriptionPort;
  jobs: JobRunnerPort;
}
