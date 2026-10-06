import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { documentCallables, matterDocumentRepository } from '@materia/data-access/repository';
import { documentDisplayName, DomainError, findVersion } from '@materia/domain';
import { MtButton, MtIcon, MtIconButton, MtKbd, MtNote, ToastService } from '@materia/ui';

import {
  citationText,
  highlightPages,
  sourceView,
  type CitedDoc,
  type HighlightedPage,
  type ViewerCitation,
} from './citation-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { downloadErrorCopy } from '../documents/document-actions';
import { PdfViewer, type PdfHighlight, type PdfHighlightResult } from '../documents/pdf-viewer';

type Body =
  | { kind: 'loading' }
  | { kind: 'pdf'; url: string }
  | { kind: 'text'; pages: HighlightedPage[]; found: boolean }
  | { kind: 'removed' }
  | { kind: 'unavailable'; text: string };

/**
 * The citation viewer (AI-05): a side panel that opens a cited passage. PDFs open in the CORE-12
 * PDF viewer at the cited version and page, with the quote highlighted from PDF.js's text layer
 * (across a page break when it runs on); a scanned page has no text layer, so its OCR text from
 * the chunks shows above it with the highlight. DOCX, email and other sources show their
 * extracted text (from the chunks) with the quote highlighted. A citation of an older version
 * opens that version under "A newer version exists". "Open full document" goes to the document's
 * page; "Copy citation" copies `Document name, p 3`. Esc closes; `[` and `]` step through the
 * message's citations (registered shortcuts, so they win over the sidebar's `[` while open). Focus
 * moves into the panel and back to the chip on close.
 */
@Component({
  selector: 'mt-citation-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, MtButton, MtIcon, MtIconButton, MtKbd, MtNote, PdfViewer],
  host: {
    class: 'mt-citation-viewer',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-labelledby': 'mt-cv-title',
    tabindex: '-1',
    '[attr.data-highlighted]': 'highlighted() ? "" : null',
  },
  template: `
    <header class="head">
      <span class="caption t-3 count">Source{{ total() > 1 ? ' ' + (index() + 1) + ' of ' + total() : '' }}</span>
      <h2 class="title" id="mt-cv-title">{{ name() }}{{ pageLabel() }}</h2>
      <span class="nav">
        @if (total() > 1) {
          <button
            mtIconButton
            icon="chevron-left"
            label="Previous source"
            [disabled]="index() === 0"
            (click)="step(-1)"
          ></button>
          <button
            mtIconButton
            icon="chevron-right"
            label="Next source"
            [disabled]="index() >= total() - 1"
            (click)="step(1)"
          ></button>
        }
        <button mtIconButton icon="x" label="Close source" (click)="close()"></button>
      </span>
    </header>
    @if (newer(); as v) {
      <mt-note tone="warning" class="banner"
        >A newer version exists. This is version {{ v.cited }}, the one Clerk cited; the document is now at version
        {{ v.current }}.</mt-note
      >
    }
    <blockquote class="quote" aria-label="Quoted passage">{{ citation()?.quote }}</blockquote>
    <div class="body">
      @switch (body().kind) {
        @case ('loading') {
          <p class="caption t-3" role="status">Opening the source…</p>
        }
        @case ('pdf') {
          @if (ocr(); as pages) {
            <section class="ocr" aria-label="Text read from the scanned page">
              <p class="caption t-2">
                <mt-icon name="info" [size]="14" />This page is a scan, so the passage is marked in the text read from
                it.
              </p>
              <ng-container *ngTemplateOutlet="text; context: { $implicit: pages }" />
            </section>
          } @else if (missed()) {
            <p class="caption t-2 miss">The passage couldn’t be marked on the page; it is quoted above.</p>
          }
          <mt-pdf-viewer
            [url]="pdfUrl()"
            [label]="name()"
            [page]="citation()?.page ?? null"
            [highlight]="pdfHighlight()"
            (highlighted)="onHighlighted($event)"
          />
        }
        @case ('text') {
          @if (!textFound()) {
            <p class="caption t-2 miss">The passage couldn’t be found in the text; it is quoted above.</p>
          }
          @if (textPages().length) {
            <ng-container *ngTemplateOutlet="text; context: { $implicit: textPages() }" />
          } @else {
            <p class="caption t-2">The text of this version isn’t available. Open the full document to read it.</p>
          }
        }
        @case ('removed') {
          <mt-note>This document was removed after Clerk cited it. The quoted passage is above.</mt-note>
        }
        @case ('unavailable') {
          <mt-note tone="warning">{{ unavailable() }}</mt-note>
        }
      }
    </div>
    <footer class="foot">
      @if (canOpen()) {
        <a
          mtButton
          size="sm"
          variant="secondary"
          iconStart="document"
          [routerLink]="docLink()"
          [queryParams]="docQuery()"
          >Open full document</a
        >
      }
      <button mtButton size="sm" variant="ghost" iconStart="copy" (click)="copy()">Copy citation</button>
      <span class="caption t-3 keys mt-ml" aria-hidden="true"
        ><mt-kbd keys="esc" /> close · <mt-kbd keys="[" /> <mt-kbd keys="]" /> sources</span
      >
    </footer>

    <ng-template #text let-pages>
      @for (page of pages; track page.page) {
        <section class="tp" [attr.data-page]="page.page" [attr.aria-label]="'Page ' + page.page">
          <h3 class="caption t-3">Page {{ page.page }}</h3>
          <p>
            @for (segment of page.segments; track $index) {
              @if (segment.mark) {
                <mark data-highlight>{{ segment.text }}</mark>
              } @else {
                {{ segment.text }}
              }
            }
          </p>
        </section>
      }
    </ng-template>
  `,
  styles: `
    :host {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: var(--layer-overlay);
      width: min(560px, 100vw);
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
      background: var(--bg-raised);
      border-left: 1px solid var(--border-default);
      box-shadow: var(--shadow-dialog);
      overflow-y: auto;
      outline: none;
    }
    .head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: 'count nav' 'title nav';
      align-items: center;
      column-gap: var(--space-8);
    }
    .count {
      grid-area: count;
    }
    .title {
      grid-area: title;
      margin: 0;
      font: 600 15px/20px var(--font-sans);
      overflow-wrap: anywhere;
    }
    .nav {
      grid-area: nav;
      display: inline-flex;
      gap: var(--space-4);
    }
    .quote {
      margin: 0;
      padding: var(--space-8) var(--space-12);
      border-left: 3px solid var(--border-ai);
      background: var(--bg-sunken);
      border-radius: var(--radius-sm);
      font: 400 13px/20px var(--font-sans);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-height: 0;
      flex: 1;
    }
    .ocr,
    .tp {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .ocr {
      padding: var(--space-8) var(--space-12);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
    }
    .ocr .caption {
      display: inline-flex;
      gap: var(--space-4);
      align-items: center;
      margin: 0;
    }
    .tp h3,
    .tp p,
    .miss {
      margin: 0;
    }
    .tp p {
      font: 400 13px/20px var(--font-sans);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    mark {
      background: var(--amber-100);
      color: var(--amber-900);
      border-radius: 2px;
      box-shadow: 0 0 0 2px var(--amber-100);
    }
    .foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
      padding-top: var(--space-8);
      border-top: 1px solid var(--border-subtle);
    }
    .keys {
      display: inline-flex;
      gap: var(--space-4);
      align-items: center;
    }
    @media (max-width: 767px) {
      .keys {
        display: none;
      }
    }
  `,
})
export class CitationViewer {
  /** The matter the citations belong to. */
  readonly matterId = input.required<string>();
  /** The citations to step through (the message's or the suggestion's openable ones). */
  readonly citations = input.required<readonly ViewerCitation[]>();
  readonly index = model(0);
  readonly closed = output();

