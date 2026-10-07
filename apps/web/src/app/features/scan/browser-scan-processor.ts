import { detectPage, pageSize, type Pixels, toGrayscale, warpPage, WHOLE_PHOTO } from './scan-image';
import { ScanError, type ScanProcessor } from './scan-processor';

/** The straightened page's longer side (px). */
const PAGE_EDGE = 2000;
/**
 * The working copy of the photo, kept with the page for re-cropping and turning it: a little
 * larger than the page, so straightening keeps detail.
 */
const PHOTO_EDGE = 2600;
/** Finding the page needs only a small copy. */
const DETECT_EDGE = 400;
/** The page in the list of pages. */
const THUMB_EDGE = 320;
const JPEG_QUALITY = 0.8;
const PHOTO_QUALITY = 0.85;

const UNREADABLE = 'This photo can’t be read here. Take it again with the camera, or save it as a JPEG first.';
const NO_CANVAS = 'This browser can’t process photos. Try another browser.';

/**
 * Photos to pages on a canvas (MOB-05), one photo at a time so a phone holds one full-size image
 * at most. The browser decodes whatever it can show, HEIC included on an iPhone, and the page
 * comes out as a JPEG.
 */
export function browserScanProcessor(): ScanProcessor {
  return {
    async process(photo, options = {}) {
      const source = await decode(photo);
      const scale = Math.min(1, PHOTO_EDGE / Math.max(source.width, source.height));
      let work: Canvas | undefined;
      try {
        work = canvas(Math.round(source.width * scale), Math.round(source.height * scale));
        work.context.drawImage(source.image, 0, 0, work.canvas.width, work.canvas.height);
      } finally {
        source.release();
      }
      const { width, height } = work.canvas;
      try {
        // A page made again from its own working copy keeps that copy.
        const kept = options.quad && scale === 1 ? photo : await toJpeg(work.canvas, PHOTO_QUALITY);
        const found = options.quad ? null : detectPage(pixelsOf(shrinkToCanvas(work.canvas, DETECT_EDGE)));
        const quad = options.quad ?? found ?? WHOLE_PHOTO;
        const size = pageSize(quad, width, height, PAGE_EDGE);
        const page = await encode(
          warpPage(work.context.getImageData(0, 0, width, height), quad, size.width, size.height),
        );
        return {
          jpeg: page.jpeg,
          thumb: page.thumb,
          width: size.width,
          height: size.height,
          quad,
          found: !!found || !!options.quad,
          photo: kept,
          photoWidth: width,
          photoHeight: height,
        };
      } finally {
        free(work.canvas);
      }
    },

    async grayscale(jpeg) {
      const source = await decode(jpeg);
      let work: Canvas | undefined;
      try {
        work = canvas(source.width, source.height);
        work.context.drawImage(source.image, 0, 0);
      } finally {
        source.release();
      }
      try {
        return (await encode(toGrayscale(work.context.getImageData(0, 0, source.width, source.height)), false)).jpeg;
      } finally {
        free(work.canvas);
      }
    },
  };
}

interface Canvas {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

interface Decoded {
  image: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** The photo decoded, turned the way it was taken (EXIF), or a ScanError. */
async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Some engines decode more formats through an <img> (HEIC in Safari).
    }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new ScanError(UNREADABLE);
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new ScanError(UNREADABLE);
  }
  return {
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

function canvas(width: number, height: number): Canvas {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const context = element.getContext('2d', { willReadFrequently: true });
  if (!context) throw new ScanError(NO_CANVAS);
  return { canvas: element, context };
}

/** Lets a phone release a canvas's memory now rather than at the next collection. */
function free(element: HTMLCanvasElement): void {
  element.width = 0;
  element.height = 0;
}

function pixelsOf(element: HTMLCanvasElement): Pixels {
  try {
    const context = element.getContext('2d', { willReadFrequently: true });
    if (!context) throw new ScanError(NO_CANVAS);
    return context.getImageData(0, 0, element.width, element.height);
  } finally {
    free(element);
  }
}

/** A copy at most `edge` on its longer side. */
function shrinkToCanvas(from: HTMLCanvasElement, edge: number): HTMLCanvasElement {
  const scale = Math.min(1, edge / Math.max(from.width, from.height));
  const small = canvas(Math.max(1, Math.round(from.width * scale)), Math.max(1, Math.round(from.height * scale)));
  small.context.imageSmoothingQuality = 'high';
  small.context.drawImage(from, 0, 0, small.canvas.width, small.canvas.height);
  return small.canvas;
}

/** The page as a JPEG, and its thumbnail unless `withThumb` is false. */
async function encode(pixels: Pixels, withThumb = true): Promise<{ jpeg: Blob; thumb: Blob }> {
  const out = canvas(pixels.width, pixels.height);
  try {
    out.context.putImageData(
      new ImageData(pixels.data as Uint8ClampedArray<ArrayBuffer>, pixels.width, pixels.height),
      0,
      0,
    );
    const jpeg = await toJpeg(out.canvas, JPEG_QUALITY);
    if (!withThumb) return { jpeg, thumb: jpeg };
    const small = shrinkToCanvas(out.canvas, THUMB_EDGE);
    try {
      return { jpeg, thumb: await toJpeg(small, JPEG_QUALITY) };
    } finally {
      free(small);
    }
  } finally {
    free(out.canvas);
  }
}

function toJpeg(element: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    element.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ScanError('The page couldn’t be saved. Try again.'))),
      'image/jpeg',
      quality,
    ),
  );
}
