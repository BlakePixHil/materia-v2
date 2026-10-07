import { InjectionToken } from '@angular/core';

import type { Quad } from './scan-image';

/** A page ready for the PDF: the photo's page, straightened and compressed. */
export interface ScannedPage {
  /** The page as a JPEG (quality 0.8, at most 2000px on its longer side). */
  jpeg: Blob;
  width: number;
  height: number;
  /** Where the page is in the photo (the whole photo when nothing was found or chosen). */
  quad: Quad;
  /** The page's corners were found in the photo or set by hand, not just the whole photo used. */
  found: boolean;
  /** A small copy of the page for the list of pages. */
  thumb: Blob;
  /**
   * The whole photo at working size, for dragging the corners and for turning or re-cropping the
   * page (`process(photo, { quad })`); the original photo isn't kept.
   */
  photo: Blob;
  photoWidth: number;
  photoHeight: number;
}

/** Why a photo couldn't become a page, in words a person can act on. */
export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanError';
  }
}

/**
 * Turns photos into pages (MOB-05). The browser one draws on a canvas and loads with the Scan
 * screen; tests use a fake.
 */
export interface ScanProcessor {
  /**
   * Finds the page in the photo (or uses `quad`), straightens it and compresses it. Given a page's
   * `photo` and a `quad`, it makes the page again (turned or re-cropped).
   */
  process(photo: Blob, options?: { quad?: Quad }): Promise<ScannedPage>;
  /** A page's JPEG in shades of grey (for a black-and-white scan). */
  grayscale(jpeg: Blob): Promise<Blob>;
}

export const SCAN_PROCESSOR = new InjectionToken<ScanProcessor>('SCAN_PROCESSOR', {
  providedIn: 'root',
  factory: () => {
    let loaded: Promise<ScanProcessor> | undefined;
    const load = () => (loaded ??= import('./browser-scan-processor').then((m) => m.browserScanProcessor()));
    return {
      process: async (photo, options) => (await load()).process(photo, options),
      grayscale: async (jpeg) => (await load()).grayscale(jpeg),
    };
  },
});
