import type { ClerkCitation } from '@materia/clerk';

import { verifyCitations } from './citations';
import type { DocumentTextPort } from './context/ports';

const SCOPE = { orgId: 'org-a', matterId: 'm-1' };
const cite = (over: Partial<ClerkCitation>): ClerkCitation => ({
  kind: 'document',
  documentId: 'd-will',
  docVersion: 2,
  page: 1,
  quote: '',
  ...over,
});

/** Fictional page text by `documentId@version`; `d-broken` fails to load. */
function pages(reads: string[]): DocumentTextPort {
  const texts: Record<string, { page: number; text: string }[]> = {
    'd-will@2': [
      { page: 1, text: 'I appoint my niece Harper Vale as executor.' },
      { page: 2, text: 'I give the residue to the Fictional Lighthouse Trust.' },
    ],
  };
  return {
    async pages({ documentId, version }) {
      reads.push(`${documentId}@${version}`);
      if (documentId === 'd-broken') throw new Error('unavailable');
      return texts[`${documentId}@${version}`] ?? [];
    },
  };
}

describe('verifyCitations', () => {
  it('keeps found quotes, flags fabricated ones and unreadable sources, and reads each version once', async () => {
    const reads: string[] = [];
    const result = await verifyCitations(
      [
        cite({ quote: 'my niece Harper Vale', verified: false }),
        cite({ page: 2, quote: 'the residue to the Fictional Lighthouse Trust' }),
        cite({ page: 2, quote: 'the residue to my nephew' }),
        cite({ docVersion: 1, quote: 'my niece Harper Vale' }),
        cite({ documentId: 'd-broken', quote: 'anything' }),
      ],
      SCOPE,
      pages(reads),
    );
    expect(result.citations.map((c) => c.verified)).toEqual([undefined, undefined, false, false, false]);
    expect(result).toMatchObject({ verified: 2, unverified: 3 });
    expect(reads).toEqual(['d-will@2', 'd-will@1', 'd-broken@2']);
  });
});
