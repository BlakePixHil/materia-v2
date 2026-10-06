import { createHash } from 'node:crypto';

import { domain } from '../domain.ts';
import { escapeText, htmlToMarkdown, htmlToText, type HtmlOptions, type InlineImage } from './html.ts';

/** Members mention as `@[uid]`; images become a placeholder naming their index. */
const OPTIONS: HtmlOptions = {
  mention: (uid) => domain.memberMentionToken(uid),
  imageText: (index) => `(image ${index + 1})`,
};
const md = (html: string, options: HtmlOptions = OPTIONS) => htmlToMarkdown(html, options);
const markdown = (html: string) => md(html).markdown;

/** A 1×1 transparent PNG (synthetic). */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

describe('htmlToMarkdown: paragraphs and Quill quirks', () => {
  it("gives '' for empty input and Quill's empty editor", () => {
    expect(md('')).toEqual({ markdown: '', images: [], unsafeRemoved: 0, remoteImages: 0 });
    expect(markdown('<p><br></p>')).toBe('');
    expect(markdown('<p><br></p><p><br></p>')).toBe('');
    expect(markdown('<p>   </p>')).toBe('');
  });

  it('keeps one Quill paragraph per line, and an empty paragraph as a paragraph break', () => {
    expect(markdown('<p>Line one</p><p>Line two</p>')).toBe('Line one\nLine two');
    expect(markdown('<p>Para one</p><p><br></p><p>Para two</p>')).toBe('Para one\n\nPara two');
    expect(markdown('<p>Para one</p><p><br></p><p><br></p><p><br></p><p>Para two</p>')).toBe('Para one\n\nPara two');
    expect(markdown('<div>one</div><div>two</div>')).toBe('one\ntwo');
  });

  it('reads plain text as a paragraph', () => {
    expect(markdown('Plain text comment')).toBe('Plain text comment');
    expect(markdown('  spaced   out  ')).toBe('spaced out');
  });

  it('keeps the line breaks of plain text (no tags)', () => {
    expect(markdown('Line one\nLine two')).toBe('Line one\nLine two');
    expect(markdown('Line one\r\nLine two')).toBe('Line one\nLine two');
  });

  it('reads & and > in plain text as text, entities included', () => {
    expect(markdown('A & B > C &amp; D &lt;p&gt;')).toBe('A & B > C &amp; D &lt;p&gt;');
  });

  it('neutralises literal mention syntax in plain text', () => {
    const result = markdown('Ask @[FictionalUid0001]\nabout #[FictionalMatter1]');
    expect(result).toBe('Ask @\u200B[FictionalUid0001]\nabout #\u200B[FictionalMatter1]');
    expect(domain.parseMentions(result)).toEqual({ uids: [], matterIds: [] });
  });

  it('parts plain-text paragraphs at two or more blank lines', () => {
    expect(markdown('Para one\n\n\n\nPara two')).toBe('Para one\n\nPara two');
  });

  it('parts plain-text paragraphs at a blank line', () => {
    expect(markdown('Para one\n\nPara two')).toBe('Para one\n\nPara two');
    expect(markdown('Para one\r\n \r\nPara two\r\nline')).toBe('Para one\n\nPara two\nline');
  });

  it('ignores ql-* classes and drops inline styles without counting them unsafe', () => {
    expect(markdown('<p class="ql-align-center ql-indent-1">Centred</p>')).toBe('Centred');
    const styled = md('<p style="font-size: 20px"><span style="color: rgb(230, 0, 0);">Red</span> text</p>');
    expect(styled).toMatchObject({ markdown: 'Red text', unsafeRemoved: 0 });
  });

  it('collapses whitespace, decodes entities and drops Quill zero-width characters', () => {
    expect(markdown('<p>  a \n\t  b  </p>')).toBe('a b');
    expect(markdown('<p>a&nbsp;b &amp; c\uFEFF</p>')).toBe('a b & c');
  });

  it('ignores comments', () => {
    expect(markdown('<!-- hidden note --><p>shown</p>')).toBe('shown');
  });
});

