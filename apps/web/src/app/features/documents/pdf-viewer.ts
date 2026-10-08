import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  InjectionToken,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type {
  PageViewport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

import { MtButton, MtIconButton, MtNote } from '@materia/ui';

import { hasTextLayer, highlightBoxes, type HighlightBox, type PdfPageText, type PdfTextItem } from './pdf-highlight';

/** Why a PDF couldn't be shown. */
export type PdfProblem = 'encrypted' | 'corrupt' | 'failed';

/** The PDF.js assets copied next to the app (`assets/pdfjs`, see apps/web/project.json). */
function pdfAsset(path: string): string {
  return new URL(`assets/pdfjs/${path}`, document.baseURI).href;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | undefined;

/**
 * PDF.js, loaded the first time a PDF is opened: the library is its own lazy chunk and the worker a
 * static asset (`assets/pdfjs/pdf.worker.min.mjs`), so neither is in any other bundle. The legacy
 * build, which carries its own polyfills: the modern one needs very recent engines (`Promise.try`,
 * `Map#getOrInsertComputed`), which Safari and older Chromium lack.
 */
export function loadPdfJs(): Promise<PdfJs> {
  return (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = pdfAsset('pdf.worker.min.mjs');
    return lib;
  }));
}

/** The parts of PDF.js the viewer uses. */
type PdfLib = Pick<PdfJs, 'getDocument' | 'TextLayer'>;

/** Loads PDF.js (tests replace it with a fake). */
export const PDFJS_LOADER = new InjectionToken<() => Promise<PdfLib>>('PDFJS_LOADER', {
  providedIn: 'root',
  factory: () => loadPdfJs,
});

/**
 * How long the viewer waits before it opens a PDF that didn't load once more (ms; tests use 0). A
 * load can fail for a moment (a phone between networks); a password or a damaged file isn't retried.
 */
export const PDF_RETRY_MS = new InjectionToken<number>('PDF_RETRY_MS', { providedIn: 'root', factory: () => 1000 });

/**
 * Where a scanned page's text is kept: the stored text of `pages` (what OCR read from a page with no
 * text of its own), by page. A page left out has none.
 */
export type PdfStoredText = (pages: number[]) => Promise<ReadonlyMap<number, string>>;

/** How many pages' stored text one call asks for, so scrolling through a scan makes few calls. */
const STORED_TEXT_PAGES = 10;

/** What a screen reader hears for a scanned page: its stored text, or why there is none. */
export const SCANNED_PAGE_COPY = {
  text: 'Scanned page. Text read from the scan:',
  none: 'Scanned page with no text Materia could read. Download the document to open it in another app.',
  failed: 'Scanned page. Its text didn’t load. Download the document to open it in another app.',
} as const;

/** A PDF.js failure as what the person can do about it. */
export function pdfProblem(error: unknown): PdfProblem {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') return 'encrypted';
  if (name === 'InvalidPDFException') return 'corrupt';
  return 'failed';
}

export const PDF_PROBLEM_COPY: Readonly<Record<PdfProblem, string>> = {
  encrypted:
    'This PDF is password-protected, so it can’t be previewed. Download it and open it with the password. Materia never asks for or stores the password.',
  corrupt: 'This PDF looks damaged, so it can’t be previewed. Download it to try another app, or upload a fresh copy.',
  failed: 'The preview didn’t load. Check your connection and try again, or download the file.',
};

/** A passage to highlight (a citation, AI-05): its page, the page it runs to, and the quote. */
export interface PdfHighlight {
  page: number;
  pageEnd?: number | undefined;
  quote: string;
}

/** What the highlight found: drawn boxes, or why not (no text layer: a scanned page). */
export interface PdfHighlightResult {
  found: boolean;
  textLayer: boolean;
}

/** Zoom: 100% fits the page to the width; pinch or the buttons go up to 300%, in 25% steps. */
export const PDF_ZOOM_MIN = 1;
export const PDF_ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
/** Pages redraw sharp this long after the zoom stops changing (ms); until then they scale. */
const ZOOM_REDRAW_MS = 250;
/** The most pixels a page's canvas may have: iOS Safari won't draw a canvas over about 16.7 million. */
const MAX_CANVAS_PIXELS = 12_000_000;

