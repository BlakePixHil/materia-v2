/**
 * Ports for everything outside our code (FND-15, ADR-014). Feature tickets add the real adapters;
 * the container picks fakes in the emulator and tests. Payloads carry ids and content only as
 * needed for the call; adapters must not log content.
 */

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
  send(message: MailMessage): Promise<{ id: string }>;
}

export interface ClerkModelRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
}
export interface ClerkModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export interface ClerkModelPort {
  complete(request: ClerkModelRequest): Promise<ClerkModelResponse>;
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

export interface PdfRenderPort {
  /** Renders HTML to a PDF in Storage and returns its path. */
  render(html: string, outputPath: string): Promise<{ path: string; pages: number }>;
}

export interface Ports {
  clock: Clock;
  mail: MailPort;
  clerkModel: ClerkModelPort;
  embedding: EmbeddingPort;
  calendar: CalendarPort;
  xero: XeroPort;
  malwareScan: MalwareScanPort;
  transcription: TranscriptionPort;
  pdfRender: PdfRenderPort;
}