describe('htmlToMarkdown: inline formatting', () => {
  it('writes bold, italic and inline code', () => {
    expect(markdown('<p><strong>Bold</strong> and <em>italic</em>, <b>b</b> and <i>i</i></p>')).toBe(
      '**Bold** and *italic*, **b** and *i*',
    );
    expect(markdown('<p>Run <code>x = 1</code> now</p>')).toBe('Run `x = 1` now');
  });

  it('moves spaces outside the markers, and drops markers around nothing', () => {
    expect(markdown('<p>a<strong> bold </strong>b</p>')).toBe('a **bold** b');
    expect(markdown('<p>x<strong> </strong>y<em></em></p>')).toBe('x y');
  });

  it('keeps code with a backtick, or only spaces, as plain text', () => {
    expect(markdown('<p><code>a`b</code></p>')).toBe('a`b');
    expect(markdown('<p>x<code> </code>y</p>')).toBe('x y');
  });

  it('unwraps formatting it has no Markdown for', () => {
    expect(markdown('<p><u>under</u> <s>struck</s> <sub>2</sub></p>')).toBe('under struck 2');
  });

  it('turns <br> into a line break', () => {
    expect(markdown('<p>one<br>two</p>')).toBe('one\ntwo');
  });

  it('reads a block met inside inline content as its own line', () => {
    expect(markdown('<strong><p>x</p></strong>')).toBe('**x**');
    expect(markdown('<p><span><ul><li>in span</li></ul></span></p>')).toBe('- in span');
  });
});

describe('htmlToMarkdown: links', () => {
  it('keeps http, https and mailto links', () => {
    expect(markdown('<p><a href="https://example.com/brief" target="_blank" rel="noopener">the brief</a></p>')).toBe(
      '[the brief](https://example.com/brief)',
    );
    expect(markdown('<p><a href="http://example.com">http://example.com</a></p>')).toBe(
      '[http://example.com](http://example.com)',
    );
    expect(markdown('<p><a href="mailto:jordan@example.com">jordan@example.com</a></p>')).toBe(
      '[jordan@example.com](mailto:jordan@example.com)',
    );
    expect(markdown('<p><a href=" https://example.com/x ">x</a></p>')).toBe('[x](https://example.com/x)');
  });

  it('uses the address as the text of a link with none', () => {
    expect(markdown('<p><a href="https://example.com/a"></a></p>')).toBe(
      '[https://example.com/a](https://example.com/a)',
    );
  });

  it('keeps formatting inside the link text', () => {
    expect(markdown('<p><a href="https://example.com/x"><strong>Bold</strong> link</a></p>')).toBe(
      '[**Bold** link](https://example.com/x)',
    );
  });

  it('puts the address after the text when the text or address would break the link syntax', () => {
    expect(markdown('<p><a href="https://example.com/a">see [1]</a></p>')).toBe('see [1] (https://example.com/a)');
    expect(markdown('<p><a href="https://example.com/a_(b)">wiki</a></p>')).toBe('wiki (https://example.com/a_(b))');
    expect(markdown('<p><a href="https://example.com">a<br>b</a></p>')).toBe('a\nb (https://example.com)');
  });

  it('drops javascript: links to their text and counts them unsafe', () => {
    expect(md('<p><a href="javascript:alert(1)">Click</a></p>')).toMatchObject({ markdown: 'Click', unsafeRemoved: 1 });
    expect(md('<p><a href=" JavaScript:void(0)" onclick="go()">both</a></p>')).toMatchObject({
      markdown: 'both',
      unsafeRemoved: 2,
    });
  });

  it('drops other schemes and relative links to their text, without counting them unsafe', () => {
    expect(md('<p><a href="ftp://example.com/x">ftp</a> <a href="/relative">rel</a> <a>none</a></p>')).toMatchObject({
      markdown: 'ftp rel none',
      unsafeRemoved: 0,
    });
  });

  it('counts an event handler on a kept link', () => {
    expect(md('<p><a href="https://example.com" onclick="x()">e</a></p>')).toMatchObject({
      markdown: '[e](https://example.com)',
      unsafeRemoved: 1,
    });
  });
});

