import {
  boxBlur,
  detectPage,
  homography,
  isUsable,
  MIN_CROP_AREA,
  otsuThreshold,
  pageSize,
  type Pixels,
  type Point,
  type Quad,
  quadArea,
  rotateQuad,
  toGrayscale,
  warpPage,
  WHOLE_PHOTO,
} from './scan-image';

/** A photo of `width` × `height`: `paint(x, y)` gives each pixel's grey. */
function photo(width: number, height: number, paint: (x: number, y: number) => number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = paint(x, y);
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Whether (x, y) is inside the polygon (ray casting). */
function inside(points: readonly Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (!a || !b) continue;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** A light page with dark "text" lines on a dark desk, its corners at `corners` (in pixels). */
function pageOnDesk(width: number, height: number, corners: Point[]): Pixels {
  return photo(width, height, (x, y) => {
    if (!inside(corners, x + 0.5, y + 0.5)) return 40 + ((x * 7 + y * 13) % 17);
    // Text lines inside the page don't break it into pieces.
    return y % 24 < 3 && x % 50 < 40 ? 70 : 225;
  });
}

const near = (quad: Quad | null, corners: Point[], width: number, height: number, tolerance = 0.02) =>
  !!quad &&
  quad.every(
    (point, i) =>
      !!corners[i] &&
      Math.abs(point.x - corners[i].x / width) < tolerance &&
      Math.abs(point.y - corners[i].y / height) < tolerance,
  );

describe('detectPage (MOB-05)', () => {
  it('finds the corners of a tilted page on a desk', () => {
    const corners = [
      { x: 70, y: 40 },
      { x: 330, y: 62 },
      { x: 318, y: 280 },
      { x: 52, y: 262 },
    ];
    const quad = detectPage(pageOnDesk(400, 320, corners));
    expect(quad).not.toBeNull();
    expect(near(quad, corners, 400, 320)).toBe(true);
  });

  it('finds a page photographed at an angle (a trapezium)', () => {
    const corners = [
      { x: 120, y: 50 },
      { x: 280, y: 50 },
      { x: 360, y: 300 },
      { x: 40, y: 300 },
    ];
    expect(near(detectPage(pageOnDesk(400, 340, corners)), corners, 400, 340)).toBe(true);
  });

  it('picks the page, not a smaller light object beside it', () => {
    const corners = [
      { x: 140, y: 30 },
      { x: 380, y: 30 },
      { x: 380, y: 290 },
      { x: 140, y: 290 },
    ];
    const pixels = pageOnDesk(400, 320, corners);
    const card = photo(400, 320, (x, y) => (x > 10 && x < 90 && y > 200 && y < 250 ? 240 : 0));
    for (let p = 0; p < card.data.length; p += 4) if (card.data[p]) pixels.data.set([240, 240, 240], p);
    expect(near(detectPage(pixels), corners, 400, 320)).toBe(true);
  });

  it('finds nothing in a plain photo or when the light area is too small', () => {
    expect(detectPage(photo(200, 150, () => 128))).toBeNull();
    const tiny = [
      { x: 20, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 60 },
      { x: 20, y: 60 },
    ];
    expect(detectPage(pageOnDesk(200, 150, tiny))).toBeNull();
    expect(detectPage(photo(4, 4, () => 255))).toBeNull();
  });
});

describe('scan geometry', () => {
  it('Otsu splits two groups between them', () => {
    const gray = new Uint8Array(1000).map((_, i) => (i < 600 ? 30 + (i % 10) : 200 + (i % 10)));
    const t = otsuThreshold(gray);
    expect(t).toBeGreaterThanOrEqual(39);
    expect(t).toBeLessThan(200);
  });

  it('blurs without changing a flat image', () => {
    expect([...boxBlur(new Uint8Array(30).fill(90), 6, 5, 2)].every((v) => v === 90)).toBe(true);
  });

  it('measures, checks and turns quads', () => {
    expect(quadArea(WHOLE_PHOTO)).toBe(1);
    expect(isUsable(WHOLE_PHOTO)).toBe(true);
    // A bow tie (corners out of order) and a sliver are not pages.
    expect(isUsable([WHOLE_PHOTO[0], WHOLE_PHOTO[2], WHOLE_PHOTO[1], WHOLE_PHOTO[3]])).toBe(false);
    expect(
      isUsable([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.1 },
        { x: 0, y: 0.1 },
      ]),
    ).toBe(false);
    // Corners set by hand may frame something as small as a receipt.
    const receipt: Quad = [
      { x: 0.4, y: 0.3 },
      { x: 0.6, y: 0.3 },
      { x: 0.6, y: 0.7 },
      { x: 0.4, y: 0.7 },
    ];
    expect(isUsable(receipt)).toBe(false);
    expect(isUsable(receipt, MIN_CROP_AREA)).toBe(true);
    expect(rotateQuad(WHOLE_PHOTO)).toEqual([WHOLE_PHOTO[3], WHOLE_PHOTO[0], WHOLE_PHOTO[1], WHOLE_PHOTO[2]]);
  });

  it('sizes the straightened page from its longest edges, shrunk to the limit', () => {
    expect(pageSize(WHOLE_PHOTO, 3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
    expect(pageSize(WHOLE_PHOTO, 800, 600, 2000)).toEqual({ width: 800, height: 600 });
    const tilted: Quad = [
      { x: 0.25, y: 0 },
      { x: 0.75, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(pageSize(tilted, 400, 400, 2000)).toEqual({ width: 400, height: Math.round(Math.hypot(100, 400)) });
  });

  it('maps the output rectangle onto the corners', () => {
    const corners: Quad = [
      { x: 10, y: 20 },
      { x: 110, y: 30 },
      { x: 100, y: 140 },
      { x: 5, y: 120 },
    ];
    const [a, b, c, d, e, f, g, h] = homography(corners, 50, 80) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const map = (u: number, v: number) => {
      const w = g * u + h * v + 1;
      return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
    };
    for (const [[u, v], corner] of [
      [[0, 0], corners[0]],
      [[50, 0], corners[1]],
      [[50, 80], corners[2]],
      [[0, 80], corners[3]],
    ] as const) {
      const mapped = map(u, v);
      expect(mapped.x).toBeCloseTo(corner.x, 6);
      expect(mapped.y).toBeCloseTo(corner.y, 6);
    }
  });
});

describe('warpPage', () => {
  const gradient = photo(40, 30, (x, y) => x * 5 + y * 2);

  it('copies the whole photo unchanged', () => {
    const out = warpPage(gradient, WHOLE_PHOTO, 40, 30);
    expect([...out.data]).toEqual([...gradient.data]);
  });

  it('cuts out the quad', () => {
    const quad: Quad = [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.5 },
      { x: 0.75, y: 1 },
      { x: 0.25, y: 1 },
    ];
    const out = warpPage(gradient, quad, 20, 15);
    // Output (0, 0) is photo (10, 15); (19, 14) is photo (29, 29).
    expect(out.data[0]).toBe(10 * 5 + 15 * 2);
    expect(out.data[(14 * 20 + 19) * 4]).toBe(29 * 5 + 29 * 2);
    expect(out.data[3]).toBe(255);
  });

  it('turns a quarter when the corners turn', () => {
    const out = warpPage(gradient, rotateQuad(WHOLE_PHOTO), 30, 40);
    // Rotated right: the output's top-left is the photo's bottom-left.
    expect(out.data[0]).toBe(0 * 5 + 29 * 2);
    expect(out.data[(39 * 30 + 29) * 4]).toBe(39 * 5 + 0 * 2);
  });

  it('greys colour pixels', () => {
    const colour: Pixels = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
    expect([...toGrayscale(colour).data]).toEqual([76, 76, 76, 255]);
  });
});
