import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
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
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { MtButton, MtNote } from '@materia/ui';

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

/** Loads PDF.js (tests replace it with a fake). */
export const PDFJS_LOADER = new InjectionToken<() => Promise<Pick<PdfJs, 'getDocument'>>>('PDFJS_LOADER', {
  providedIn: 'root',
  factory: () => loadPdfJs,
});

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
 * fetches byte ranges where the server allows it). Each page's text is in a visually hidden block
 * for screen readers. `page` scrolls to a page (citations: `?page=N`), and `pageChange` reports the
 * page in view. `highlight` (AI-05) marks a quote on its page from PDF.js's text content, across a
 * page break when it runs on, scrolls it into view and reports the outcome (`highlighted`): a
 * scanned page has no text layer, so the caller shows the OCR text instead.
 */
@Component({
  selector: 'mt-pdf-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtNote],
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
      </div>
      <div #scroller class="pages" tabindex="0" [attr.aria-label]="label()" role="region" (scroll)="onScroll()">
        @for (slot of slots(); track slot.number) {
          <div class="page" [attr.data-page]="slot.number" [style.min-height.px]="slot.height">
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
      align-items: center;
      gap: var(--space-8);
    }
    .pages {
      flex: 1;
      min-height: 320px;
      max-height: calc(100vh - 220px);
      overflow: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-12);
      padding: var(--space-12);
      background: var(--bg-sunken);
      border-radius: var(--radius-md);
    }
    .pages:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .page {
      position: relative;
      width: 100%;
      background: #fff;
      box-shadow: var(--shadow-card, 0 1px 2px rgb(0 0 0 / 12%));
    }
    /* The canvas and highlight boxes are created in code, outside the template's encapsulation. */
    .page ::ng-deep canvas {
      display: block;
      width: 100%;
      height: auto;
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

  readonly pageChange = output<number>();
  readonly highlighted = output<PdfHighlightResult>();
  readonly loaded = output<number>();
  readonly failed = output<PdfProblem>();

  protected readonly copy = PDF_PROBLEM_COPY;
  protected readonly problem = signal<PdfProblem | null>(null);
  protected readonly count = signal(0);
  protected readonly current = signal(1);
  protected readonly slots = signal<PageSlot[]>([]);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly loadLib = inject(PDFJS_LOADER);

  private task: PDFDocumentLoadingTask | null = null;
  private pdf: PDFDocumentProxy | null = null;
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
    inject(DestroyRef).onDestroy(() => this.close());
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
    try {
      const lib = await this.loadLib();
      if (id !== this.loadId) return;
      this.task = lib.getDocument({
        url,
        cMapUrl: pdfAsset('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: pdfAsset('standard_fonts/'),
        wasmUrl: pdfAsset('wasm/'),
        enableXfa: false,
        // Fonts are drawn without compiling code from the file (hardening, CVE-2024-4367).
        isEvalSupported: false,
      });
      const pdf = await this.task.promise;
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
    try {
      const page = await pdf.getPage(number);
      const width = slot.clientWidth || 800;
      const base = page.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * ratio });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setAttribute('aria-hidden', 'true');
      await page.render({ canvas, viewport }).promise;
      if (pdf !== this.pdf) return;
      slot.style.minHeight = '';
      slot.appendChild(canvas);
      slot.dataset['rendered'] = '';
      this.drawBoxes(slot, number);
      const text = await page.getTextContent();
      const words = text.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim();
      if (words) {
        const reader = document.createElement('div');
        reader.className = 'mt-sr';
        reader.textContent = words;
        slot.appendChild(reader);
      }
    } catch {
      this.rendered.delete(number);
    }
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
    void this.task?.destroy();
    this.task = null;
    this.pdf = null;
  }
}
