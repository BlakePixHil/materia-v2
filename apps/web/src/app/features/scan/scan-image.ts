/**
 * The image work behind document scanning (MOB-05), on plain RGBA pixels so it runs (and is tested)
 * without a canvas: find the page in a photo, then straighten it. Small enough to need no library
 * (jscanify and OpenCV.js are megabytes); it loads with the Scan screen only.
 *
 * Finding the page: paper is usually the largest bright region in the photo. The photo is shrunk,
 * blurred and split into light and dark (Otsu's threshold); the corners of the largest light
 * region are its extremes along the two diagonals. A photo with no clear page (paper on a white
 * desk, a page filling the frame) finds nothing, and the whole photo is used until someone drags
 * the corners.
 */

/** RGBA pixels, row by row, as in `ImageData`. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** A point in a photo as fractions of its width and height (0 to 1), so it fits any size of it. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A page's corners in a photo: top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point];

/** The whole photo, uncropped. */
export const WHOLE_PHOTO: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** A found page must cover at least this much of the photo; less is more likely a reflection. */
const MIN_PAGE_AREA = 0.15;
/** A light region over this share of the photo leaves no edge to find. */
const MAX_PAGE_SHARE = 0.97;

/** The pixels' brightness (Rec. 601 luma), 0 to 255. */
export function luma(pixels: Pixels): Uint8Array {
  const { data } = pixels;
  const out = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = ((data[p] ?? 0) * 299 + (data[p + 1] ?? 0) * 587 + (data[p + 2] ?? 0) * 114) / 1000;
  }
  return out;
}

/** A box blur of `radius` in both directions (run twice, it is close to a Gaussian). */
export function boxBlur(gray: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(src.length);
    const lines = horizontal ? height : width;
    const length = horizontal ? width : height;
    const step = horizontal ? 1 : width;
    for (let line = 0; line < lines; line++) {
      const start = horizontal ? line * width : line;
      let sum = 0;
      // The window clamps at the edges, so a border pixel counts several times.
      for (let k = -radius; k <= radius; k++) sum += src[start + clamp(k, 0, length - 1) * step] ?? 0;
      for (let i = 0; i < length; i++) {
        out[start + i * step] = sum / (2 * radius + 1);
        sum +=
          (src[start + Math.min(i + radius + 1, length - 1) * step] ?? 0) -
          (src[start + Math.max(i - radius, 0) * step] ?? 0);
      }
    }
    return out;
  };
  return pass(pass(gray, true), false);
}

/** Otsu's threshold: the brightness that best splits the pixels into two groups. */
export function otsuThreshold(gray: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of gray) histogram[value] = (histogram[value] ?? 0) + 1;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * (histogram[i] ?? 0);
  let sumDark = 0;
  let countDark = 0;
  let best = 0;
  let threshold = 127;
  for (let i = 0; i < 256; i++) {
    countDark += histogram[i] ?? 0;
    if (countDark === 0) continue;
    const countLight = total - countDark;
    if (countLight === 0) break;
    sumDark += i * (histogram[i] ?? 0);
    const meanDark = sumDark / countDark;
    const meanLight = (sumAll - sumDark) / countLight;
    const between = countDark * countLight * (meanDark - meanLight) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/**
 * The page in a photo (best on a small copy, about 400px across), or null when there is no clear
 * one. Corners are in the photo's fractions, top-left first, clockwise.
 */
export function detectPage(pixels: Pixels): Quad | null {
  const { width, height } = pixels;
  if (width < 8 || height < 8) return null;
  const gray = boxBlur(boxBlur(luma(pixels), width, height, 2), width, height, 2);
  const threshold = otsuThreshold(gray);
  const region = largestRegion(gray, width, height, threshold);
  // Nearly all light: no desk around the page to find it by (or a blank photo).
  if (!region || region.area > MAX_PAGE_SHARE * width * height) return null;
  const at = (index: number): Point => ({
    x: ((index % width) + 0.5) / width,
    y: (Math.floor(index / width) + 0.5) / height,
  });
  const quad: Quad = [at(region.topLeft), at(region.topRight), at(region.bottomRight), at(region.bottomLeft)];
  return isUsable(quad) ? quad : null;
}

interface Region {
  area: number;
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/** The largest 4-connected region brighter than `threshold`, with its diagonal extremes. */
function largestRegion(gray: Uint8Array, width: number, height: number, threshold: number): Region | null {
  const seen = new Uint8Array(gray.length);
  const stack = new Int32Array(gray.length);
  let best: Region | null = null;
  for (let start = 0; start < gray.length; start++) {
    if (seen[start] || (gray[start] ?? 0) <= threshold) continue;
    const region: Region = { area: 0, topLeft: start, topRight: start, bottomRight: start, bottomLeft: start };
    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDiff = Infinity;
    let maxDiff = -Infinity;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const index = stack[--top] ?? 0;
      region.area++;
      const x = index % width;
      const y = (index - x) / width;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        region.topLeft = index;
      }
      if (sum > maxSum) {
        maxSum = sum;
        region.bottomRight = index;
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        region.topRight = index;
      }
      if (diff < minDiff) {
        minDiff = diff;
        region.bottomLeft = index;
      }
      const push = (next: number) => {
        if (!seen[next] && (gray[next] ?? 0) > threshold) {
          seen[next] = 1;
          stack[top++] = next;
        }
      };
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (y > 0) push(index - width);
      if (y < height - 1) push(index + width);
    }
    if (!best || region.area > best.area) best = region;
  }
  return best;
}

