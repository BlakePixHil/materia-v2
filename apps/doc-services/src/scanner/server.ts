import { createServer, type Server } from 'node:http';

import type { ClamdVerdict } from './clamd';
import { readBody, sendJson, TooLargeError, type Log } from '../core/http';

/**
 * The scan contract (CORE-12a, ADR-028), as `apps/functions/src/documents/clamav.ts` calls it:
 *
 *   POST /scan   <the file's bytes>   →  200 {"verdict": "clean"} | {"verdict": "infected", "signature": "…"}
 *   GET  /healthz                      →  200 when clamd answers PING, 503 otherwise
 *
 * Authentication is Cloud Run's (IAM `run.invoker`, ID tokens); nothing here is public. Any
 * failure is a non-200, which the caller treats as "scanner unavailable" (the upload stays
 * quarantined and is retried). Logs carry sizes, timings and verdicts, never file content.
 */
export interface ScannerDeps {
  scan: (data: Uint8Array) => Promise<ClamdVerdict>;
  ping: () => Promise<boolean>;
  log: Log;
  /** Largest body accepted (uploads are at most 50 MB). */
  maxBytes: number;
}

export function scannerServer(deps: ScannerDeps): Server {
  return createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '/').split('?')[0];
      if (request.method === 'GET' && path === '/healthz') {
        const ok = await deps.ping();
        return sendJson(response, ok ? 200 : 503, { ok });
      }
      if (path !== '/scan') return sendJson(response, 404, { error: 'not_found' });
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
      const started = Date.now();
      let data: Buffer;
      try {
        data = await readBody(request, deps.maxBytes);
      } catch (error) {
        if (error instanceof TooLargeError) return sendJson(response, 413, { error: 'too_large' });
        throw error;
      }
      try {
        const result = await deps.scan(data);
        deps.log.info('scanned', {
          verdict: result.verdict,
          ...(result.verdict === 'infected' ? { signature: result.signature } : {}),
          sizeBytes: data.length,
          ms: Date.now() - started,
        });
        return sendJson(response, 200, result);
      } catch (error) {
        deps.log.error('scan failed', {
          sizeBytes: data.length,
          ms: Date.now() - started,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return sendJson(response, 503, { error: 'scanner_unavailable' });
      }
    })().catch((error: unknown) => {
      deps.log.error('request failed', { errorType: error instanceof Error ? error.name : typeof error });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
      else response.destroy();
    });
  });
}
