import { markdownToWordml, parseBlocks, parseInline } from './markdown';

/** Markdown → WordprocessingML for the `{@body}` block (INT-06). */

const plain = { bold: false, italic: false, highlight: false };

describe('parseInline', () => {
  it('reads bold, italics and both', () => {
    expect(parseInline('a **b** *c* ***d*** __e__ _f_')).toEqual([
      { text: 'a ', ...plain },
      { text: 'b', ...plain, bold: true },
      { text: ' ', ...plain },
      { text: 'c', ...plain, italic: true },
      { text: ' ', ...plain },
      { text: 'd', ...plain, bold: true, italic: true },
      { text: ' ', ...plain },
      { text: 'e', ...plain, bold: true },
      { text: ' ', ...plain },
      { text: 'f', ...plain, italic: true },
    ]);
  });

  it('keeps underscores inside words, escaped markers and a lone asterisk as text', () => {
    expect(parseInline('file_note_v2 \\*not italic\\* 5 * 3')).toEqual([
      { text: 'file_note_v2 *not italic* 5 * 3', ...plain },
    ]);
  });

  it('keeps a link’s text and highlights placeholders', () => {
    expect(parseInline('See [the Act](https://example.com/act) by [[TO CONFIRM: grant date]].')).toEqual([
      { text: 'See the Act by ', ...plain },
      { text: '[[TO CONFIRM: grant date]]', ...plain, highlight: true },
      { text: '.', ...plain },
    ]);
  });

  it('carries an unclosed marker to the end of the line', () => {
    expect(parseInline('**unclosed')).toEqual([{ text: 'unclosed', ...plain, bold: true }]);
  });
});

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines and keeps their lines', () => {
    expect(parseBlocks('Dear Catherine,\n\nThank you.\nKind regards')).toEqual([
      { kind: 'paragraph', lines: ['Dear Catherine,'] },
      { kind: 'paragraph', lines: ['Thank you.', 'Kind regards'] },
    ]);
  });

  it('reads headings to level 3, rules and quotes', () => {
    expect(parseBlocks('# One\n## Two ##\n#### Four\n---\n> Quoted\n> on two lines\nAfter')).toEqual([
      { kind: 'heading', level: 1, text: 'One' },
      { kind: 'heading', level: 2, text: 'Two' },
      { kind: 'heading', level: 3, text: 'Four' },
      { kind: 'quote', lines: ['Quoted', 'on two lines'] },
      { kind: 'paragraph', lines: ['After'] },
    ]);
  });

  it('numbers lists from their first number, two levels deep, and restarts after a gap', () => {
    const items = parseBlocks('3. Three\n1. Four\n   - Sub\n   - Sub two\n2. Five\n\n1. Again')
      .filter((block) => block.kind === 'item')
      .map((block) => [block.ordered, block.level, block.number, block.text]);
    expect(items).toEqual([
      [true, 0, 3, 'Three'],
      [true, 0, 4, 'Four'],
      [false, 1, 0, 'Sub'],
      [false, 1, 0, 'Sub two'],
      [true, 0, 5, 'Five'],
      [true, 0, 1, 'Again'],
    ]);
  });

  it('reads Windows line endings', () => {
    expect(parseBlocks('One\r\nTwo\r\n\r\nThree')).toEqual([
      { kind: 'paragraph', lines: ['One', 'Two'] },
      { kind: 'paragraph', lines: ['Three'] },
    ]);
  });
});

describe('markdownToWordml', () => {
  it('writes paragraphs with runs and line breaks', () => {
    expect(markdownToWordml('Dear **Catherine**,\nthank you')).toBe(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
        '<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">Catherine</w:t></w:r>' +
        '<w:r><w:t xml:space="preserve">,</w:t></w:r>' +
        '<w:r><w:br/><w:t xml:space="preserve">thank you</w:t></w:r></w:p>',
    );
  });

  it('escapes XML and drops characters XML can’t hold', () => {
    const xml = markdownToWordml('Smith & Co <legal> "quoted"\u0007');
    expect(xml).toContain('Smith &amp; Co &lt;legal&gt; &quot;quoted&quot;</w:t>');
    expect(xml).not.toContain('\u0007');
  });

  it('uses the template’s heading styles, or bold text when it has none', () => {
    expect(markdownToWordml('## Next steps', { styles: new Set(['Heading2']) })).toBe(
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Next steps</w:t></w:r></w:p>',
    );
    expect(markdownToWordml('## Next *steps*')).toBe(
      '<w:p><w:pPr><w:keepNext/><w:spacing w:before="240"/></w:pPr>' +
        '<w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">Next </w:t></w:r>' +
        '<w:r><w:rPr><w:b/><w:bCs/><w:i/><w:iCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">steps</w:t></w:r></w:p>',
    );
  });

  it('draws bullets and numbers with a hanging indent', () => {
    const xml = markdownToWordml('- Locate the will\n  - Original\n1. Apply for the grant');
    expect(xml).toContain(
      '<w:ind w:left="720" w:hanging="360"/></w:pPr><w:r><w:t xml:space="preserve">•</w:t></w:r><w:r><w:tab/></w:r>',
    );
    expect(xml).toContain('<w:ind w:left="1080" w:hanging="360"/></w:pPr><w:r><w:t xml:space="preserve">–</w:t></w:r>');
    expect(xml).toContain('<w:t xml:space="preserve">1.</w:t>');
  });

  it('indents quotes, highlights placeholders and writes nothing for an empty body', () => {
    expect(markdownToWordml('> [[TO CONFIRM]]')).toBe(
      '<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">[[TO CONFIRM]]</w:t></w:r></w:p>',
    );
    expect(markdownToWordml('')).toBe('');
    expect(markdownToWordml('\n\n')).toBe('');
  });
});