/** The area a quad covers, as a fraction of the photo (the shoelace formula). */
export function quadArea(quad: Quad): number {
  let twice = 0;
  for (let i = 0; i < 4; i++) {
    const a = corner(quad, i);
    const b = corner(quad, i + 1);
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** Corners set by hand may frame a small page (a receipt) but not a sliver. */
export const MIN_CROP_AREA = 0.01;

/** Convex, turning one way, and big enough to be a page (`minArea` of the photo, a found page's by default). */
export function isUsable(quad: Quad, minArea = MIN_PAGE_AREA): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corner(quad, i);
    const b = corner(quad, i + 1);
    const c = corner(quad, i + 2);
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return quadArea(quad) >= minArea;
}

/** The quad turned a quarter clockwise: the page comes out rotated 90° to the right. */
export function rotateQuad(quad: Quad): Quad {
  return [quad[3], quad[0], quad[1], quad[2]];
}

/**
 * The straightened page's size for a quad in a photo of `width` × `height`: its longest top or
 * bottom edge by its longest side, shrunk (never enlarged) to `maxEdge` on the longer side.
 */
export function pageSize(
  quad: Quad,
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const [tl, tr, br, bl] = inPixels(quad, width, height);
  const length = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const across = Math.max(length(tl, tr), length(bl, br));
  const down = Math.max(length(tl, bl), length(tr, br));
  const scale = Math.min(1, maxEdge / Math.max(across, down));
  return { width: Math.max(1, Math.round(across * scale)), height: Math.max(1, Math.round(down * scale)) };
}

/**
 * The projective transform taking the output rectangle (`width` × `height`) to the quad's corners
 * in the photo, as the 8 coefficients of `x = (a·u + b·v + c) / (g·u + h·v + 1)` and
 * `y = (d·u + e·v + f) / (g·u + h·v + 1)`.
 */
export function homography(corners: Quad, width: number, height: number): number[] {
  const pairs: [Point, Point][] = [
    [{ x: 0, y: 0 }, corners[0]],
    [{ x: width, y: 0 }, corners[1]],
    [{ x: width, y: height }, corners[2]],
    [{ x: 0, y: height }, corners[3]],
  ];
  const rows: number[][] = [];
  for (const [{ x: u, y: v }, { x, y }] of pairs) {
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  return solve(rows);
}

/** Gaussian elimination with partial pivoting on an augmented n × (n + 1) matrix. */
function solve(rows: readonly (readonly number[])[]): number[] {
  const n = rows.length;
  const w = n + 1;
  const m = Float64Array.from(rows.flat());
  const at = (row: number, col: number) => m[row * w + col] ?? 0;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(at(row, col)) > Math.abs(at(pivot, col))) pivot = row;
    for (let k = 0; pivot !== col && k < w; k++) {
      const held = at(col, k);
      m[col * w + k] = at(pivot, k);
      m[pivot * w + k] = held;
    }
    const lead = at(col, col);
    if (Math.abs(lead) < 1e-12) throw new Error('The corners don’t make a page');
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = at(row, col) / lead;
      if (factor === 0) continue;
      for (let k = col; k < w; k++) m[row * w + k] = at(row, k) - factor * at(col, k);
    }
  }
  return Array.from({ length: n }, (_, i) => at(i, n) / at(i, i));
}

/**
 * The page cut out of the photo and straightened: each output pixel is read from where the
 * transform puts it in the photo (bilinear, so edges stay smooth).
 */
export function warpPage(source: Pixels, quad: Quad, width: number, height: number): Pixels {
  const [a, b, c, d, e, f, g, h] = homography(inPixels(quad, source.width, source.height), width, height) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const out = new Uint8ClampedArray(width * height * 4);
  const src = source.data;
  const maxX = source.width - 1;
  const maxY = source.height - 1;
  let o = 0;
  for (let v = 0; v < height; v++) {
    const vc = v + 0.5;
    for (let u = 0; u < width; u++) {
      const uc = u + 0.5;
      const w = g * uc + h * vc + 1;
      const x = clamp((a * uc + b * vc + c) / w - 0.5, 0, maxX);
      const y = clamp((d * uc + e * vc + f) / w - 0.5, 0, maxY);
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, maxX);
      const y1 = Math.min(y0 + 1, maxY);
      const fx = x - x0;
      const fy = y - y0;
      const p00 = (y0 * source.width + x0) * 4;
      const p10 = (y0 * source.width + x1) * 4;
      const p01 = (y1 * source.width + x0) * 4;
      const p11 = (y1 * source.width + x1) * 4;
      for (let k = 0; k < 3; k++) {
        const top = (src[p00 + k] ?? 0) + ((src[p10 + k] ?? 0) - (src[p00 + k] ?? 0)) * fx;
        const bottom = (src[p01 + k] ?? 0) + ((src[p11 + k] ?? 0) - (src[p01 + k] ?? 0)) * fx;
        out[o + k] = top + (bottom - top) * fy;
      }
      out[o + 3] = 255;
      o += 4;
    }
  }
  return { width, height, data: out };
}

/** The pixels in shades of grey, in place. */
export function toGrayscale(pixels: Pixels): Pixels {
  const { data } = pixels;
  for (let p = 0; p < data.length; p += 4) {
    const value = ((data[p] ?? 0) * 299 + (data[p + 1] ?? 0) * 587 + (data[p + 2] ?? 0) * 114) / 1000;
    data[p] = data[p + 1] = data[p + 2] = value;
  }
  return pixels;
}

/** A quad's corner by index, counting round (4 is the first again). */
function corner(quad: Quad, index: number): Point {
  return quad[index % 4] ?? quad[0];
}

/** A quad's corners in pixels of a `width` × `height` photo. */
function inPixels(quad: Quad, width: number, height: number): Quad {
  const scale = (point: Point): Point => ({ x: point.x * width, y: point.y * height });
  return [scale(quad[0]), scale(quad[1]), scale(quad[2]), scale(quad[3])];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
