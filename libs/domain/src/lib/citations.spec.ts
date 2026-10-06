import {
  checkCitations,
  matchQuote,
  normaliseQuote,
  QUOTE_MATCH_THRESHOLD,
  quoteScore,
  truncateQuote,
  verifyQuote,
} from './citations';
import { CitationObjectSchema, CitationSchema, isDocumentCitation } from './schemas/common';

// The fictional will fixture's pages (libs/test-utils/fixtures/pdfs/will.pdf), as AI-04 extracts them.
const WILL = [
  'SAMPLE — FICTIONAL DOCUMENT FOR TESTING ONLY LAST WILL AND TESTAMENT of Margaret Anne Doyle (fictional) ' +
    '1. I revoke all former wills and testamentary dispositions made by me. 2. I appoint my daughter Catherine ' +
    'Doyle and my friend Peter Hale to be the executors and trustees of this will. 3. I give my residence at 1 ' +
    'Example Street, Geelong to my daughter Catherine Doyle. 4. I give the residue of my estate to my daughter ' +
    'Catherine Doyle absolutely. 5. I make no provision for my son Thomas Doyle, for reasons he understands.',
  'SAMPLE — FICTIONAL DOCUMENT FOR TESTING ONLY 6. I direct that my executors pay my funeral expenses and debts ' +
    'from my estate. 7. I declare that this will is governed by the law of Victoria.',
];

describe('normaliseQuote', () => {
  it('unifies quote marks, dashes and whitespace, and lower-cases', () => {
    expect(normaliseQuote('  “My  House”\n— it’s\tmine ')).toBe('"my house" - it\'s mine');
    expect(normaliseQuote('ﬁnal­ly')).toBe('finally');
  });
});

describe('matchQuote', () => {
  it('finds an exact quote despite case, quotes, spacing and punctuation, with original offsets', () => {
    const text = 'Clause 4: I give the “Residue”   of my\nestate to Catherine.';
    const match = matchQuote('the "residue" of my estate', text);
    expect(match?.score).toBe(1);
    const range = match?.ranges[0];
    expect(text.slice(range?.start, range?.end)).toBe('the “Residue”   of my\nestate');
  });

  it('accepts a near match at or above the threshold (OCR slips) and rejects a fabricated quote', () => {
    const ocr = 'I appoint my daughter Catherlne Doyie and my friend Peter Hale to be the executors.';
    const near = matchQuote('I appoint my daughter Catherine Doyle and my friend Peter Hale', ocr);
    expect(near?.score).toBeGreaterThanOrEqual(QUOTE_MATCH_THRESHOLD);
    expect(near?.score).toBeLessThan(1);
    expect(matchQuote('I appoint my son Thomas Doyle as sole executor', WILL[0] as string)).toBeNull();
    expect(quoteScore('my accounts with any bank', WILL.join(' '))).toBe(0);
  });

  it('needs short quotes to match exactly', () => {
    expect(matchQuote('Doyle', WILL[0] as string)?.score).toBe(1);
    expect(matchQuote('Doylf', WILL[0] as string)).toBeNull();
  });

  it('matches each piece of an ellipsised quote in order', () => {
    const match = matchQuote('I appoint my daughter … the executors and trustees', WILL[0] as string);
    expect(match?.ranges).toHaveLength(2);
    expect(matchQuote('the executors and trustees ... I appoint my daughter', WILL[0] as string)).toBeNull();
  });

  it('handles empty input', () => {
    expect(matchQuote('', 'text')).toBeNull();
    expect(matchQuote('quote', '')).toBeNull();
    expect(matchQuote('…', 'text')).toBeNull();
  });
});

describe('verifyQuote', () => {
  it('checks the cited page only', () => {
    expect(verifyQuote({ quote: 'the residue of my estate', page: 1 }, WILL)).toEqual({ verified: true, score: 1 });
    expect(verifyQuote({ quote: 'the residue of my estate', page: 2 }, WILL).verified).toBe(false);
  });

  it('finds a quote that runs over the page break', () => {
    const spanning = { quote: 'for reasons he understands. SAMPLE — FICTIONAL DOCUMENT FOR TESTING ONLY 6. I direct' };
    expect(verifyQuote({ ...spanning, page: 1 }, WILL).verified).toBe(true);
    expect(verifyQuote({ ...spanning, page: 1, pageEnd: 2 }, WILL).verified).toBe(true);
  });

  it('searches the whole document without a page', () => {
    expect(verifyQuote({ quote: 'governed by the law of Victoria' }, WILL).verified).toBe(true);
  });
});

describe('checkCitations', () => {
  it('rejects fabricated quotes and sources without text', () => {
    const citations = [
      { documentId: 'will', page: 2, quote: 'pay my funeral expenses and debts' },
      { documentId: 'will', page: 1, quote: 'I leave my car to Peter Hale' },
      { documentId: 'missing', page: 1, quote: 'anything at all' },
    ];
    const results = checkCitations(citations, (c) => (c.documentId === 'will' ? WILL : undefined));
    expect(results.map((r) => r.verified)).toEqual([true, false, false]);
    expect(results[2]?.score).toBe(0);
  });
});

describe('truncateQuote', () => {
  it('keeps short quotes and cuts long ones at a word', () => {
    expect(truncateQuote('short  quote')).toBe('short quote');
    const long = truncateQuote(WILL[0] as string, 60);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
    expect(truncateQuote('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('CitationSchema', () => {
  it('reads AI-02/AI-07 shapes, moving version to docVersion and defaulting the kind', () => {
    expect(CitationSchema.parse({ documentId: 'd-1', version: 2, page: 3, quote: 'q' })).toEqual({
      kind: 'document',
      documentId: 'd-1',
      docVersion: 2,
      page: 3,
      quote: 'q',
    });
    expect(CitationSchema.parse({ documentId: 'd-1', quote: 'q' })).toEqual({
      kind: 'document',
      documentId: 'd-1',
      quote: 'q',
    });
    expect(CitationSchema.parse({ documentId: 'd-1', docVersion: 3, version: 2, quote: 'q' }).docVersion).toBe(3);
  });

  it('takes record citations and checks what each kind needs', () => {
    const record = CitationSchema.parse({
      kind: 'record',
      recordRef: { collection: 'deadlines', id: 'dl-1' },
      quote: 'Notice to creditors expires',
    });
    expect(isDocumentCitation(record)).toBe(false);
    expect(CitationSchema.safeParse({ kind: 'record', quote: 'q' }).success).toBe(false);
    expect(CitationSchema.safeParse({ kind: 'document', quote: 'q' }).success).toBe(false);
    expect(CitationSchema.safeParse({ documentId: 'd', quote: 'q', charStart: 5, charEnd: 2 }).success).toBe(false);
    expect(CitationSchema.safeParse({ documentId: 'd', quote: 'q', pageEnd: 2 }).success).toBe(false);
    expect(CitationObjectSchema.safeParse({ documentId: 'd', quote: 'q', page: 2, pageEnd: 3 }).success).toBe(true);
    expect(isDocumentCitation(CitationSchema.parse({ documentId: 'd', quote: 'q' }))).toBe(true);
  });
});