/** A zoom level inside the limits, to the nearest 1%. */
export function clampZoom(zoom: number): number {
  return Math.round(Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom)) * 100) / 100;
}

interface PageSlot {
  number: number;
  /** CSS height of the slot before it renders (from the first page's shape). */
  height: number;
}

/**
 * A sandboxed PDF viewer (CORE-12): PDF.js parses the file in a Web Worker and paints each page to a
 * canvas. Nothing in the PDF runs: no JavaScript, forms, XFA or links are rendered, and the bytes
 * come from a short-lived signed URL by `fetch`, never as a page the browser opens. Pages render
 * lazily as they scroll near the viewport, so a 500-page PDF opens as fast as a short one (PDF.js
 * fetches byte ranges where the server allows it). Over each canvas is PDF.js's text layer (SEC-06b):
 * the page's text, transparent and in place, so screen readers read it and it can be found and
 * selected. A scanned page has no text of its own; given `storedText`, a screen reader hears what
 * OCR read from it instead. `page` scrolls to a page (citations: `?page=N`), and `pageChange` reports the
 * page in view. `highlight` (AI-05) marks a quote on its page from PDF.js's text content, across a
 * page break when it runs on, scrolls it into view and reports the outcome (`highlighted`): a
 * scanned page has no text layer, so the caller shows the OCR text instead.
 *
 * Zoom (MOB-02): pinch with two fingers, the − and + buttons, or `-`, `+` and `0` in the pages; the
 * percentage button fits the width again. Pages scale at once and redraw sharp when the zoom settles.
 *
 * A load that fails is tried once more after a moment (`PDF_RETRY_MS`) before the viewer says so and
 * reports `failed`; the caller can then offer a fresh URL.
 */
