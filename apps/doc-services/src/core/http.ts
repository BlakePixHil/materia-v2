import type { IncomingMessage, ServerResponse } from 'node:http';

type Severity = 'INFO' | 'WARNING' | 'ERROR';

export interface Log {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured JSON lines on stdout, which Cloud Logging parses (ADR-018). Fields are sizes, timings
 * and codes only: never file names or file content.
 */
export function createLog(
  base: Record<string, unknown>,
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Log {
  const emit =
    (severity: Severity) =>
    (message: string, fields: Record<string, unknown> = {}) =>
      write(JSON.stringify({ severity, message, ...base, ...fields }));
  return { info: emit('INFO'), warn: emit('WARNING'), error: emit('ERROR') };
}

/** The request body was larger than the service accepts. */
export class TooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'TooLargeError';
  }
}

/** Reads a whole request body, refusing more than `maxBytes` (checked as it arrives). */
export function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      request.resume();
      reject(new TooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new TooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  response.end(json);
}

export function sendBytes(response: ServerResponse, contentType: string, body: Buffer): void {
  response.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
  response.end(body);
}
