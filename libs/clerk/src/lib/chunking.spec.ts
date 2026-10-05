import { describe, expect, it } from 'vitest';

import { chunkPages, estimateTokens, normaliseText, pseudoPages, splitPage } from './chunking';

/** Fictional filler: numbered sentences, so overlaps and order are easy to check. */
const sentences = (count: number, prefix = 'Clause') =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1} of the fictional will of Rowan Example applies.`).join(
    ' ',
  );

describe('chunkPages', () => {
  it('keeps a short page as one chunk, with its page and ordinal', () => {
    expect(chunkPages([{ page: 3, text: '  I appoint   Sam Sample\n\n\n\nas executor. ' }])).toEqual([
      { page: 3, ordinal: 0, text: 'I appoint Sam Sample\n\nas executor.' },
    ]);
  });

  it('never crosses a page boundary', () => {
    const chunks = chunkPages([
      { page: 1, text: sentences(10, 'One') },
      { page: 2, text: sentences(10, 'Two') },
    ]);
    expect(chunks.map((c) => c.page)).toEqual([1, 2]);
    expect(chunks[0]?.text).not.toContain('Two');
    expect(chunks[1]?.text).not.toContain('One');
  });

  it('splits a long page into ~800-token chunks that overlap by ~100 tokens', () => {
    const text = sentences(400);
    const chunks = chunkPages([{ page: 1, text }]);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(800);
      expect(chunk.page).toBe(1);
    }
    for (const chunk of chunks.slice(0, -1)) expect(estimateTokens(chunk.text)).toBeGreaterThan(450);
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]?.text ?? '';
      const head = (chunks[i]?.text ?? '').slice(0, 200);
      // The start of each chunk repeats the end of the one before.
      expect(previous.includes(head.slice(0, 60))).toBe(true);
      const overlap = previous.length - previous.indexOf(head.slice(0, 60));
      expect(overlap).toBeGreaterThan(200);
      expect(overlap).toBeLessThan(800);
    }
    // Nothing is lost: every clause appears somewhere.
    const all = chunks.map((c) => c.text).join(' ');
    for (const n of [1, 133, 267, 400]) expect(all).toContain(`Clause ${n} of`);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('prefers to end a chunk at a sentence', () => {
    const chunks = chunkPages([{ page: 1, text: sentences(200) }]);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text).toMatch(/applies\.$/);
  });

  it('splits text with no spaces at the hard limit and still makes progress', () => {
    const chunks = chunkPages([{ page: 1, text: 'x'.repeat(10_000) }]);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.text.length <= 3200)).toBe(true);
  });

  it('skips empty pages and continues numbering from startOrdinal', () => {
    const chunks = chunkPages(
      [
        { page: 1, text: '   ' },
        { page: 2, text: 'Second page.' },
      ],
      { startOrdinal: 7 },
    );
    expect(chunks).toEqual([{ page: 2, ordinal: 7, text: 'Second page.' }]);
  });

  it('rejects an overlap as large as the chunk', () => {
    expect(() => chunkPages([{ page: 1, text: 'a' }], { targetTokens: 10, overlapTokens: 10 })).toThrow();
  });
});

describe('splitPage', () => {
  it('returns nothing for blank text', () => {
    expect(splitPage(' \n ', 100, 10)).toEqual([]);
  });
});

describe('normaliseText', () => {
  it('collapses spaces and blank lines', () => {
    expect(normaliseText('a\t\tb\r\n\r\n\r\n\r\nc  ')).toBe('a b\n\nc');
  });
});

describe('pseudoPages', () => {
  it('packs paragraphs into ~3,000-character pages', () => {
    const paragraph = sentences(8);
    const text = Array.from({ length: 20 }, () => paragraph).join('\n\n');
    const pages = pseudoPages(text);
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.map((p) => p.page)).toEqual(pages.map((_, i) => i + 1));
    for (const page of pages) expect(page.text.length).toBeLessThanOrEqual(3000);
  });

  it('splits one huge paragraph', () => {
    const pages = pseudoPages(sentences(300), 3000);
    expect(pages.length).toBeGreaterThan(4);
    for (const page of pages) expect(page.text.length).toBeLessThanOrEqual(3000);
  });

  it('gives no pages for empty text', () => {
    expect(pseudoPages('')).toEqual([]);
  });
});