  private readonly api = documentCallables(inject(CALLABLES));
  private readonly repo = matterDocumentRepository(() => this.matterId());
  private readonly toasts = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Where focus returns on close: the chip that opened the viewer. */
  private readonly opener = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

  protected readonly total = computed(() => this.citations().length);
  protected readonly citation = computed<ViewerCitation | undefined>(() => this.citations()[this.index()]);
  protected readonly doc = signal<CitedDoc | null>(null);
  protected readonly body = signal<Body>({ kind: 'loading' });
  /** OCR text of a scanned page, with the highlight, when the PDF has no text layer there. */
  protected readonly ocr = signal<HighlightedPage[] | null>(null);
  protected readonly missed = signal(false);
  protected readonly highlighted = signal(false);
  private loadId = 0;

  protected readonly name = computed(() => {
    const doc = this.doc();
    return doc ? documentDisplayName(doc) : 'Source';
  });
  protected readonly pageLabel = computed(() => {
    const page = this.citation()?.page;
    return page ? `, p ${page}` : '';
  });
  /** The cited version, when it is older than the current one. */
  protected readonly newer = computed(() => {
    const doc = this.doc();
    const cited = this.citation()?.version;
    return doc && cited && typeof doc.version === 'number' && doc.version > cited
      ? { cited, current: doc.version }
      : null;
  });
  protected readonly pdfUrl = computed(() => {
    const body = this.body();
    return body.kind === 'pdf' ? body.url : '';
  });
  protected readonly pdfHighlight = computed<PdfHighlight | null>(() => {
    const citation = this.citation();
    return citation?.page ? { page: citation.page, pageEnd: citation.pageEnd, quote: citation.quote } : null;
  });
  protected readonly textPages = computed(() => {
    const body = this.body();
    return body.kind === 'text' ? body.pages : [];
  });
  protected readonly textFound = computed(() => {
    const body = this.body();
    return body.kind !== 'text' || body.found;
  });
  protected readonly unavailable = computed(() => {
    const body = this.body();
    return body.kind === 'unavailable' ? body.text : '';
  });
  protected readonly canOpen = computed(() => {
    const kind = this.body().kind;
    return kind === 'pdf' || kind === 'text';
  });
  protected readonly docLink = computed(() => ['/matters', this.matterId(), 'documents', this.citation()?.documentId]);
  protected readonly docQuery = computed(() => {
    const citation = this.citation();
    return {
      ...(citation?.page ? { page: citation.page } : {}),
      ...(this.newer() && citation?.version ? { v: citation.version } : {}),
    };
  });

