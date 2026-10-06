import {
  byCodeUnit,
  canonicalJson,
  exportLine,
  sortRecords,
  stripDownloadTokens,
  withoutDownloadTokens,
} from './jsonl.ts';

describe('the export line format', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('writes {path, id, data, readTime} on one line', () => {
    expect(
      exportLine(
        { path: 'workflows/w1/cards/c1', data: { title: 'x', $: { $timestamp: 't' } } },
        '2026-10-06T21:00:00Z',
      ),
    ).toBe(
      '{"path":"workflows/w1/cards/c1","id":"c1","data":{"$":{"$timestamp":"t"},"title":"x"},"readTime":"2026-10-06T21:00:00Z"}\n',
    );
    expect(exportLine({ path: 'profiles/gone', data: null }, 't')).toBe(
      '{"path":"profiles/gone","id":"gone","data":null,"readTime":"t"}\n',
    );
  });

  it('orders by code unit, not locale, and keeps one record per path', () => {
    expect(['b', 'B', 'a', 'A', '_'].sort(byCodeUnit)).toEqual(['A', 'B', '_', 'a', 'b']);
    expect(
      sortRecords([
        { path: 'w/b', data: { n: 1 } },
        { path: 'w/a', data: {} },
        { path: 'w/b', data: { n: 2 } },
      ]),
    ).toEqual([
      { path: 'w/a', data: {} },
      { path: 'w/b', data: { n: 2 } },
    ]);
  });
});

describe('download tokens', () => {
  const base = 'https://firebasestorage.googleapis.com/v0/b/fictional/o/x';

  it('come out of Firebase download URLs, wherever the parameter sits', () => {
    expect(stripDownloadTokens(`${base}?alt=media&token=abc-123`)).toEqual({ text: `${base}?alt=media`, stripped: 1 });
    expect(stripDownloadTokens(`${base}?token=abc&alt=media`).text).toBe(`${base}?alt=media`);
    expect(stripDownloadTokens(`${base}?alt=media&token=abc&x=1`).text).toBe(`${base}?alt=media&x=1`);
  });

  it('come out of URLs inside HTML, where & is escaped', () => {
    const html = `<p>See <img src="${base}?alt=media&amp;token=abc"> and <a href="${base}?alt=media&amp;token=def">this</a></p>`;
    expect(stripDownloadTokens(html)).toEqual({
      text: `<p>See <img src="${base}?alt=media"> and <a href="${base}?alt=media">this</a></p>`,
      stripped: 2,
    });
  });

  it('leave other URLs and text alone', () => {
    for (const text of ['https://example.com/?token=keep', 'token=abc', `${base}?alt=media`]) {
      expect(stripDownloadTokens(text)).toEqual({ text, stripped: 0 });
    }
  });

  it('come out of every string in a document, and are counted', () => {
    const counter = { stripped: 0 };
    const data = { downloadUrl: `${base}?alt=media&token=a`, history: [{ note: `${base}?token=b` }], n: 1 };
    expect(withoutDownloadTokens(data, counter)).toEqual({
      downloadUrl: `${base}?alt=media`,
      history: [{ note: `${base}?` }],
      n: 1,
    });
    expect(counter.stripped).toBe(2);
    expect(data.downloadUrl).toContain('token=a');
  });
});