@Component({
  selector: 'mt-pdf-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtIconButton, MtNote],
  host: { class: 'mt-pdf-viewer' },
  template: `
    @if (problem(); as p) {
      <mt-note [tone]="p === 'failed' ? 'danger' : 'warning'">{{ copy[p] }}</mt-note>
    } @else {
      <div class="bar" role="toolbar" [attr.aria-label]="'Pages of ' + label()">
        <button
          mtButton
          variant="ghost"
          size="sm"
          iconStart="chevron-left"
          [disabled]="current() <= 1"
          (click)="go(current() - 1)"
        >
          Previous page
        </button>
        <span class="caption t-2" aria-live="polite">
          @if (count()) {
            Page {{ current() }} of {{ count() }}
          } @else {
            Opening the PDF…
          }
        </span>
        <button
          mtButton
          variant="ghost"
          size="sm"
          iconEnd="chevron-right"
          [disabled]="current() >= count()"
          (click)="go(current() + 1)"
        >
          Next page
        </button>
        <span class="zoom" role="group" aria-label="Zoom">
          <button
            mtIconButton
            icon="minus"
            size="sm"
            label="Zoom out"
            data-zoom-out
            [disabled]="zoom() <= minZoom"
            (click)="zoomBy(-1)"
          ></button>
          <button
            mtButton
            variant="ghost"
            size="sm"
            data-zoom-fit
            [attr.aria-label]="'Zoom ' + percent() + '%. Fit to width'"
            [disabled]="zoom() === minZoom"
            (click)="setZoom(minZoom)"
          >
            {{ percent() }}%
          </button>
          <button
            mtIconButton
            icon="plus"
            size="sm"
            label="Zoom in"
            data-zoom-in
            [disabled]="zoom() >= maxZoom"
            (click)="zoomBy(1)"
          ></button>
        </span>
      </div>
      <div
        #scroller
        class="pages"
        tabindex="0"
        [attr.aria-label]="label()"
        role="region"
        aria-keyshortcuts="+ - 0"
        [style.--mt-pdf-zoom]="zoom()"
        (scroll)="onScroll()"
        (keydown)="onKey($event)"
      >
        @for (slot of slots(); track slot.number) {
          <div class="page" [attr.data-page]="slot.number" [style.min-height.px]="slot.height * zoom()">
            <div class="mt-sr" role="heading" aria-level="3">Page {{ slot.number }}</div>
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-height: 0;
      flex: 1;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
    }
    .zoom {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      margin-left: auto;
    }
    .zoom [data-zoom-fit] {
      min-width: 56px;
      font-variant-numeric: tabular-nums;
    }
    .pages {
      flex: 1;
      min-height: 320px;
      max-height: calc(100vh - 220px);
      overflow: auto;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-12);
      padding: var(--space-12);
      background: var(--bg-sunken);
      border-radius: var(--radius-md);
      /* Two fingers zoom the pages (below), not the whole app. */
      touch-action: pan-x pan-y;
    }
    .pages:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .page {
      position: relative;
      flex: none;
      width: calc(100% * var(--mt-pdf-zoom, 1));
      background: #fff;
      box-shadow: var(--shadow-card, 0 1px 2px rgb(0 0 0 / 12%));
    }
    /* A drawn page is as tall as its canvas: the placeholder height is the first page's shape. */
    .page[data-rendered] {
      min-height: 0 !important;
    }
    /* The canvas and highlight boxes are created in code, outside the template's encapsulation. */
    .page ::ng-deep canvas {
      display: block;
      width: 100%;
      height: auto;
    }
    /* PDF.js's text layer (web/pdf_viewer.css): transparent text sized and placed over the canvas. */
    .page ::ng-deep .textLayer {
      position: absolute;
      inset: 0;
      overflow: clip;
      line-height: 1;
      letter-spacing: normal;
      word-spacing: normal;
      text-align: initial;
      text-size-adjust: none;
      forced-color-adjust: none;
      transform-origin: 0 0;
      caret-color: CanvasText;
      z-index: 0;
      --scale-round-x: 1px;
      --scale-round-y: 1px;
      --min-font-size: 1;
      --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
      --min-font-size-inv: calc(1 / var(--min-font-size));
    }
    .page ::ng-deep .textLayer :is(span, br) {
      color: transparent;
      position: absolute;
      white-space: pre;
      cursor: text;
      transform-origin: 0% 0%;
    }
    .page ::ng-deep .textLayer > :not(.markedContent) {
      z-index: 1;
      --font-height: 0;
      font-size: calc(var(--text-scale-factor) * var(--font-height));
      --scale-x: 1;
      --rotate: 0deg;
      transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
    }
    .page ::ng-deep .textLayer ::selection {
      background: color-mix(in srgb, AccentColor, transparent 75%);
    }
    .page ::ng-deep .textLayer br::selection {
      background: transparent;
    }
    .page ::ng-deep .textLayer[data-main-rotation='90'] {
      transform: rotate(90deg) translateY(-100%);
    }
    .page ::ng-deep .textLayer[data-main-rotation='180'] {
      transform: rotate(180deg) translate(-100%, -100%);
    }
    .page ::ng-deep .textLayer[data-main-rotation='270'] {
      transform: rotate(270deg) translateX(-100%);
    }
    .page ::ng-deep .mt-pdf-hl {
      display: block;
      position: absolute;
      margin: 0;
      padding: 0;
      background: var(--amber-300);
      opacity: 0.45;
      mix-blend-mode: multiply;
      border-radius: 2px;
      pointer-events: none;
    }
  `,
})
export class PdfViewer {
  /** A signed URL for the PDF's bytes. */
  readonly url = input.required<string>();
  /** The document's name, for accessible labels. */
  readonly label = input.required<string>();
  /** Scroll to this page (1-based) once loaded, and whenever it changes. */
  readonly page = input<number | null>(null);
  /** A quote to mark (citations, AI-05). */
  readonly highlight = input<PdfHighlight | null>(null);
  /** Where scanned pages' stored text comes from; without it a scanned page is only its image. */
  readonly storedText = input<PdfStoredText | null>(null);

