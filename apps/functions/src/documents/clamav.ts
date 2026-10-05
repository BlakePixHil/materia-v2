import * as z from 'zod';

import { ScannerUnavailableError, type MalwareScanPort } from '../ports';

/**
 * The production malware scanner (CORE-12, ADR-028): a ClamAV service on Cloud Run with daily
 * signature updates, called over HTTP. The contract:
 *
 *   POST {url}/scan
 *   Authorization: Bearer <Google ID token for audience {url}>   (the runtime account, run.invoker)
 *   Content-Type: application/octet-stream
 *   <the file's bytes>
 *
 *   200 {"verdict": "clean"} | {"verdict": "infected", "signature": "<name>"}
 *
 * Anything else (another status, a malformed body, a network error, the caller's timeout) throws
 * `ScannerUnavailableError`, which leaves the upload quarantined and retried. Nothing about the
 * file is logged.
 */
export interface ClamavOptions {
  /** The service's base URL; empty until the scanner is deployed (then every upload is delayed). */
  url: () => string;
  /** A Google ID token for `audience` (default: the metadata server, as the runtime account). */
  idToken?: (audience: string) => Promise<string>;
  fetch?: typeof fetch;
}

const ScanResponse = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('clean') }),
  z.object({ verdict: z.literal('infected'), signature: z.string().max(200).optional() }),
]);

const METADATA_IDENTITY =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/** ID tokens last an hour; reuse one for 50 minutes. */
const TOKEN_REUSE_MS = 50 * 60 * 1000;

export function metadataIdToken(doFetch: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { token: string; at: number }>();
  return async (audience: string): Promise<string> => {
    const cached = cache.get(audience);
    if (cached && now() - cached.at < TOKEN_REUSE_MS) return cached.token;
    const response = await doFetch(`${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}&format=full`, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!response.ok) throw new ScannerUnavailableError('unavailable');
    const token = (await response.text()).trim();
    cache.set(audience, { token, at: now() });
    return token;
  };
}

export function clamavScanner(options: ClamavOptions): MalwareScanPort {
  const doFetch = options.fetch ?? fetch;
  const idToken = options.idToken ?? metadataIdToken(doFetch);
  return {
    async scan({ data }, signal) {
      const url = options.url().replace(/\/+$/, '');
      if (!url) throw new ScannerUnavailableError('not_configured');
      let response: Response;
      try {
        response = await doFetch(`${url}/scan`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await idToken(url)}`,
            'content-type': 'application/octet-stream',
          },
          // A copy in a plain ArrayBuffer (a Node Buffer may be a view into a shared pool).
          body: new Uint8Array(data).buffer,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error instanceof ScannerUnavailableError) throw error;
        throw new ScannerUnavailableError(signal?.aborted ? 'timeout' : 'unavailable');
      }
      if (!response.ok) throw new ScannerUnavailableError('unavailable');
      const parsed = ScanResponse.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ScannerUnavailableError('unavailable');
      return parsed.data.verdict === 'clean'
        ? { verdict: 'clean' }
        : { verdict: 'infected', ...(parsed.data.signature ? { signature: parsed.data.signature } : {}) };
    },
  };
}