describe('htmlToMarkdown: blocks', () => {
  it('writes headings, capped at level 3, with a blank line around them', () => {
    expect(markdown('<h1>Title</h1><p>Body</p>')).toBe('# Title\n\nBody');
    expect(markdown('<p>Intro</p><h2>Sub <em>x</em></h2><h4>Deep</h4><h6>Deeper</h6><p>End</p>')).toBe(
      'Intro\n\n## Sub *x*\n\n### Deep\n\n### Deeper\n\nEnd',
    );
    expect(markdown('<h3>Two<br>lines</h3>')).toBe('### Two lines');
  });

  it('drops empty headings', () => {
    expect(markdown('<p>a</p><h3></h3><h1> </h1><p>b</p>')).toBe('a\nb');
  });

  it('reads Quill 2 lists by each item’s data-list', () => {
    expect(
      markdown(
        '<ol><li data-list="ordered">One</li><li data-list="ordered">Two</li><li data-list="bullet">Dot</li><li data-list="ordered">Three</li></ol>',
      ),
    ).toBe('1. One\n2. Two\n- Dot\n3. Three');
    expect(
      markdown(
        '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>A</li><li data-list="bullet">B</li></ol>',
      ),
    ).toBe('- A\n- B');
  });

  it('reads plain lists by their element, skipping empty items, with a blank line around them', () => {
    expect(markdown('<ul><li>a</li><li></li><li>b</li></ul><ol><li>x</li><li>y</li></ol>')).toBe(
      '- a\n- b\n\n1. x\n2. y',
    );
    expect(markdown('<p>Before</p><ul><li>a</li></ul><p>After</p>')).toBe('Before\n\n- a\n\nAfter');
    expect(markdown('<ul>stray<li>a</li></ul>')).toBe('- a');
  });

  it('reads a list item outside a list as a bullet', () => {
    expect(markdown('<li>orphan</li><li> </li>')).toBe('- orphan');
  });

  it('quotes blockquotes line by line', () => {
    expect(markdown('<blockquote>Quoted</blockquote>')).toBe('> Quoted');
    expect(markdown('<blockquote><p>a</p><p><br></p><p>b</p></blockquote><p>c</p>')).toBe('> a\n> b\n\nc');
  });

  it('fences pre blocks, keeping their spacing and dropping trailing newlines', () => {
    expect(markdown('<pre class="ql-syntax" spellcheck="false">const a = 1;\n  indented\n\n</pre>')).toBe(
      '```\nconst a = 1;\n  indented\n```',
    );
    expect(markdown('<p>Before</p><pre>x</pre><p>After</p>')).toBe('Before\n\n```\nx\n```\n\nAfter');
  });

  it('writes pre content as text: no Markdown inside the fence', () => {
    expect(
      markdown('<pre><strong>b</strong> <em>i</em> <a href="https://example.com">l</a> <code>c</code><br>next</pre>'),
    ).toBe('```\nb i l c\nnext\n```');
  });

  it('drops an empty pre', () => {
    expect(markdown('<pre> </pre><pre>\n</pre>')).toBe('');
  });

  it('keeps a fence line inside a pre from ending the fence', () => {
    expect(markdown('<pre>```\nx</pre>')).toBe('```\n\u200B```\nx\n```');
    expect(markdown('<pre>```\nx\n  ~~~</pre>')).toBe('```\n\u200B```\nx\n  \u200B~~~\n```');
  });

  it('never lets a fence line inside a pre end the fence early', () => {
    const result = markdown('<pre>```\n@[FictionalUid0001]\n  ```\n#[FictionalMatter1]</pre>');
    expect(domain.parseMentions(result)).toEqual({ uids: [], matterIds: [] });
  });

  it('separates paragraphs around a horizontal rule', () => {
    expect(markdown('<p>a</p><hr><p>b</p>')).toBe('a\n\nb');
  });

  it('reads tables row by row', () => {
    expect(
      markdown('<table><tr><th>Name</th><th>Role</th></tr><tr><td>Sam</td><td>Executor</td></tr></table><p>after</p>'),
    ).toBe('Name Role\nSam Executor\n\nafter');
    expect(markdown('<td>cell</td>')).toBe('cell');
  });
});

