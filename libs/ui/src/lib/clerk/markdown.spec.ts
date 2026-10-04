import { citedRefs, inlineText, isSafeUrl, type MdBlock, parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('parses bold, italic, code, links and citations', () => {
    expect(
      parseInline('**Thomas** is *likely* to claim `s 57`[1, 2] see [the Act](https://legislation.nsw.gov.au)'),
    ).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'Thomas' }] },
      { type: 'text', text: ' is ' },
      { type: 'em', children: [{ type: 'text', text: 'likely' }] },
      { type: 'text', text: ' to claim ' },
      { type: 'code', text: 's 57' },
      { type: 'cite', refs: [1, 2] },
      { type: 'text', text: ' see ' },
      { type: 'link', href: 'https://legislation.nsw.gov.au', children: [{ type: 'text', text: 'the Act' }] },
    ]);
    expect(parseInline('__bold__ and _em_')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'em' }] },
    ]);
  });

  it('keeps snake_case, lone markers and unmatched backticks as text when complete', () => {
    expect(inlineText(parseInline('file_note_14 and 3 * 4 = 12'))).toBe('file_note_14 and 3 * 4 = 12');
    expect(parseInline('a ` b')).toEqual([{ type: 'text', text: 'a ` b' }]);
    expect(parseInline('**open')).toEqual([{ type: 'text', text: '**open' }]);
    expect(parseInline('[not a link] and [1')).toEqual([{ type: 'text', text: '[not a link] and [1' }]);
  });

  it('blocks raw HTML, javascript: URLs and images', () => {
    expect(parseInline('<script>alert(1)</script>')).toEqual([{ type: 'text', text: '<script>alert(1)</script>' }]);
    // The link is dropped and only its text kept (the stray `)` is the URL's own closing paren).
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ type: 'text', text: 'click)' }]);
    expect(parseInline('[data](data:text/html;base64,xx)')).toEqual([{ type: 'text', text: 'data' }]);
    expect(parseInline('![tracking pixel](https://evil.example/p.gif)')).toEqual([
      { type: 'text', text: 'tracking pixel' },
    ]);
    expect(parseInline('[mail](mailto:executor@example.com)')[0]).toEqual({
      type: 'link',
      href: 'mailto:executor@example.com',
      children: [{ type: 'text', text: 'mail' }],
    });
    expect(isSafeUrl(' https://a.example')).toBe(true);
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeUrl('/relative')).toBe(false);
  });

  it('renders half-finished syntax tolerantly while streaming', () => {
    expect(parseInline('Most likely **Thomas Whit', true)).toEqual([
      { type: 'text', text: 'Most likely ' },
      { type: 'strong', children: [{ type: 'text', text: 'Thomas Whit' }] },
    ]);
    expect(parseInline('He is eligible[1', true)).toEqual([{ type: 'text', text: 'He is eligible' }]);
    expect(parseInline('He is eligible[', true)).toEqual([{ type: 'text', text: 'He is eligible' }]);
    expect(parseInline('see [the Act](https://leg', true)).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'text', text: 'the Act' },
    ]);
    expect(parseInline('run `npm', true)).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'npm' },
    ]);
    expect(parseInline('a `', true)).toEqual([{ type: 'text', text: 'a ' }]);
    expect(parseInline('an *emph', true)).toEqual([
      { type: 'text', text: 'an ' },
      { type: 'em', children: [{ type: 'text', text: 'emph' }] },
    ]);
    expect(parseInline('trailing *', true)).toEqual([{ type: 'text', text: 'trailing ' }]);
    expect(parseInline('bold **', true)).toEqual([{ type: 'text', text: 'bold ' }]);
    expect(parseInline('pic ![alt](https://x', true)).toEqual([{ type: 'text', text: 'pic ' }]);
  });
});

describe('parseMarkdown', () => {
  const doc = [
    '## Summary',
    '**Most likely Thomas.** He is an eligible person[1]',
    'and clause 6 leaves him nothing.[2]',
    '',
    '- The super could be notional estate.[3]',
    '- The file note records a request.[4]',
    '',
    '1. First',
    '2. Second',
    '',
    '> Quoted from the will',
    '> continued',
    '',
    '```',
    '<b>not html</b>',
    '```',
  ].join('\n');

  it('parses headings, paragraphs, lists, quotes and code', () => {
    const blocks = parseMarkdown(doc);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code']);
    const paragraph = blocks[1] as Extract<MdBlock, { type: 'paragraph' }>;
    expect(inlineText(paragraph.children)).toBe(
      'Most likely Thomas. He is an eligible person and clause 6 leaves him nothing.',
    );
    expect((blocks[2] as Extract<MdBlock, { type: 'list' }>).ordered).toBe(false);
    expect((blocks[3] as Extract<MdBlock, { type: 'list' }>).ordered).toBe(true);
    expect(inlineText((blocks[4] as Extract<MdBlock, { type: 'quote' }>).children)).toBe(
      'Quoted from the will continued',
    );
    expect(blocks[5]).toEqual({ type: 'code', text: '<b>not html</b>' });
    expect(citedRefs(blocks)).toEqual([1, 2, 3, 4]);
  });

  it('handles CRLF, ~~~ fences and an unclosed fence while streaming', () => {
    expect(parseMarkdown('a\r\nb')).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'a b' }] }]);
    expect(parseMarkdown('~~~\ncode\n~~~')).toEqual([{ type: 'code', text: 'code' }]);
    expect(parseMarkdown('Intro\n```\nconst x = 1', true)).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'Intro' }] },
      { type: 'code', text: 'const x = 1' },
    ]);
  });

  it('hides a lone block marker at the end of a stream', () => {
    expect(parseMarkdown('Para\n\n-', true)).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'Para' }] },
    ]);
    expect(parseMarkdown('Para\n#', true)).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'Para' }] }]);
    expect(parseMarkdown('Para\n-')).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'Para -' }] }]);
  });

  it('collects citation refs from every block kind', () => {
    expect(citedRefs(parseMarkdown('# H[5]\n> q[6]\n- *i[7]*\n\n```\n[8]\n```'))).toEqual([5, 6, 7]);
    expect(inlineText(parseInline('[x](https://a.example) `c`[1]'))).toBe('x c');
  });
});
