import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import { MessageRenditionSchema, type DocumentVersion, type MessageRendition } from '@materia/domain';
import { MtButton, MtEmptyState, MtNote } from '@materia/ui';

import { DocumentActions, downloadErrorCopy, errorReason } from './document-actions';
import { previewKind } from './documents-view';
import { MessagePreview } from './message-preview';
import { PDF_PROBLEM_COPY, PdfViewer, type PdfStoredText } from './pdf-viewer';

/** The most plain text shown inline (the whole file is always downloadable). */
export const TEXT_PREVIEW_MAX = 200_000;

export const PREVIEW_UNAVAILABLE = 'Preview not available yet; download instead.';

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'pdf'; url: string; original: boolean }
  | { kind: 'image'; url: string }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'message'; message: MessageRendition }
  | { kind: 'unavailable'; text: string }
  | { kind: 'error'; text: string };

/**
 * A stored version's preview (CORE-12): PDFs in the sandboxed viewer, images inline, plain text,
 * emails as their message rendition, Office files as their PDF rendition and HEIC photos as their
 * JPEG rendition (CORE-12a, ADR-032); until a rendition exists they say "download instead". Every byte comes through
 * `documents-getDownloadUrl` (a 5-minute signed URL), never a download token.
 */
@Component({
  selector: 'mt-document-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MessagePreview, MtButton, MtEmptyState, MtNote, PdfViewer],
  host: { class: 'mt-document-preview' },
  template: `
    @switch (state().kind) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading the preview…</p>
      }
      @case ('pdf') {
        <mt-pdf-viewer
          [url]="url()"
          [label]="name()"
          [page]="page()"
          [storedText]="storedText()"
          (pageChange)="pageChange.emit($event)"
        />
      }
      @case ('image') {
        @if (imageFailed()) {
          <mt-note tone="warning"
            >This image couldn’t be shown. It may be damaged. Download it to try another app.</mt-note
          >
        } @else {
          <img [src]="url()" [alt]="name()" (error)="imageFailed.set(true)" />
        }
      }
      @case ('text') {
        <pre class="text" tabindex="0" [attr.aria-label]="name()">{{ text() }}</pre>
        @if (truncated()) {
          <mt-note>Only the start of this file is shown. Download it to read the rest.</mt-note>
        }
      }
      @case ('message') {
        @if (message(); as m) {
          <mt-message-preview
            [message]="m"
            [canSave]="canSave()"
            [busy]="actions.busy()"
            (save)="saveAttachment($event)"
          />
        }
      }
      @case ('unavailable') {
        <mt-empty-state icon="document" title="No preview" [description]="note()" [headingLevel]="3">
          <button mtButton size="sm" iconStart="arrow-down" (click)="actions.download(docId(), version().version)">
            Download
          </button>
        </mt-empty-state>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ note() }}
          <button mtButton size="sm" (click)="reload()">Try again</button>
        </mt-note>
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-width: 0;
      min-height: 0;
    }
    img {
      max-width: 100%;
      height: auto;
      align-self: flex-start;
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
    }
    .text {
      margin: 0;
      padding: var(--space-12);
      max-height: 70vh;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 400 13px/20px var(--font-mono);
      background: var(--bg-sunken);
      border-radius: var(--radius-md);
    }
  `,
})
export class DocumentPreview {
  protected readonly actions = inject(DocumentActions);

  readonly docId = input.required<string>();
  /** The document's display name (accessible labels). */
  readonly name = input.required<string>();
  /** The stored, scanned version to preview. */
  readonly version = input.required<DocumentVersion>();
  /** The page to show in a PDF (`?page=N`). */
  readonly page = input<number | null>(null);
  readonly canSave = input(false);
  readonly pageChange = output<number>();

  protected readonly state = signal<PreviewState>({ kind: 'loading' });
  protected readonly imageFailed = signal(false);
  private readonly attempt = signal(0);
  private loadId = 0;

  protected readonly url = computed(() => {
    const state = this.state();
    return state.kind === 'pdf' || state.kind === 'image' ? state.url : '';
  });
  /**
   * A PDF's scanned pages read out what OCR found (SEC-06b). Only an original PDF: its pages are the
   * ones ingestion read, which an Office file's PDF rendition's needn't be.
   */
  protected readonly storedText = computed<PdfStoredText | null>(() => {
    const state = this.state();
    if (state.kind !== 'pdf' || !state.original) return null;
    const docId = this.docId();
    const version = this.version().version;
    return (pages) => this.actions.pageText(docId, version, pages);
  });
  protected readonly text = computed(() => {
    const state = this.state();
    return state.kind === 'text' ? state.text : '';
  });
  protected readonly truncated = computed(() => {
    const state = this.state();
    return state.kind === 'text' && state.truncated;
  });
  protected readonly message = computed(() => {
    const state = this.state();
    return state.kind === 'message' ? state.message : null;
  });
  protected readonly note = computed(() => {
    const state = this.state();
    return state.kind === 'unavailable' || state.kind === 'error' ? state.text : '';
  });

  constructor() {
    effect(() => {
      const docId = this.docId();
      const version = this.version();
      this.attempt();
      untracked(() => void this.load(docId, version));
    });
  }

  protected reload(): void {
    this.attempt.update((n) => n + 1);
  }

  protected async saveAttachment(index: number): Promise<void> {
    await this.actions.saveAttachment(this.docId(), this.version().version, index);
  }

  private async load(docId: string, version: DocumentVersion): Promise<void> {
    const id = ++this.loadId;
    const set = (state: PreviewState) => {
      if (id === this.loadId) this.state.set(state);
    };
    set({ kind: 'loading' });
    this.imageFailed.set(false);
    const kind = previewKind(version.fileName);
    if (kind === 'none')
      return set({ kind: 'unavailable', text: 'Zip files can’t be previewed. Download it instead.' });
    if (kind === 'pdf' && version.encrypted) return set({ kind: 'unavailable', text: PDF_PROBLEM_COPY.encrypted });
    try {
      switch (kind) {
        case 'pdf':
          return set({
            kind: 'pdf',
            url: await this.actions.readUrl(docId, version.version, 'original'),
            original: true,
          });
        case 'image':
          return set({ kind: 'image', url: await this.actions.readUrl(docId, version.version, 'original') });
        case 'office':
          return set({
            kind: 'pdf',
            url: await this.actions.readUrl(docId, version.version, 'previewPdf'),
            original: false,
          });
        case 'heic':
          return set({ kind: 'image', url: await this.actions.readUrl(docId, version.version, 'previewImage') });
        case 'text': {
          const body = await fetchOk(await this.actions.readUrl(docId, version.version, 'original'));
          const text = await body.text();
          return set({
            kind: 'text',
            text: text.slice(0, TEXT_PREVIEW_MAX),
            truncated: text.length > TEXT_PREVIEW_MAX,
          });
        }
        case 'message': {
          const body = await fetchOk(await this.actions.readUrl(docId, version.version, 'message'));
          const parsed = MessageRenditionSchema.safeParse(await body.json());
          if (!parsed.success)
            return set({ kind: 'unavailable', text: 'This email couldn’t be read. Download it instead.' });
          return set({ kind: 'message', message: parsed.data });
        }
      }
    } catch (error) {
      if (errorReason(error) === 'rendition_unavailable')
        return set({ kind: 'unavailable', text: PREVIEW_UNAVAILABLE });
      set({ kind: 'error', text: downloadErrorCopy(error) });
    }
  }
}

/** `fetch` that treats an HTTP error as a failure. */
async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}