describe('htmlToMarkdown: mentions', () => {
  const QUILL_MENTION =
    '<p>Ask <span class="mention" data-index="0" data-denotation-char="@" data-id="JordanEllisLegacyUid00000002" data-value="Jordan Ellis">\uFEFF<span contenteditable="false"><span class="ql-mention-denotation-char">@</span>Jordan Ellis</span>\uFEFF</span> about the trust.</p>';

  it('routes a Quill mention through options.mention with its uid and name', () => {
    const mention = vi.fn((uid: string, name: string) => `@${name} (imported, ${uid})`);
    const result = md(QUILL_MENTION, { ...OPTIONS, mention });
    expect(mention).toHaveBeenCalledExactlyOnceWith('JordanEllisLegacyUid00000002', 'Jordan Ellis');
    expect(result.markdown).toBe('Ask @Jordan Ellis (imported, JordanEllisLegacyUid00000002) about the trust.');
  });

  it('keeps a member mention as a token the notes parser reads', () => {
    const result = markdown(QUILL_MENTION);
    expect(result).toBe('Ask @[JordanEllisLegacyUid00000002] about the trust.');
    expect(domain.parseMentions(result).uids).toEqual(['JordanEllisLegacyUid00000002']);
  });

  it('takes the name from the text when the mention has no data-value', () => {
    const mention = vi.fn((_uid: string, name: string) => name);
    md('<p><span class="mention" data-id="uid-2"> @Sam Example\uFEFF</span></p>', { ...OPTIONS, mention });
    expect(mention).toHaveBeenCalledExactlyOnceWith('uid-2', 'Sam Example');
  });

  it('reads spans that are not full mentions as their text', () => {
    const mention = vi.fn(() => 'MENTION');
    const result = md('<p><span class="mention">@Nobody</span> <span data-id="x">plain</span></p>', {
      ...OPTIONS,
      mention,
    });
    expect(result.markdown).toBe('@Nobody plain');
    expect(mention).not.toHaveBeenCalled();
  });
});

describe('htmlToMarkdown: sanitising', () => {
  it('removes scripts, styles, frames and svg with their content, counting each', () => {
    const result = md(
      '<p>Safe</p><script>alert(1)</script><style>p{color:red}</style><iframe src="https://evil.example"></iframe><svg><script>x()</script><text>svg text</text></svg>',
    );
    expect(result).toMatchObject({ markdown: 'Safe', unsafeRemoved: 4 });
  });

  it('removes them inside paragraphs too', () => {
    expect(md('<p>a<script>x</script>b<style>p{}</style>c<iframe></iframe></p>')).toMatchObject({
      markdown: 'abc',
      unsafeRemoved: 3,
    });
  });

  it('removes event handler attributes and counts them', () => {
    expect(md('<img src="x" onerror="alert(1)">')).toMatchObject({ markdown: '', unsafeRemoved: 1 });
    expect(md('<p onclick="x()">Hi <strong onmouseover="y()">there</strong></p>')).toMatchObject({
      markdown: 'Hi **there**',
      unsafeRemoved: 2,
    });
  });

  // A handler on a list item is counted like one on a paragraph, inside a list or out.
  it('counts event handlers on list items', () => {
    expect(md('<li onclick="x()">c</li>').unsafeRemoved).toBe(1);
    expect(md('<ul><li onclick="x()">a</li></ul>').unsafeRemoved).toBe(1);
  });

  it('drops form controls, media and other noise, counting only the unsafe ones', () => {
    const result = md(
      '<p>x<button onclick="go()">Go</button><input value="v"></p><video onerror="x"></video><noscript>ns</noscript><template><p>t</p></template><form><p>in form</p></form><math><mi>x</mi></math><object></object><embed>',
    );
    // onclick, onerror, form, math, object, embed.
    expect(result).toMatchObject({ markdown: 'x', unsafeRemoved: 6 });
    expect(md('<noscript>a</noscript><template>b</template><p>c<select><option>d</option></select></p>')).toMatchObject(
      {
        markdown: 'c',
        unsafeRemoved: 0,
      },
    );
  });
});

