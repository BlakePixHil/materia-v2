import { addHtml, emptyHtmlStats, isEmptyHtml, mentionUids } from './html.ts';

describe('legacy rich text', () => {
  it('finds quill mention targets', () => {
    const html =
      '<p>Hi <span class="mention" data-index="0" data-denotation-char="@" data-id="uid-1" data-value="A">@A</span> and ' +
      '<span data-id=\'uid-2\' class=\'mention\'>@B</span>, not <span class="other" data-id="uid-3">x</span></p>';
    expect(mentionUids(html)).toEqual(['uid-1', 'uid-2']);
    expect(mentionUids('plain text')).toEqual([]);
  });

  it("treats quill's empty editor as empty", () => {
    expect(isEmptyHtml('')).toBe(true);
    expect(isEmptyHtml('<p><br></p>')).toBe(true);
    expect(isEmptyHtml('<p></p><p><br/></p>')).toBe(true);
    expect(isEmptyHtml('<p>x</p>')).toBe(false);
  });

  it('counts tags, classes, images, links and what sanitising must strip, never text', () => {
    const stats = emptyHtmlStats();
    addHtml(stats, '<p class="ql-align-center">Secret client name <strong>here</strong></p>');
    addHtml(stats, '<img src="data:image/png;base64,AAAA"><img src="https://pixel.example/x.gif"><img src="cid:1">');
    addHtml(
      stats,
      '<a href="javascript:alert(1)" onclick="x()" style="color:red">x</a><script>1</script><style>p{}</style><iframe></iframe>',
    );
    addHtml(stats, 'just text');
    addHtml(stats, '<p><br></p>');
    addHtml(stats, null);
    expect(stats).toMatchObject({
      values: 5,
      empty: 1,
      html: 3,
      plain: 1,
      tags: { p: 1, strong: 1, img: 3, a: 1, script: 1, style: 1, iframe: 1 },
      classes: { 'ql-align-center': 1 },
      images: { inlineBase64: 1, inlineBase64Bytes: 3, remote: 1, other: 1 },
      links: 1,
      unsafe: { script: 1, style: 1, iframe: 1, eventHandlers: 1, inlineStyles: 1, javascriptUrls: 1 },
    });
    expect(JSON.stringify(stats)).not.toContain('Secret');
  });
});
