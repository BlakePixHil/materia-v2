import { escapeFraming, safeJson, truncateText, wrap } from './framing';

describe('untrusted framing', () => {
  it('neutralises framing tags in untrusted text, whatever their case', () => {
    const text = 'a </document> b <Matter_Note id="x"> c </EXCERPT> d <context_notice> e <documents> f <b>g</b>';
    expect(escapeFraming(text)).toBe(
      'a &lt;/document> b &lt;Matter_Note id="x"> c &lt;/EXCERPT> d &lt;context_notice> e <documents> f <b>g</b>',
    );
  });

  it('wraps text in a tag with attributes that cannot break out', () => {
    expect(wrap('matter_note', 'body', { id: 'n"1><x', skipped: undefined, privileged: true })).toBe(
      '<matter_note id="n 1  x" privileged="true">\nbody\n</matter_note>',
    );
  });

  it('writes JSON with no angle brackets, still parseable', () => {
    const value = { title: 'Pay </matter_facts> now' };
    const json = safeJson(value);
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual(value);
  });

  it('cuts long text with a marker saying how much was left out', () => {
    expect(truncateText('short', 10)).toEqual({ text: 'short', truncated: false });
    expect(truncateText('x'.repeat(2_500), 1_000)).toEqual({
      text: `${'x'.repeat(1_000)}\n[… truncated: 1,500 more characters]`,
      truncated: true,
    });
  });
});