describe('htmlToMarkdown: images', () => {
  it('drops remote images (tracking pixels) and counts them', () => {
    expect(
      md(
        '<p>See <a href="https://example.com/brief">the brief</a><img src="https://tracker.example.com/pixel.gif"></p>',
      ),
    ).toEqual({
      markdown: 'See [the brief](https://example.com/brief)',
      images: [],
      unsafeRemoved: 0,
      remoteImages: 1,
    });
    expect(
      md('<p><img src="//cdn.example.com/x.png"><img src="HTTP://example.com/y.png" onload="x()"></p>'),
    ).toMatchObject({
      markdown: '',
      remoteImages: 2,
      unsafeRemoved: 1,
    });
  });

  it("keeps a dropped image's alt text, escaped", () => {
    expect(markdown('<p>Logo: <img src="https://example.com/logo.png" alt="Firm @[logo]"></p>')).toBe(
      'Logo: Firm @\u200B[logo]',
    );
    expect(markdown('<p><img src="cid:abc" alt="attached"></p>')).toBe('attached');
  });

  it('extracts an inline base64 image with its size and checksums, replaced by options.imageText', () => {
    const imageText = vi.fn((index: number, image: InlineImage) => `(image ${index + 1}, ${image.sizeBytes} bytes)`);
    const result = md(`<p>Before <img src="data:image/png;base64,${PNG_BASE64}"> after</p>`, { ...OPTIONS, imageText });
    const expected: InlineImage = {
      mime: 'image/png',
      extension: 'png',
      base64: PNG_BASE64,
      sizeBytes: PNG_BYTES.length,
      sha256: createHash('sha256').update(PNG_BYTES).digest('hex'),
      md5Hash: createHash('md5').update(PNG_BYTES).digest('base64'),
    };
    expect(result.images).toEqual([expected]);
    expect(expected.sizeBytes).toBe(70);
    expect(expected.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(expected.md5Hash).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(imageText).toHaveBeenCalledExactlyOnceWith(0, expected);
    expect(result.markdown).toBe('Before (image 1, 70 bytes) after');
    expect(result).toMatchObject({ unsafeRemoved: 0, remoteImages: 0 });
  });

  it('numbers several images in order, normalising jpg and whitespace in the data', () => {
    const result = md('<p><img src="data:image/jpg;base64,/9j/4A=="><img src="DATA:image/GIF;base64,R0lG\nODlh"></p>');
    expect(result.markdown).toBe('(image 1)(image 2)');
    expect(
      result.images.map(({ mime, extension, base64, sizeBytes }) => ({ mime, extension, base64, sizeBytes })),
    ).toEqual([
      { mime: 'image/jpeg', extension: 'jpg', base64: '/9j/4A==', sizeBytes: 4 },
      { mime: 'image/gif', extension: 'gif', base64: 'R0lGODlh', sizeBytes: 6 },
    ]);
  });

  it('does not extract an svg data image (it can carry script) and counts it unsafe', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString(
      'base64',
    );
    expect(md(`<p><img src="data:image/svg+xml;base64,${svg}" alt="diagram"></p>`)).toEqual({
      markdown: 'diagram',
      images: [],
      unsafeRemoved: 1,
      remoteImages: 0,
    });
  });

  it('counts javascript: and other data: image sources unsafe', () => {
    expect(md('<p><img src="javascript:alert(1)"><img src="data:text/html;base64,PHA+"></p>')).toMatchObject({
      markdown: '',
      images: [],
      unsafeRemoved: 3,
    });
  });
});

