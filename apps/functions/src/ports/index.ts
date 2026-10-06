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
  | { type: 'search_result'; source: string; title: string; text: string; cache?: boolean }
  /** A tool's answer (AI-06): text, or retrieved passages the model can cite. */
  | {
      type: 'tool_result';
      toolUseId: string;
      content: (
        { type: 'text'; text: string } | { type: 'search_result'; source: string; title: string; text: string }
      )[];
      isError?: boolean;
      cache?: boolean;
    };

/** A read-only tool the model may choose to call (AI-06; never forced). */
export interface ClerkToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** One tool call the model asked for. */
export interface ClerkToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ClerkTurn {
  role: 'user' | 'assistant';
  /** User turns: our blocks. Assistant turns: the provider's blocks, verbatim (thinking included). */
  content: ClerkContentBlock[] | readonly unknown[];
}

export type ClerkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClerkModelRequest {
  model: string;
  /**
   * The org's own Anthropic API key (BYOK, AI-02a), decrypted for this call only. Never logged,
   * stored or returned. `orgId` keys the adapter's short-lived client cache.
   */
  credentials: { orgId: string; apiKey: string };
  /** The stable system prompt, always cached. */
  system: string;
  messages: ClerkTurn[];
  maxTokens: number;
  effort: ClerkEffort;
  /** Structured output: the reply is JSON matching this schema (`output_config.format`). */
  output?: { name: string; schema: import('zod').ZodType };
  /** Read-only tools the model may call (`tool_choice` is never forced). */
  tools?: ClerkToolDefinition[];
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
  /** The tools the model asked to call (`stopReason: tool_use`). */
  toolUses?: ClerkToolUse[];
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
  /**
   * The model ids a key can use: one cheap authenticated call, made before a key is saved (AI-02a).
   * Throws a `ClerkModelError` (`auth` for a rejected key).
   */
  listModels(apiKey: string): Promise<string[]>;
}

/**
 * Cloud KMS for secrets stored in Firestore (ADR-019, AI-02a): one crypto key per use. `aad`
 * (additional authenticated data, such as the document path) binds a ciphertext to where it is
 * stored, so it can't be copied to another org. Ciphertexts are base64.
 */
export interface KmsPort {
  encrypt(plaintext: string, aad: string): Promise<{ ciphertext: string; keyVersion: string }>;
  decrypt(ciphertext: string, aad: string): Promise<string>;
}

/**
 * Text embeddings (ADR-012, AI-04): Vertex AI in `australia-southeast1`, 768 dimensions. Chunks are
 * embedded as `document`s and searches as a `query` (the model embeds the two differently).
 */
export interface EmbeddingPort {
  /** One 768-dimension vector per input, in order. Throws `EmbeddingUnavailableError` when the service fails. */
  embed(texts: string[], options?: { task?: 'document' | 'query' }): Promise<number[][]>;
}

/** The embedding service failed after its retries, or isn't configured. Never carries text. */
export class EmbeddingUnavailableError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'not_configured' | 'rejected',
    readonly status?: number,
  ) {
    super(`Embeddings ${reason}`);
    this.name = 'EmbeddingUnavailableError';
  }
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

/** A file to scan (CORE-12): the quarantined object and its bytes, which the trigger already read. */
export interface ScanRequest {
  bucket: string;
  path: string;
  data: Uint8Array;
}

export interface ScanResult {
  verdict: 'clean' | 'infected';
  /** The scanner's signature name for an infected file (never file content). */
  signature?: string;
}

/**
 * The scanner timed out, is down or isn't configured: the upload stays quarantined, is shown as
 * "Scanning delayed" and is retried with backoff (CORE-12). Never a verdict.
 */
export class ScannerUnavailableError extends Error {
  constructor(readonly reason: 'timeout' | 'unavailable' | 'not_configured') {
    super(`Malware scanner ${reason}`);
    this.name = 'ScannerUnavailableError';
  }
}

/** Malware scanning (CORE-12, ADR-028). The real adapter calls ClamAV over HTTP (`documents/clamav.ts`). */
export interface MalwareScanPort {
  /** Resolves with a verdict, or throws `ScannerUnavailableError`. Must honour `signal` (the trigger's timeout). */
  scan(request: ScanRequest, signal?: AbortSignal): Promise<ScanResult>;
}

/** What a preview is converted to (CORE-12a): Office files become PDF, HEIC photos JPEG. */
export type PreviewTarget = 'pdf' | 'jpeg';

/** A stored, scanned version to convert: its allow-listed extension and its bytes. */
export interface PreviewRequest {
  from: string;
  to: PreviewTarget;
  data: Uint8Array;
}

/**
 * No preview this time. `failed` is final (the file can't be converted: damaged, encrypted or
 * refused); `unavailable` and `not_configured` are worth a retry.
 */
export class PreviewUnavailableError extends Error {
  constructor(readonly reason: 'failed' | 'unavailable' | 'not_configured') {
    super(`Preview ${reason}`);
    this.name = 'PreviewUnavailableError';
  }
}

/**
 * Office → PDF and HEIC → JPEG previews (CORE-12a, ADR-028). The real adapter calls the preview
 * service on Cloud Run (`documents/preview.ts`).
 */
export interface PreviewPort {
  /** Resolves with the converted bytes, or throws `PreviewUnavailableError`. */
  render(request: PreviewRequest, signal?: AbortSignal): Promise<Buffer>;
}

export interface SignedUrlRequest {
  bucket: string;
  path: string;
  expiresAt: Date;
  /** The `Content-Disposition` the download is served with (always `attachment`). */
  disposition: string;
  contentType: string;
}

/**
 * Short-lived read URLs for Storage objects (CORE-12): V4 signed URLs in production (the runtime
 * account signs as itself), a stand-in in the emulator, which can't sign.
 */
export interface SignedUrlPort {
  sign(request: SignedUrlRequest): Promise<string>;
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
  /** The `clerk-api-keys` crypto key (AI-02a). */
  clerkKms: KmsPort;
  embedding: EmbeddingPort;
  calendar: CalendarPort;
  xero: XeroPort;
  malwareScan: MalwareScanPort;
  preview: PreviewPort;
  signedUrls: SignedUrlPort;
  transcription: TranscriptionPort;
  jobs: JobRunnerPort;
}
