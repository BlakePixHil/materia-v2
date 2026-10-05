import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MtBadge, MtButton, MtIcon, MtIconButton } from '@materia/ui';

import { DocumentUploads, uploadView, type UploadItem, type UploadView } from './document-uploads';
import { fileTypeIcon, fileTypeOf, formatBytes, type DocumentRow } from './documents-view';

interface Row {
  item: UploadItem;
  view: UploadView;
}

/**
 * The uploads started here for one matter (CORE-12): each file's progress, then the server's
 * verdict (Scanning…, Scanning delayed, Quarantined, Rejected with the reason, Duplicate of …),
 * with Cancel, Retry and, for a duplicate, Keep both or Discard. A polite live region, so a
 * screen reader hears each file finish.
 */
@Component({
  selector: 'mt-upload-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtBadge, MtButton, MtIcon, MtIconButton],
  host: { class: 'mt-upload-list', role: 'region', 'aria-label': 'Uploads', '[hidden]': '!rows().length' },
  template: `
    <div class="head">
      <h3 class="label">Uploads</h3>
      <span class="caption t-3" aria-live="polite">{{ summary() }}</span>
      @if (finishedKeys().length) {
        <button mtButton variant="ghost" size="sm" class="mt-ml" (click)="uploads.clear(finishedKeys())">
          Clear finished
        </button>
      }
    </div>
    <ul>
      @for (row of rows(); track row.item.key) {
        <li [attr.data-phase]="row.item.phase">
          <mt-icon [name]="icon(row.item.fileName)" />
          <div class="body">
            <div class="name">
              @if (row.view.docId && row.view.finished && row.view.tone === 'success') {
                <a [routerLink]="[base(), row.view.docId]">{{ row.item.fileName }}</a>
              } @else {
                <span class="mt-ell">{{ row.item.fileName }}</span>
              }
              <span class="caption t-3">{{ size(row.item.size) }}</span>
            </div>
            @if (row.view.percent !== null) {
              <progress max="100" [value]="row.view.percent" [attr.aria-label]="'Uploading ' + row.item.fileName">
                {{ row.view.percent }}%
              </progress>
            }
            <mt-badge class="status" [tone]="row.view.tone">{{ row.view.text }}</mt-badge>
            @if (row.view.duplicate && row.view.docId && canResolve()) {
              <div class="decide" role="group" [attr.aria-label]="'Duplicate: ' + row.item.fileName">
                <button mtButton size="sm" (click)="keep.emit(row.view.docId)">Keep both</button>
                <button mtButton size="sm" variant="ghost" (click)="discard.emit(row.view.docId)">Discard</button>
              </div>
            }
          </div>
          <span class="actions">
            @if (row.view.canCancel) {
              <button
                mtButton
                variant="ghost"
                size="sm"
                [attr.aria-label]="'Cancel ' + row.item.fileName"
                (click)="uploads.cancel(row.item.key)"
              >
                Cancel
              </button>
            }
            @if (row.view.canRetry) {
              <button
                mtButton
                variant="ghost"
                size="sm"
                [attr.aria-label]="'Retry ' + row.item.fileName"
                (click)="uploads.retry(row.item.key)"
              >
                Retry
              </button>
            }
            @if (!row.view.canCancel) {
              <button
                mtIconButton
                icon="x"
                size="sm"
                [label]="'Dismiss ' + row.item.fileName"
                (click)="uploads.dismiss(row.item.key)"
              ></button>
            }
          </span>
        </li>
      }
    </ul>
  `,
  styles: `
    :host([hidden]) {
      display: none;
    }
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding: var(--space-12);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    h3 {
      margin: 0;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      max-height: 320px;
      overflow-y: auto;
    }
    li {
      display: flex;
      align-items: flex-start;
      gap: var(--space-8);
    }
    li > mt-icon {
      flex: none;
      margin-top: 2px;
      color: var(--icon-default);
    }
    .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-4);
    }
    .name {
      display: flex;
      gap: var(--space-8);
      align-items: baseline;
      max-width: 100%;
      font: 500 13px/18px var(--font-sans);
    }
    .status {
      height: auto;
      min-height: 20px;
      white-space: normal;
    }
    progress {
      width: 100%;
      height: 4px;
      appearance: none;
      border: 0;
      border-radius: 2px;
      overflow: hidden;
      background: var(--bg-sunken);
      color: var(--bg-brand, var(--border-focus));
    }
    progress::-webkit-progress-bar {
      background: var(--bg-sunken);
    }
    progress::-webkit-progress-value {
      background: var(--border-focus);
    }
    progress::-moz-progress-bar {
      background: var(--border-focus);
    }
    .decide,
    .actions {
      display: flex;
      gap: var(--space-4);
      flex: none;
    }
  `,
})
export class UploadList {
  protected readonly uploads = inject(DocumentUploads);

  readonly matterId = input.required<string>();
  /** The matter's documents by id (an upload's status comes from the document it became). */
  readonly docs = input.required<ReadonlyMap<string, DocumentRow>>();
  /** Only uploads of new versions of this document (the viewer); every upload when absent. */
  readonly documentId = input<string>();
  /** May keep or discard a duplicate (document.upload). */
  readonly canResolve = input(false);

  readonly keep = output<string>();
  readonly discard = output<string>();

  protected readonly base = computed(() => `/matters/${this.matterId()}/documents`);
  protected readonly rows = computed<Row[]>(() => {
    const only = this.documentId();
    return this.uploads
      .forMatter(this.matterId())
      .filter((item) => !only || item.documentId === only)
      .map((item) => ({ item, view: uploadView(item, this.docs()) }));
  });
  protected readonly finishedKeys = computed(() =>
    this.rows()
      .filter((row) => row.view.finished)
      .map((row) => row.item.key),
  );
  protected readonly summary = computed(() => {
    const rows = this.rows();
    const done = rows.filter((row) => row.view.finished).length;
    return `${done} of ${rows.length} finished`;
  });

  protected icon(fileName: string) {
    return fileTypeIcon(fileTypeOf(fileName) ?? 'text');
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }
}