  readonly pageChange = output<number>();
  readonly highlighted = output<PdfHighlightResult>();
  readonly loaded = output<number>();
  readonly failed = output<PdfProblem>();

  protected readonly copy = PDF_PROBLEM_COPY;
  protected readonly problem = signal<PdfProblem | null>(null);
  protected readonly count = signal(0);
  protected readonly current = signal(1);
  protected readonly slots = signal<PageSlot[]>([]);
  protected readonly zoom = signal(PDF_ZOOM_MIN);
  protected readonly percent = computed(() => Math.round(this.zoom() * 100));
  protected readonly minZoom = PDF_ZOOM_MIN;
  protected readonly maxZoom = PDF_ZOOM_MAX;
  private redrawTimer: ReturnType<typeof setTimeout> | undefined;
  /** Each page render's turn, so a slower earlier render doesn't replace a newer one. */
  private renderSeq = 0;
  /** A two-finger pinch: the finger spread and the zoom when it started. */
  private pinch: { distance: number; zoom: number } | null = null;
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly loadLib = inject(PDFJS_LOADER);
  private readonly retryMs = inject(PDF_RETRY_MS);

  private lib: PdfLib | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private pdf: PDFDocumentProxy | null = null;
  /** Scanned pages' stored text by page, as it loads (null: it didn't). */
  private stored = new Map<number, Promise<string | null>>();
  private observer: IntersectionObserver | null = null;
  private readonly rendered = new Set<number>();
  /** The highlight's boxes by page, once located. */
  private boxes = new Map<number, HighlightBox[]>();
  private highlightId = 0;
  private loadId = 0;

