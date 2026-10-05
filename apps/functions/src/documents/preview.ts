import { metadataIdToken } from './clamav';
import { PreviewUnavailableError, type PreviewPort } from '../ports';

/**
 * The production preview adapter (CORE-12a, ADR-028): the preview service on Cloud Run, called
 * over HTTP as the runtime account (Cloud Run IAM `run.invoker`, an ID token for the service URL):
 *
 *   POST {url}/convert?from=<ext>&to=<pdf|jpeg>
 *   Content-Type: application/octet-stream
 *   <the version's bytes>
 *
 *   200 <the converted bytes> | 415 unsupported | 422 couldn't convert | anything else: unavailable
 *
 * 415 and 422 are final (`failed`); anything else, a network error or an empty URL is worth a retry.
 */
const PDF_MAGIC = Buffer.from('%PDF-');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export interface PreviewServiceOptions {
  /** The service's base URL; empty until the service is deployed. */
  url: () => string;
  idToken?: (audience: string) => Promise<string>;
  fetch?: typeof fetch;
}

export function previewService(options: PreviewServiceOptions): PreviewPort {
  const doFetch = options.fetch ?? fetch;
  const idToken = options.idToken ?? metadataIdToken(doFetch);
  return {
    async render({ from, to, data }, signal) {
      const url = options.url().replace(/\/+$/, '');
      if (!url) throw new PreviewUnavailableError('not_configured');
      let response: Response;
      try {
        response = await doFetch(`${url}/convert?from=${encodeURIComponent(from)}&to=${to}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await idToken(url)}`,
            'content-type': 'application/octet-stream',
          },
          body: new Uint8Array(data).buffer,
          ...(signal ? { signal } : {}),
        });
      } catch {
        throw new PreviewUnavailableError('unavailable');
      }
      if (response.status === 415 || response.status === 422) throw new PreviewUnavailableError('failed');
      if (!response.ok) throw new PreviewUnavailableError('unavailable');
      const output = Buffer.from(await response.arrayBuffer());
      // The rendition is served with a fixed content type, so it must be what it claims to be.
      const magic = to === 'pdf' ? PDF_MAGIC : JPEG_MAGIC;
      if (!output.subarray(0, magic.length).equals(magic)) throw new PreviewUnavailableError('failed');
      return output;
    },
  };
}
