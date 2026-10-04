import { displayedBox, MARGIN, pageLabel, parsePageRange, placeText, qpdfRange, spanPages } from './layout';

const A4 = { width: 595, height: 842 };

describe('placeText', () => {
  it('puts each position against the right edges, a margin in', () => {
    expect(placeText('top-left', A4, 100, 9)).toEqual({ x: MARGIN, y: 842 - MARGIN - 9 });
    expect(placeText('top-right', A4, 100, 9)).toEqual({ x: 595 - MARGIN - 100, y: 842 - MARGIN - 9 });
    expect(placeText('bottom-center', A4, 100, 9)).toEqual({ x: (595 - 100) / 2, y: MARGIN });
    expect(placeText('bottom-right', A4, 50, 9)).toEqual({ x: 595 - MARGIN - 50, y: MARGIN });
  });

  it('never starts text left of the margin, even when it is wider than the page', () => {
    expect(placeText('top-right', A4, 900, 9).x).toBe(MARGIN);
    expect(placeText('bottom-center', A4, 900, 9).x).toBe(MARGIN);
  });
});

describe('pageLabel', () => {
  it('numbers from start and fills in the total', () => {
    expect(pageLabel('{n}', 0, 12, 1)).toBe('1');
    expect(pageLabel('Page {n} of {total}', 2, 12, 1)).toBe('Page 3 of 12');
    expect(pageLabel('{n}/{total} · {n}', 0, 10, 101)).toBe('101/110 · 101');
  });
});

describe('parsePageRange', () => {
  it('means every page without a range', () => {
    expect(parsePageRange(undefined, 5)).toEqual([[1, 5]]);
    expect(parsePageRange(undefined, 0)).toEqual([]);
  });

  it('parses single pages and spans', () => {
    const spans = parsePageRange('1-3,7,9-10', 10);
    expect(spans).toEqual([
      [1, 3],
      [7, 7],
      [9, 10],
    ]);
    expect(spanPages(spans)).toBe(6);
    expect(qpdfRange(spans)).toBe('1-3,7,9-10');
  });

  it('rejects pages outside the document and reversed spans', () => {
    expect(() => parsePageRange('0', 3)).toThrow(RangeError);
    expect(() => parsePageRange('2-4', 3)).toThrow('outside 1-3');
    expect(() => parsePageRange('3-1', 3)).toThrow(RangeError);
  });
});

describe('displayedBox', () => {
  it('swaps width and height for quarter turns, including negative ones', () => {
    expect(displayedBox([0, 0, 595, 842], 0)).toEqual(A4);
    expect(displayedBox([0, 0, 595, 842], 90)).toEqual({ width: 842, height: 595 });
    expect(displayedBox([0, 0, 595, 842], -90)).toEqual({ width: 842, height: 595 });
    expect(displayedBox([0, 0, 595, 842], 180)).toEqual(A4);
    expect(displayedBox([10, 20, 110, 220], 270)).toEqual({ width: 200, height: 100 });
  });
});
