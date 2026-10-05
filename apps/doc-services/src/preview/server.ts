import { createServer, type Server } from 'node:http';

import { ConversionError, isSupported, type ConvertRequest } from './convert';
import { readBody, sendBytes, sendJson, TooLargeError, type Log } from '../core/http';

const CONTENT_TYPES = { pdf: 'application/pdf', jpeg: 'image/jpeg' } as const;

/**
 * The preview contract (CORE-12a, ADR-028), as `apps/functions/src/documents/preview.ts` calls it:
 *
 *   POST /convert?from=<docx|doc|xlsx|xls|pptx|heic>&to=<pdf|jpeg>   <the file's bytes>
 *     → 200 the converted bytes (application/pdf or image/jpeg)
 *     → 415 an unsupported pair, 422 the file couldn't be converted, 413 too large,
 *       503 the conversion timed out (worth a retry)
 *   GET /healthz → 200
 *
 * Only files that already passed the malware scan are sent here, by the functions runtime account
 * (Cloud Run IAM). The service holds no credentials and touches no storage: bytes in, bytes out.
 */
export interface PreviewDeps {
  convert: (request: ConvertRequest) => Promise<Buffer>;
  log: Log;
  maxBytes: number;
}

export function previewServer(deps: PreviewDeps): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { ok: true });
      if (url.pathname !== '/convert') return sendJson(response, 404, { error: 'not_found' });
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!isSupported(from, to)) {
        request.resume();
        return sendJson(response, 415, { error: 'unsupported' });
      }
      let data: Buffer;
      try {
        data = await readBody(request, deps.maxBytes);
      } catch (error) {
        if (error instanceof TooLargeError) return sendJson(response, 413, { error: 'too_large' });
        throw error;
      }
      const started = Date.now();
      try {
        const output = await deps.convert({ from, to: to as ConvertRequest['to'], data });
        deps.log.info('converted', {
          from,
          to,
          sizeBytes: data.length,
          outBytes: output.length,
          ms: Date.now() - started,
        });
        return sendBytes(response, CONTENT_TYPES[to as ConvertRequest['to']], output);
      } catch (error) {
        const reason = error instanceof ConversionError ? error.reason : 'failed';
        deps.log.warn('conversion failed', { from, to, reason, sizeBytes: data.length, ms: Date.now() - started });
        // A timeout may pass on a warm instance, so it is worth a retry; anything else isn't.
        return sendJson(response, reason === 'timeout' ? 503 : 422, { error: reason });
      }
    })().catch((error: unknown) => {
      deps.log.error('request failed', { errorType: error instanceof Error ? error.name : typeof error });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
      else response.destroy();
    });
  });
}
