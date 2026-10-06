import { citedClaims, citedQuote, mapCitations, markClaims, MAX_QUOTE_LENGTH } from './citations';

const documents = [
  { documentId: 'doc-will', version: 2 },
  { documentId: 'doc-letter', version: 1, pageOffsets: [0, 1200, 2500] },
  { documentId: 'doc-custom', version: 3, blockPages: [1, 1, 4] },
];
const searchResults = [
  { documentId: 'doc-affidavit', version: 1, page: 7 },
  { documentId: 'doc-note', version: 1 },
];

describe('mapCitations', () => {
  it('maps page, character, content-block and search-result locations', () => {
    const { citations, unmapped } = mapCitations(
      [
        {
          type: 'page_location',
          document_index: 0,
          cited_text: 'I appoint my sister',
          start_page_number: 3,
          end_page_number: 4,
        },
        {
          type: 'char_location',
          document_index: 1,
          cited_text: 'dated 4 March',
          start_char_index: 1300,
          end_char_index: 1313,
        },
        {
          type: 'content_block_location',
          document_index: 2,
          cited_text: 'the residue',
          start_block_index: 2,
          end_block_index: 3,
        },
        { type: 'search_result_location', search_result_index: 0, cited_text: 'sworn on' },
        { type: 'search_result_location', search_result_index: 1, cited_text: 'no page here' },
      ],
      { documents, searchResults },
    );
    expect(citations).toEqual([
      { kind: 'document', documentId: 'doc-will', docVersion: 2, page: 3, quote: 'I appoint my sister' },
      {
        kind: 'document',
        documentId: 'doc-letter',
        docVersion: 1,
        page: 2,
        charStart: 100,
        charEnd: 113,
        quote: 'dated 4 March',
      },
      { kind: 'document', documentId: 'doc-custom', docVersion: 3, page: 4, quote: 'the residue' },
      { kind: 'document', documentId: 'doc-affidavit', docVersion: 1, page: 7, quote: 'sworn on' },
      { kind: 'document', documentId: 'doc-note', docVersion: 1, quote: 'no page here' },
    ]);
    expect(unmapped).toBe(0);
  });

  it('drops unknown sources, empty quotes and duplicates, and truncates long quotes', () => {
    const long = 'x'.repeat(MAX_QUOTE_LENGTH + 50);
    const { citations, unmapped } = mapCitations(
      [
        { type: 'page_location', document_index: 9, cited_text: 'invented', start_page_number: 1, end_page_number: 1 },
        { type: 'search_result_location', search_result_index: 5, cited_text: 'invented' },
        { type: 'char_location', document_index: 0, cited_text: '   ', start_char_index: 0, end_char_index: 3 },
        { type: 'web_search_result_location', cited_text: 'not ours' },
        { type: 'char_location', document_index: 0, cited_text: long, start_char_index: 0, end_char_index: 1 },
        { type: 'char_location', document_index: 0, cited_text: long, start_char_index: 0, end_char_index: 1 },
      ],
      { documents, searchResults },
    );
    expect(citations).toHaveLength(1);
    expect(citations[0]?.quote).toHaveLength(MAX_QUOTE_LENGTH);
    expect(citations[0]?.page).toBeUndefined();
    expect(unmapped).toBe(4);
  });

  it('quotes a search result without its excerpt framing, which the API cites with it', () => {
    const framed = '<excerpt document="doc-affidavit" version="1" page="7">\nI was sworn on 3 May.\n</excerpt>';
    const { citations } = mapCitations(
      [{ type: 'search_result_location', search_result_index: 0, cited_text: framed }],
      { documents, searchResults },
    );
    expect(citations[0]).toMatchObject({ documentId: 'doc-affidavit', page: 7, quote: 'I was sworn on 3 May.' });
    // A quote capped before its closing tag, and an escaped tag inside a source, which stays.
    expect(citedQuote({ type: 'search_result_location', cited_text: '<excerpt page="2">\nThe will' })).toBe('The will');
    expect(citedQuote({ type: 'char_location', cited_text: '&lt;document> is a word' })).toBe(
      '&lt;document> is a word',
    );
  });
});

describe('page and character ranges', () => {
  it('keeps the last page of a quote that runs over a page break', () => {
    const { citations } = mapCitations(
      [
        {
          type: 'page_location',
          document_index: 0,
          cited_text: 'over the break',
          start_page_number: 2,
          end_page_number: 4,
        },
        {
          type: 'char_location',
          document_index: 1,
          cited_text: 'across pages',
          start_char_index: 1190,
          end_char_index: 1210,
        },
        { type: 'char_location', document_index: 3, cited_text: 'no pages', start_char_index: 40, end_char_index: 48 },
        {
          type: 'content_block_location',
          document_index: 2,
          cited_text: 'blocks',
          start_block_index: 1,
          end_block_index: 3,
        },
      ],
      { documents: [...documents, { documentId: 'doc-plain', version: 1 }], searchResults },
    );
    expect(citations[0]).toMatchObject({ page: 2, pageEnd: 3 });
    expect(citations[1]).toMatchObject({ page: 1, pageEnd: 2, charStart: 1190 });
    expect(citations[1]?.charEnd).toBeUndefined();
    expect(citations[2]).toMatchObject({ charStart: 40, charEnd: 48 });
    expect(citations[2]?.page).toBeUndefined();
    expect(citations[3]).toMatchObject({ page: 1, pageEnd: 4 });
  });
});

describe('claims and markers', () => {
  const sources = { documents, searchResults };
  const sworn = { type: 'search_result_location', search_result_index: 0, cited_text: 'sworn on' };
  const sister = {
    type: 'page_location',
    document_index: 0,
    cited_text: 'I appoint my sister',
    start_page_number: 3,
    end_page_number: 4,
  };

  it('numbers each cited block after its text, before trailing whitespace', () => {
    const content = [
      { type: 'text', text: 'The affidavit was sworn in May' },
      { type: 'text', text: 'Her sister is executor.\n\n', citations: [sister, sworn] },
      { type: 'text', text: 'It was sworn.', citations: [sworn] },
      { type: 'thinking', thinking: 'hidden' },
    ];
    const mapped = mapCitations([sister, sworn, sworn], sources).citations;
    const claims = citedClaims(content, 'ignored', mapped, sources);
    expect(claims.map((claim) => claim.refs)).toEqual([[], [0, 1], [1]]);
    expect(markClaims(claims)).toBe('The affidavit was sworn in MayHer sister is executor.[1, 2]\n\nIt was sworn.[2]');
  });

  it('cites the whole answer when the turn has citations but no block carries them', () => {
    const mapped = mapCitations([sworn], sources).citations;
    const claims = citedClaims([{ type: 'text', text: 'Sworn.' }], 'Sworn.', mapped, sources);
    expect(markClaims(claims)).toBe('Sworn.[1]');
    expect(markClaims(citedClaims([{ type: 'text', text: 'Hi' }], 'Hi', [], sources))).toBe('Hi');
  });
});
