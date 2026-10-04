import { mapCitations, MAX_QUOTE_LENGTH } from './citations';

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
      { documentId: 'doc-will', version: 2, page: 3, quote: 'I appoint my sister' },
      { documentId: 'doc-letter', version: 1, page: 2, quote: 'dated 4 March' },
      { documentId: 'doc-custom', version: 3, page: 4, quote: 'the residue' },
      { documentId: 'doc-affidavit', version: 1, page: 7, quote: 'sworn on' },
      { documentId: 'doc-note', version: 1, quote: 'no page here' },
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
});
