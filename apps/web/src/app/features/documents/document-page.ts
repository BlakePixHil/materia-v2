import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { can } from '@materia/data-access';
import { documentDisplayName, findVersion } from '@materia/domain';
import { MtBadge, MtButton, MtEmptyState, MtIcon, MtNote } from '@materia/ui';

import { DocumentActions } from './document-actions';
import { DocumentDetails } from './document-details';
import { DocumentPreview } from './document-preview';
import {
  DOCUMENT_CATEGORY_LABELS,
  documentStatus,
  duplicateText,
  isReadable,
  type DocumentRow,
} from './documents-view';
import { UploadList } from './upload-list';
import { recentRecorder } from '../../core/commands/recents';
import { errorCopy } from '../../core/error-copy';
import { MatterScreen } from '../matter-detail/matter-screen';

/** A positive whole number from a query parameter, or null. */
export function positiveInt(value: string | null): number | null {
  if (!value || !/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

/**
 * A document (`/matters/:id/documents/:docId`, CORE-12): its preview beside its details. `?page=N`
 * opens a PDF at a page (citations link here) and follows the page in view; `?v=N` previews an
 * earlier version. A removed document shows as "Removed document" and can be restored by
 * document.delete roles; one the role can't see (privileged, for read-only users and paralegals)
 * is "not available", without saying more.
 */
@Component({
  selector: 'mt-document-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [DocumentActions],
  imports: [RouterLink, DocumentDetails, DocumentPreview, MtBadge, MtButton, MtEmptyState, MtIcon, MtNote, UploadList],
  host: { class: 'mt-document-page' },
  template: `
    <a class="back caption" routerLink=".."><mt-icon name="chevron-left" />All documents</a>
    @if (unavailable()) {
      <mt-empty-state
        icon="shield"
        title="Document not available"
        description="It may have been deleted, or your role can’t open it. Ask the responsible lawyer if you need it."
        [headingLevel]="2"
      />
    } @else if (doc(); as d) {
      <div class="head">
        <h2 class="title-m">{{ title() }}</h2>
        <span class="badges">
          <mt-badge>{{ categoryLabels[d.category] }}</mt-badge>
          @if (d.privileged) {
            <mt-badge tone="brand">Privileged</mt-badge>
          }
          @if (status().kind !== 'ready') {
            <mt-badge [tone]="status().tone">{{ status().label }}</mt-badge>
          }
        </span>
        @if (readable()) {
          <button
            mtButton
            size="sm"
            iconStart="arrow-down"
            class="mt-ml"
            (click)="actions.download(d.id, previewVersion()?.version)"
          >
            Download
          </button>
        }
      </div>
      @if (d.deletedAt) {
        <mt-note
          >This document was removed{{ d.name ? ' (' + d.name + ')' : '' }}. Anything that cites it shows “Removed
          document”.</mt-note
        >
      } @else if (status().detail; as detail) {
        <mt-note [tone]="status().tone === 'danger' ? 'danger' : 'warning'">{{ detail }}</mt-note>
      }
      @if (status().kind === 'duplicate') {
        <mt-note tone="warning">
          {{ duplicateOf() }}.
          @if (canEdit()) {
            <button mtButton size="sm" [disabled]="actions.busy()" (click)="actions.resolveDuplicate(d.id, 'keep')">
              Keep both
            </button>
            <button
              mtButton
              size="sm"
              variant="ghost"
              [disabled]="actions.busy()"
              (click)="actions.resolveDuplicate(d.id, 'discard')"
            >
              Discard
            </button>
          }
        </mt-note>
      }
      <div class="layout">
        <section class="preview" aria-label="Preview">
          @if (readable() && previewVersion(); as v) {
            @if (v.version !== d.version) {
              <mt-note>
                You’re looking at version {{ v.version }}.
                <a [routerLink]="[]" [queryParams]="{ v: null, page: null }" queryParamsHandling="merge"
                  >Show the current version</a
                >
              </mt-note>
            }
            <mt-document-preview
              [docId]="d.id"
              [name]="title()"
              [version]="v"
              [page]="page()"
              [canSave]="canEdit()"
              (pageChange)="followPage($event)"
            />
          } @else if (!d.deletedAt) {
            <mt-empty-state icon="shield" title="Not ready to open" [description]="notReady()" [headingLevel]="3" />
          }
        </section>
        <aside class="side" aria-label="Details">
          <mt-upload-list [matterId]="matterId()" [docs]="docs()" [documentId]="d.id" [canResolve]="canEdit()" />
          <mt-document-details
            [doc]="d"
            [canEdit]="canEdit()"
            [canDelete]="canDelete()"
            [canPrivileged]="canPrivileged()"
          />
        </aside>
      </div>
    } @else if (resource.status() === 'error') {
      <mt-note tone="danger">{{ loadError() }}</mt-note>
    } @else {
      <p class="caption t-3" role="status">Loading the document…</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      min-width: 0;
    }
    .back {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
      align-self: flex-start;
      color: var(--text-secondary);
    }
    .head,
    .badges {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
    }
    h2 {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: var(--space-20);
      align-items: start;
    }
    .preview {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .side {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      min-width: 0;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class DocumentPage {
  protected readonly screen = inject(MatterScreen);
  protected readonly actions = inject(DocumentActions);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly docId = toSignal(this.route.paramMap.pipe(map((params) => params.get('docId'))), {
    initialValue: null,
  });
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  protected readonly page = computed(() => positiveInt(this.query().get('page')));
  private readonly wantedVersion = computed(() => positiveInt(this.query().get('v')));

  protected readonly resource = this.actions.repo.watch(() => this.docId());
  protected readonly doc = computed(() => this.resource.value() as DocumentRow | null);
  protected readonly docs = computed(() => {
    const doc = this.doc();
    return new Map(doc ? [[doc.id, doc] as const] : []);
  });
  protected readonly matterId = computed(() => this.screen.id() ?? '');

  private readonly uploadAllowed = can('document.upload');
  private readonly deleteAllowed = can('document.delete');
  protected readonly canPrivileged = can('privileged.view');
  protected readonly canEdit = computed(() => this.uploadAllowed() && !this.screen.readOnly());
  protected readonly canDelete = computed(() => this.deleteAllowed() && !this.screen.readOnly());

  protected readonly categoryLabels = DOCUMENT_CATEGORY_LABELS;
  protected readonly unavailable = computed(() => {
    const error = this.resource.error();
    if (error)
      return error.code === 'NOT_FOUND' || error.code === 'PERMISSION_DENIED' || error.code === 'ACCESS_REVOKED';
    return this.resource.status() === 'ready' && !this.resource.exists();
  });
  protected readonly loadError = computed(() => errorCopy(this.resource.error()));
  protected readonly title = computed(() => {
    const doc = this.doc();
    return doc ? documentDisplayName(doc) : '';
  });
  protected readonly status = computed(() => {
    const doc = this.doc();
    return doc ? documentStatus(doc) : documentStatus({ scan: { status: 'pending' }, version: 0 });
  });
  protected readonly readable = computed(() => {
    const doc = this.doc();
    return !!doc && isReadable(doc);
  });
  protected readonly previewVersion = computed(() => {
    const doc = this.doc();
    if (!doc) return undefined;
    return findVersion(doc, this.wantedVersion() ?? undefined) ?? findVersion(doc);
  });
  private readonly original = this.actions.repo.watch(() => this.doc()?.duplicateOf ?? null);
  protected readonly duplicateOf = computed(() => {
    const original = this.original.value() as DocumentRow | null;
    if (original) return duplicateText(original);
    return this.original.status() === 'ready' ? duplicateText(undefined) : 'Duplicate of another document';
  });
  protected readonly notReady = computed(
    () => this.status().detail ?? 'The file is still being checked. It opens here once the malware check is done.',
  );

  constructor() {
    // ⌘K's Recent (CORE-15): each document opened is recorded once.
    const record = recentRecorder();
    effect(() => {
      const doc = this.doc();
      const matterId = this.matterId();
      if (!doc || doc.deletedAt || !matterId) return;
      untracked(() => record({ kind: 'document', matterId, entityId: doc.id }));
    });
  }

  /** Keeps `?page=` in step with the page in view, so the address is a citation of it. */
  protected followPage(page: number): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