  constructor() {
    effect(() => {
      const citation = this.citation();
      const matterId = this.matterId();
      untracked(() => void this.load(matterId, citation));
    });
    afterNextRender(() => this.host.nativeElement.focus(), { injector: this.injector });
    // While open, Esc closes and [ / ] step through the sources (they win over the sidebar's [).
    const shortcuts = inject(ShortcutService);
    const group = 'Citation viewer';
    const release = [
      shortcuts.register({
        combo: 'esc',
        description: 'Close the source',
        group,
        scope: 'component',
        handler: () => this.close(),
      }),
      shortcuts.register({
        combo: '[',
        description: 'Previous source',
        group,
        scope: 'component',
        handler: () => this.step(-1),
      }),
      shortcuts.register({
        combo: ']',
        description: 'Next source',
        group,
        scope: 'component',
        handler: () => this.step(1),
      }),
    ];
    inject(DestroyRef).onDestroy(() => {
      for (const stop of release) stop();
      if (this.opener?.isConnected) this.opener.focus();
    });
  }

  protected step(by: number): void {
    const next = this.index() + by;
    if (next >= 0 && next < this.total()) this.index.set(next);
  }

  protected close(): void {
    this.closed.emit();
  }

  protected onHighlighted(result: PdfHighlightResult): void {
    this.highlighted.set(result.found);
    this.missed.set(!result.found && result.textLayer);
    if (!result.found && !result.textLayer) void this.loadOcr();
  }

  protected async copy(): Promise<void> {
    const citation = this.citation();
    const text = citationText(this.name(), citation?.page, citation?.pageEnd);
    try {
      await navigator.clipboard.writeText(text);
      this.toasts.show({ title: 'Citation copied', description: text, tone: 'success' });
    } catch {
      this.toasts.show({ title: 'Couldn’t copy the citation', description: text, tone: 'danger' });
    }
  }

  private async load(matterId: string, citation: ViewerCitation | undefined): Promise<void> {
    const id = ++this.loadId;
    const set = (body: Body) => {
      if (id === this.loadId) this.body.set(body);
    };
    this.ocr.set(null);
    this.missed.set(false);
    this.highlighted.set(false);
    set({ kind: 'loading' });
    if (!citation) return;
    try {
      const doc = await this.repo.get(citation.documentId);
      if (id !== this.loadId) return;
      this.doc.set(doc);
      if (!doc) return set({ kind: 'removed' });
      if (doc.deletedAt) return set({ kind: 'removed' });
      const version = findVersion(doc, citation.version) ? citation.version : undefined;
      if (sourceView(doc, version) === 'pdf') {
        const { url } = await this.api.getDownloadUrl({
          matterId,
          docId: citation.documentId,
          ...(version ? { version } : {}),
        });
        return set({ kind: 'pdf', url });
      }
      const { pages } = await this.api.citationText({
        matterId,
        docId: citation.documentId,
        ...(version ? { version } : {}),
        ...(citation.page ? { pages: this.pagesAround(citation) } : {}),
      });
      const highlighted = highlightPages(pages, citation.quote);
      set({ kind: 'text', ...highlighted });
      this.reveal();
    } catch (error) {
      if (error instanceof DomainError && (error.code === 'ACCESS_REVOKED' || error.code === 'NOT_FOUND'))
        return set({ kind: 'unavailable', text: downloadErrorCopy(error) });
      set({ kind: 'unavailable', text: errorCopy(error) });
    }
  }

  /** The cited page, the pages it runs to and the next one (a quote may run over the break). */
  private pagesAround(citation: ViewerCitation): number[] {
    const first = citation.page ?? 1;
    const last = Math.min(first + 9, Math.max(first, citation.pageEnd ?? first) + 1);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }

  /** The OCR text of the cited page(s) of a scanned PDF, with the passage marked. */
  private async loadOcr(): Promise<void> {
    const id = this.loadId;
    const citation = this.citation();
    if (!citation?.page) return;
    try {
      const { pages } = await this.api.citationText({
        matterId: this.matterId(),
        docId: citation.documentId,
        ...(citation.version ? { version: citation.version } : {}),
        pages: this.pagesAround(citation),
      });
      if (id !== this.loadId || !pages.length) return;
      const highlighted = highlightPages(pages, citation.quote);
      this.ocr.set(highlighted.pages);
      this.highlighted.set(highlighted.found);
      this.missed.set(!highlighted.found);
      this.reveal();
    } catch {
      if (id === this.loadId) this.missed.set(true);
    }
  }

  /** Scrolls the first highlight into view once it renders. */
  private reveal(): void {
    afterNextRender(
      () => {
        const mark = this.host.nativeElement.querySelector<HTMLElement>('mark[data-highlight]');
        if (mark) {
          this.highlighted.set(true);
          mark.scrollIntoView?.({ block: 'center' });
        }
      },
      { injector: this.injector },
    );
  }
}