describe('htmlToMarkdown: literal mention syntax', () => {
  it('neutralises a literal @[ or #[ so it never reads as a mention', () => {
    const result = markdown('<p>Email @[someone] about #[123], not @ [this]</p>');
    expect(result).toBe('Email @\u200B[someone] about #\u200B[123], not @ [this]');
    expect(domain.parseMentions(result)).toEqual({ uids: [], matterIds: [] });
  });

  it('neutralises them in link text', () => {
    const result = markdown('<p><a href="https://example.com">ask @[FictionalUid0001]</a></p>');
    expect(domain.parseMentions(result)).toEqual({ uids: [], matterIds: [] });
  });

  it('keeps inline code as code, where the notes parser reads no mentions', () => {
    const result = markdown('<p><code>@[FictionalUid0001]</code></p>');
    expect(result).toBe('`@[FictionalUid0001]`');
    expect(domain.parseMentions(result)).toEqual({ uids: [], matterIds: [] });
  });

  it('neutralises mention syntax in inline code that holds a backtick', () => {
    const result = markdown('<p><code>`x` @[FictionalUid0001]</code></p>');
    expect(domain.parseMentions(result)).toEqual({ uids: [], matterIds: [] });
  });

  // Text nodes are escaped one at a time, so an `@` or `#` ending one must not join a `[` starting the
  // next (another element's text, or a link's `[text](…)`) into a token.
  it('never joins an @ or # with a [ from the next node into a mention', () => {
    for (const html of [
      '<p>Ask @<a href="https://example.com/jordan">Jordan</a> today</p>',
      '<p>Ref #<span>[FictionalMatter1]</span></p>',
      '<p>@<strong></strong>[FictionalUid0001]</p>',
    ]) {
      expect(domain.parseMentions(markdown(html))).toEqual({ uids: [], matterIds: [] });
    }
  });
});

describe('escapeText', () => {
  it('puts a zero-width space between the sigil and the bracket', () => {
    expect(escapeText('@[a] #[b] @@[c]')).toBe('@\u200B[a] #\u200B[b] @@\u200B[c]');
  });

  it('leaves other text alone', () => {
    expect(escapeText('email@example.com [1] # heading @ [x]')).toBe('email@example.com [1] # heading @ [x]');
    expect(escapeText('')).toBe('');
  });
});

describe('htmlToText', () => {
  it('spaces table cells like blocks', () => {
    expect(htmlToText('<th>Name</th><th>Role</th>')).toBe('Name Role');
    expect(htmlToText('<table><tr><th>Name</th><th>Role</th></tr><tr><td>Sam</td><td>Executor</td></tr></table>')).toBe(
      'Name Role Sam Executor',
    );
  });

  it('keeps the text of history lines without their tags', () => {
    expect(htmlToText('<strong>Alex Rivers</strong> moved card to <em>Drafting</em>')).toBe(
      'Alex Rivers moved card to Drafting',
    );
  });

  it('separates blocks and line breaks with a space', () => {
    expect(htmlToText('<p>one</p><p>two</p><ul><li>three</li></ul>a<br>b')).toBe('one two three a b');
  });

  it('drops scripts, styles and the like with their content', () => {
    expect(htmlToText('<script>alert(1)</script>text<style>p{}</style> <svg><text>svg</text></svg>more')).toBe(
      'text more',
    );
  });

  it('decodes entities, collapses whitespace and drops zero-width characters', () => {
    expect(htmlToText('  a&nbsp;&amp;\n\tb\uFEFF  <!-- c -->')).toBe('a & b');
    expect(htmlToText('<p><span class="mention" data-id="u">\uFEFF@Jordan Ellis\uFEFF</span></p>')).toBe(
      '@Jordan Ellis',
    );
  });

  it("gives '' for empty input and Quill's empty editor", () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p><br></p>')).toBe('');
  });
});
