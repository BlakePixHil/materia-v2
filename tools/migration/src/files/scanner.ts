import * as z from 'zod';

/**
 * The malware scan for copied attachments (MIG-05): the same ClamAV service on Cloud Run that scans
 * uploads (CORE-12a, ADR-028), called with the same contract:
 *
 *   POST {url}/scan   Authorization: Bearer <Google ID token>   <the file's bytes>
 *   200 {"verdict": "clean"} | {"verdict": "infected", "signature": "<name>"}
 *
 * Anything else throws `ScannerUnavailableError`: the file stays in quarantine, unscanned, and a
 * re-run scans it. Nothing about the file is logged.
 */

export type ScanVerdict = { verdict: 'clean' } | { verdict: 'infected'; signature?: string | undefined };
export type Scanner = (data: Buffer) => Promise<ScanVerdict>;

export class ScannerUnavailableError extends Error {
  constructor(message = 'The malware scanner is unavailable.') {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

const ScanResponse = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('clean') }),
  z.object({ verdict: z.literal('infected'), signature: z.string().max(200).optional() }),
]);

export interface HttpScannerOptions {
  /** The service's base URL. */
  url: string;
  /** A Google ID token the service accepts (run.invoker). */
  idToken: () => Promise<string>;
  fetch?: typeof fetch;
  /** How long one scan may take (default 2 minutes: a cold start loads the signatures). */
  timeoutMs?: number;
}

export function httpScanner(options: HttpScannerOptions): Scanner {
  const doFetch = options.fetch ?? fetch;
  const url = options.url.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 120_000;
  return async (data) => {
    let response: Response;
    try {
      response = await doFetch(`${url}/scan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await options.idToken()}`, 'content-type': 'application/octet-stream' },
        // A copy in a plain ArrayBuffer (a Node Buffer may be a view into a shared pool).
        body: new Uint8Array(data).buffer,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ScannerUnavailableError();
    }
    if (!response.ok) throw new ScannerUnavailableError(`The malware scanner answered ${response.status}.`);
    const parsed = ScanResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ScannerUnavailableError('The malware scanner gave an answer it should not.');
    return parsed.data;
  };
}

/**
 * The EICAR anti-virus test string, which every scanner reports as infected (it is harmless).
 * Built from two halves so this source file isn't flagged itself.
 */
export const EICAR_TEST_STRING = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/** Test hook: a file containing this makes the emulator scanner unavailable. */
export const FAKE_SCANNER_UNAVAILABLE_MARKER = 'MATERIA-FAKE-SCANNER-TIMEOUT';

/**
 * The emulator's scanner (`--env emulator`), as the functions' fake: files holding the EICAR test
 * string are infected, files holding the marker can't be scanned, everything else is clean.
 */
export const emulatorScanner: Scanner = async (data) => {
  if (data.includes(FAKE_SCANNER_UNAVAILABLE_MARKER)) throw new ScannerUnavailableError();
  return data.includes(EICAR_TEST_STRING)
    ? { verdict: 'infected', signature: 'Eicar-Test-Signature' }
    : { verdict: 'clean' };
};