  constructor() {
    effect(() => {
      const url = this.url();
      untracked(() => void this.open(url));
    });
    effect(() => {
      const page = this.page();
      if (page && this.count()) untracked(() => this.scrollTo(page));
    });
    effect(() => {
      const highlight = this.highlight();
      if (this.count()) untracked(() => void this.locate(highlight));
    });
    // Pinch to zoom: passive listeners, since `touch-action` already stops the browser's own zoom.
    effect((onCleanup) => {
      const scroller = this.scroller()?.nativeElement;
      if (!scroller) return;
      const start = (event: TouchEvent) => {
        this.pinch = event.touches.length === 2 ? { distance: spread(event.touches), zoom: this.zoom() } : null;
      };
      const move = (event: TouchEvent) => {
        const pinch = this.pinch;
        if (!pinch || event.touches.length !== 2) return;
        this.setZoom(pinch.zoom * (spread(event.touches) / pinch.distance), middle(event.touches));
      };
      const end = (event: TouchEvent) => {
        if (event.touches.length < 2) this.pinch = null;
      };
      const options = { passive: true } as const;
      scroller.addEventListener('touchstart', start, options);
      scroller.addEventListener('touchmove', move, options);
      scroller.addEventListener('touchend', end, options);
      scroller.addEventListener('touchcancel', end, options);
      onCleanup(() => {
        scroller.removeEventListener('touchstart', start);
        scroller.removeEventListener('touchmove', move);
        scroller.removeEventListener('touchend', end);
        scroller.removeEventListener('touchcancel', end);
      });
    });
    // The width a page has at 100%, which sizes the text layers (with the zoom) as the view resizes.
    effect((onCleanup) => {
      const scroller = this.scroller()?.nativeElement;
      if (!scroller || typeof ResizeObserver !== 'function') return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry) scroller.style.setProperty('--mt-pdf-fit', String(entry.contentRect.width));
      });
      observer.observe(scroller);
      onCleanup(() => observer.disconnect());
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.redrawTimer);
      // Stops a load still in flight: it would otherwise open the PDF after all, and report to a
      // caller that is gone.
      this.loadId++;
      this.close();
    });
  }

  /** One zoom step in (1) or out (-1), keeping the middle of the view in place. */
  protected zoomBy(steps: number): void {
    this.setZoom(Math.round((this.zoom() + steps * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP);
  }

  /**
   * Zooms to `value`, keeping the point under `anchor` (screen coordinates; the middle of the view by
   * default) where it is, then redraws the pages sharp once the zoom settles.
   */
  setZoom(value: number, anchor?: { x: number; y: number }): void {
    const next = clampZoom(value);
    const before = this.zoom();
    if (next === before) return;
    const scroller = this.scroller()?.nativeElement;
    this.zoom.set(next);
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const x = anchor ? anchor.x - box.left : scroller.clientWidth / 2;
      const y = anchor ? anchor.y - box.top : scroller.clientHeight / 2;
      const left = scroller.scrollLeft + x;
      const top = scroller.scrollTop + y;
      // Apply the new width now (the binding follows), so the scroll position is measured against it.
      scroller.style.setProperty('--mt-pdf-zoom', String(next));
      const ratio = next / before;
      scroller.scrollLeft = left * ratio - x;
      scroller.scrollTop = top * ratio - y;
    }
    clearTimeout(this.redrawTimer);
    this.redrawTimer = setTimeout(() => this.redraw(), ZOOM_REDRAW_MS);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') this.zoomBy(1);
    else if (event.key === '-') this.zoomBy(-1);
    else if (event.key === '0') this.setZoom(PDF_ZOOM_MIN);
    else return;
    event.preventDefault();
  }

  /** Draws the pages near the view again at the current zoom; the rest redraw as they come into view. */
  private redraw(): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller || !this.observer) return;
    this.rendered.clear();
    this.observer.disconnect();
    for (const element of scroller.querySelectorAll('.page')) this.observer.observe(element);
  }

  protected go(page: number): void {
    this.scrollTo(page);
    this.pageChange.emit(this.current());
  }

  protected onScroll(): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    let best = this.current();
    for (const element of scroller.querySelectorAll<HTMLElement>('.page')) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > top + 40) {
        best = Number(element.dataset['page']);
        break;
      }
    }
    if (best !== this.current()) {
      this.current.set(best);
      this.pageChange.emit(best);
    }
  }

  private scrollTo(page: number): void {
    const target = Math.min(Math.max(1, Math.round(page)), this.count() || 1);
    this.current.set(target);
    const scroller = this.scroller()?.nativeElement;
    const element = scroller?.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (scroller && element) {
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    }
  }

  private async open(url: string): Promise<void> {
    const id = ++this.loadId;
    this.close();
    this.problem.set(null);
    this.count.set(0);
    this.slots.set([]);
    this.zoom.set(PDF_ZOOM_MIN);
    try {
      const lib = await this.loadLib();
      if (id !== this.loadId) return;
      this.lib = lib;
      let pdf: PDFDocumentProxy;
      try {
        pdf = await this.fetchPdf(lib, url);
      } catch (error) {
        if (id !== this.loadId || pdfProblem(error) !== 'failed') throw error;
        await new Promise((resolve) => setTimeout(resolve, this.retryMs));
        if (id !== this.loadId) return;
        pdf = await this.fetchPdf(lib, url);
      }
      if (id !== this.loadId) return void pdf.loadingTask.destroy();
      this.pdf = pdf;
      const first = await pdf.getPage(1);
      const shape = first.getViewport({ scale: 1 });
      const width = this.scroller()?.nativeElement.clientWidth || this.host.nativeElement.clientWidth || 800;
      const height = Math.round(((width - 24) * shape.height) / shape.width);
      this.slots.set(Array.from({ length: pdf.numPages }, (_, i) => ({ number: i + 1, height })));
      this.count.set(pdf.numPages);
      this.loaded.emit(pdf.numPages);
      afterNextRender(
        () => {
          if (id !== this.loadId) return;
          this.watchPages();
          const wanted = this.page();
          if (wanted) this.scrollTo(wanted);
        },
        { injector: this.injector },
      );
    } catch (error) {
      if (id !== this.loadId) return;
      const problem = pdfProblem(error);
      this.problem.set(problem);
      this.failed.emit(problem);
    }
  }

  /** Starts PDF.js on `url` (the loading task is kept, so `close` can stop it). */
  private fetchPdf(lib: PdfLib, url: string): Promise<PDFDocumentProxy> {
    void this.task?.destroy();
    this.task = lib.getDocument({
      url,
      cMapUrl: pdfAsset('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: pdfAsset('standard_fonts/'),
      wasmUrl: pdfAsset('wasm/'),
      // PDF.js 6 never compiles code from the file to draw fonts (CVE-2024-4367), so there is no
      // `isEvalSupported` to switch off.
      enableXfa: false,
    });
    return this.task.promise;
  }

  /** Renders pages as they come within a screen of the viewport. */
  private watchPages(): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) return;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const number = Number((entry.target as HTMLElement).dataset['page']);
          if (!this.rendered.has(number)) void this.renderPage(entry.target as HTMLElement, number);
        }
      },
      { root: scroller, rootMargin: '100% 0px' },
    );
    for (const element of scroller.querySelectorAll('.page')) this.observer.observe(element);
  }

  private async renderPage(slot: HTMLElement, number: number): Promise<void> {
    const pdf = this.pdf;
    if (!pdf) return;
    this.rendered.add(number);
    const turn = String(++this.renderSeq);
    slot.dataset['render'] = turn;
    try {
      const page = await pdf.getPage(number);
      const width = slot.clientWidth || 800;
      const base = page.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      // Sharp at the zoom shown, short of the canvas size a phone can draw.
      const most = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
      const viewport = page.getViewport({ scale: Math.min((width / base.width) * ratio, most) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setAttribute('aria-hidden', 'true');
      await page.render({ canvas, viewport }).promise;
      if (pdf !== this.pdf || slot.dataset['render'] !== turn) return;
      const drawn = slot.dataset['rendered'] !== undefined;
      slot.style.minHeight = '';
      const old = slot.querySelector('canvas');
      if (old) old.replaceWith(canvas);
      else slot.appendChild(canvas);
      slot.dataset['rendered'] = '';
      this.drawBoxes(slot, number);
      // A redraw at a new zoom keeps the page's text from the first time: it scales with the page.
      if (drawn) return;
      const text = await page.getTextContent();
      if (pdf !== this.pdf) return;
      if (text.items.some((item) => 'str' in item && item.str.trim())) {
        await this.drawText(slot, text, page.getViewport({ scale: width / base.width }), base.width);
      } else {
        await this.describeScan(slot, number);
      }
    } catch {
      this.rendered.delete(number);
    }
  }

  /**
   * PDF.js's text layer over the canvas: each run of text, transparent, where the page shows it. It
   * scales with the page: the width at 100% (`--mt-pdf-fit`, until measured the width now) times
   * the zoom, over the page's own width.
   */
  private async drawText(
    slot: HTMLElement,
    text: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
    viewport: PageViewport,
    pageWidth: number,
  ): Promise<void> {
    const lib = this.lib;
    if (!lib) return;
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    const fit = (slot.clientWidth || 800) / this.zoom();
    layer.style.setProperty(
      '--total-scale-factor',
      `calc(var(--mt-pdf-fit, ${fit}) * var(--mt-pdf-zoom, 1) / ${pageWidth})`,
    );
    slot.appendChild(layer);
    await new lib.TextLayer({ textContentSource: text, container: layer, viewport }).render();
  }

  /** A scanned page, for screen readers: the text OCR read from it, or that there is none. */
  private async describeScan(slot: HTMLElement, number: number): Promise<void> {
    const source = this.storedText();
    if (!source) return;
    const pdf = this.pdf;
    const text = await this.scanText(source, number);
    if (pdf !== this.pdf) return;
    const reader = document.createElement('div');
    reader.className = 'mt-sr';
    reader.dataset['scanText'] = '';
    if (text === null) reader.textContent = SCANNED_PAGE_COPY.failed;
    else reader.textContent = text.trim() ? `${SCANNED_PAGE_COPY.text} ${text.trim()}` : SCANNED_PAGE_COPY.none;
    slot.appendChild(reader);
  }

  /** A scanned page's stored text, asked for with the next few pages not yet asked for. */
  private scanText(source: PdfStoredText, number: number): Promise<string | null> {
    const known = this.stored.get(number);
    if (known) return known;
    const pages: number[] = [];
    for (let page = number; page <= this.count() && pages.length < STORED_TEXT_PAGES; page++) {
      if (!this.stored.has(page)) pages.push(page);
    }
    const batch = source(pages).catch(() => null);
    const textOf = (page: number) => batch.then((texts) => (texts ? (texts.get(page) ?? '') : null));
    for (const page of pages) this.stored.set(page, textOf(page));
    return textOf(number);
  }

  /**
   * Finds the highlight's quote in the text of its page (and the next, or up to `pageEnd`), draws
   * it on the pages already rendered (the rest draw as they render) and scrolls it into view.
   */
  private async locate(highlight: PdfHighlight | null): Promise<void> {
    const id = ++this.highlightId;
    this.boxes = new Map();
    this.clearBoxes();
    const pdf = this.pdf;
    if (!highlight || !pdf) return;
    const first = Math.min(Math.max(1, highlight.page), pdf.numPages);
    const last = Math.min(pdf.numPages, Math.max(first + 1, highlight.pageEnd ?? first));
    try {
      const pages: PdfPageText[] = [];
      for (let number = first; number <= last; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 }) as PdfPageText['viewport'];
        const items = content.items.filter((item) => 'str' in item) as unknown as PdfTextItem[];
        pages.push({ page: number, items, viewport });
      }
      if (id !== this.highlightId || pdf !== this.pdf) return;
      const cited = pages.filter((page) => page.page <= Math.max(first, highlight.pageEnd ?? first));
      const boxes = highlightBoxes(pages, highlight.quote);
      for (const box of boxes ?? []) this.boxes.set(box.page, [...(this.boxes.get(box.page) ?? []), box]);
      const scroller = this.scroller()?.nativeElement;
      for (const number of this.boxes.keys()) {
        const slot = scroller?.querySelector<HTMLElement>(`[data-page="${number}"][data-rendered]`);
        if (slot) this.drawBoxes(slot, number);
      }
      this.highlighted.emit({ found: !!boxes, textLayer: hasTextLayer(cited) });
      if (boxes) this.revealBox();
    } catch {
      if (id === this.highlightId) this.highlighted.emit({ found: false, textLayer: false });
    }
  }

  private drawBoxes(slot: HTMLElement, number: number): void {
    for (const old of slot.querySelectorAll('.mt-pdf-hl')) old.remove();
    for (const box of this.boxes.get(number) ?? []) {
      const mark = document.createElement('mark');
      mark.className = 'mt-pdf-hl';
      mark.dataset['highlight'] = '';
      mark.setAttribute('aria-hidden', 'true');
      mark.style.left = `${box.left}%`;
      mark.style.top = `${box.top}%`;
      mark.style.width = `${box.width}%`;
      mark.style.height = `${box.height}%`;
      slot.appendChild(mark);
    }
  }

  private clearBoxes(): void {
    for (const mark of this.scroller()?.nativeElement.querySelectorAll('.mt-pdf-hl') ?? []) mark.remove();
  }

  /** Scrolls so the first box shows a little below the top of the pages. */
  private revealBox(): void {
    const scroller = this.scroller()?.nativeElement;
    const first = [...this.boxes.values()][0]?.[0];
    if (!scroller || !first) return;
    const slot = scroller.querySelector<HTMLElement>(`[data-page="${first.page}"]`);
    if (!slot) return;
    const slotTop = slot.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const height = slot.getBoundingClientRect().height || slot.clientHeight;
    scroller.scrollTop += slotTop + (height * first.top) / 100 - 48;
  }

  private close(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.rendered.clear();
    this.stored = new Map();
    void this.task?.destroy();
    this.task = null;
    this.pdf = null;
  }
}

/** How far apart two fingers are, in px. */
function spread(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 : 1;
}

/** The point between two fingers. */
function middle(touches: TouchList): { x: number; y: number } {
  const [a, b] = [touches[0], touches[1]];
  return a && b ? { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 } : { x: 0, y: 0 };
}
