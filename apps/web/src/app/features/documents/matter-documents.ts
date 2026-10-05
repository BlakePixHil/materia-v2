import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { can, type JobView } from '@materia/data-access';
import { matterDocumentsQuery } from '@materia/data-access/repository';
import { documentDisplayName } from '@materia/domain';
import {
  formatDateOnly,
  MT_MENU,
  MtBadge,
  MtButton,
  MtEmptyState,
  MtIcon,
  MtNote,
  MtSegmentedControl,
  MtTable,
  MtTableCell,
  ToastService,
  type MtOption,
  type MtSort,
  type MtTableColumn,
} from '@materia/ui';

import { DocumentActions } from './document-actions';
import { DocumentUploads } from './document-uploads';
import { DocumentsBulkBar } from './documents-bulk-bar';
import {
  DEFAULT_SORT,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  documentCount,
  documentFileType,
  documentStatus,
  duplicateText,
  FILE_TYPE_LABELS,
  FILE_TYPES,
  fileTypeIcon,
  formatBytes,
  hasFilters,
  matchesFilters,
  NO_FILTERS,
  rowName,
  SORT_LABELS,
  sortDocuments,
  UPLOAD_ACCEPT,
  type DocumentCategory,
  type DocumentFilters,
  type DocumentRow,
  type DocumentSort,
  type DocumentSortKey,
  type FileType,
} from './documents-view';
import { UploadList } from './upload-list';
import { onIntent } from '../../core/commands/intents';
import { errorCopy } from '../../core/error-copy';
import { JobProgress } from '../../core/jobs/job-progress';
import { MOBILE_QUERY } from '../../shell/app-shell';
import { MatterScreen } from '../matter-detail/matter-screen';

type Layout = 'table' | 'grid';
const LAYOUT_KEY = 'materia.documents.layout';

function storedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'table';
  } catch {
    return 'table';
  }
}

/**
 * A matter's Documents tab (CORE-12): its documents as a table or a grid, filtered by category,
 * type and privilege, sorted, selected in bulk (download as a zip, move to a category, remove,
 * restore), and added by
 * the Upload button or by dropping files anywhere on the tab. Uploads show their progress and then
 * the server's verdict; a possible duplicate asks to keep both or discard. Privileged documents are
 * never listed for roles without privileged.view (the query proves `privileged == false`). Listens
 * to the matter's documents only while this tab is shown.
 */
@Component({
  selector: 'mt-matter-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [DocumentActions],
  styleUrls: ['../../../../../../libs/ui/src/generated/components/chip.css', './matter-documents.css'],
  imports: [
    FormsModule,
    RouterLink,
    MT_MENU,
    MtBadge,
    MtButton,
    MtEmptyState,
    MtIcon,
    MtNote,
    MtSegmentedControl,
    MtTable,
    MtTableCell,
    DocumentsBulkBar,
    JobProgress,
    UploadList,
  ],
  host: {
    class: 'mt-matter-documents',
    '(dragenter)': 'onDragEnter($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
    '(keydown.escape)': 'selection.set([])',
  },
  template: `
    <div class="head">
      <h2 class="title-m">Documents</h2>
      <span class="caption t-3">{{ countText() }}</span>
      <span class="mt-ml tools">
        <mt-segmented-control
          label="Show documents as"
          [options]="layoutOptions"
          [ngModel]="layout()"
          (ngModelChange)="setLayout($event)"
        />
        @if (canUpload()) {
          <input
            #picker
            type="file"
            hidden
            multiple
            data-testid="document-upload-input"
            [accept]="accept"
            (change)="picked($event)"
          />
          <button mtButton variant="primary" size="sm" iconStart="upload" (click)="picker.click()">Upload</button>
        }
      </span>
    </div>

    <div class="filters" role="group" aria-label="Filters and sort">
      <button
        type="button"
        class="mt-chip"
        [attr.data-selected]="on(f().categories.length)"
        [mtMenuTrigger]="categoryMenu"
      >
        {{ categoryText() }}<mt-icon name="chevron-down" />
      </button>
      <button type="button" class="mt-chip" [attr.data-selected]="on(f().types.length)" [mtMenuTrigger]="typeMenu">
        {{ typeText() }}<mt-icon name="chevron-down" />
      </button>
      @if (canPrivileged()) {
        <button
          type="button"
          class="mt-chip"
          [attr.data-selected]="on(f().privileged !== 'any')"
          [mtMenuTrigger]="privMenu"
        >
          <mt-icon name="shield" />{{ privilegedText() }}<mt-icon name="chevron-down" />
        </button>
      }
      @if (canDelete()) {
        <button
          type="button"
          class="mt-chip"
          [attr.data-selected]="on(f().removed)"
          [attr.aria-pressed]="f().removed"
          (click)="setFilters({ removed: !f().removed })"
        >
          <mt-icon name="trash" />Show removed
        </button>
      }
      <button type="button" class="mt-chip" [mtMenuTrigger]="sortMenu">
        Sort: {{ sortLabels[sort().key]
        }}<mt-icon [name]="sort().direction === 'asc' ? 'arrow-up-right' : 'arrow-down'" />
      </button>
      @if (filtered()) {
        <button mtButton variant="ghost" size="sm" (click)="filters.set(noFilters)">Clear filters</button>
      }
    </div>

    @if (zipJob(); as jobId) {
      <mt-job-progress [jobId]="jobId" label="Documents zip" (finished)="zipFinished(jobId, $event)" />
    }

    @if (uploadCount()) {
      <mt-upload-list
        [matterId]="matterId()"
        [docs]="byId()"
        [canResolve]="canUpload()"
        (keep)="actions.resolveDuplicate($event, 'keep')"
        (discard)="actions.resolveDuplicate($event, 'discard')"
      />
    }

    @for (doc of duplicates(); track doc.id) {
      <mt-note tone="warning" class="duplicate">
        <span
          ><a [routerLink]="doc.id">{{ name(doc) }}</a> looks like a copy: {{ duplicateOf(doc) }}.</span
        >
        @if (canUpload()) {
          <span class="decide">
            <button mtButton size="sm" [disabled]="actions.busy()" (click)="actions.resolveDuplicate(doc.id, 'keep')">
              Keep both
            </button>
            <button
              mtButton
              size="sm"
              variant="ghost"
              [disabled]="actions.busy()"
              (click)="actions.resolveDuplicate(doc.id, 'discard')"
            >
              Discard
            </button>
          </span>
        }
      </mt-note>
    }

    @switch (docs.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading documents…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="docs.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        @if (!rows().length) {
          @if (filtered()) {
            <mt-empty-state
              icon="search"
              title="No documents match"
              description="Nothing matches these filters. Clear them to see every document."
              [headingLevel]="3"
            >
              <button mtButton size="sm" (click)="filters.set(noFilters)">Clear filters</button>
            </mt-empty-state>
          } @else {
            <mt-empty-state
              icon="document"
              title="No documents yet"
              [description]="
                canUpload()
                  ? 'Upload wills, certificates, statements and letters, or drop files here. Up to 20 at a time, 50 MB each.'
                  : 'Documents on this matter show here.'
              "
              [headingLevel]="3"
            >
              @if (canUpload()) {
                <button mtButton variant="primary" size="sm" iconStart="upload" (click)="openPicker()">Upload</button>
              }
            </mt-empty-state>
          }
        } @else if (layout() === 'table') {
          <mt-table
            label="Documents"
            density="compact"
            sortMode="external"
            maxHeight="none"
            [selectable]="selectable()"
            [rows]="rows()"
            [columns]="shownColumns()"
            [rowKey]="rowKey"
            [rowLabel]="rowLabel"
            [sort]="tableSort()"
            (sortChange)="sortByColumn($event)"
            [(selection)]="selection"
            (open)="open($event)"
          >
            <ng-template mtCell="name" let-cell>
              @let row = asRow(cell);
              <span class="doc-name">
                <mt-icon [name]="icon(row)" />
                <a class="mt-ell" [routerLink]="row.id" (click)="$event.stopPropagation()">{{ name(row) }}</a>
                @if (row.deletedAt) {
                  <span class="caption t-3 mt-ell">{{ row.name }}</span>
                }
                @if (row.privileged) {
                  <mt-icon name="shield" class="priv" aria-label="Privileged" role="img" />
                }
                @if (status(row); as s) {
                  @if (s.kind !== 'ready') {
                    <mt-badge [tone]="s.tone">{{ s.label }}</mt-badge>
                  }
                }
              </span>
            </ng-template>
            <div mtTableEmpty></div>
          </mt-table>
        } @else {
          <ul class="grid" aria-label="Documents">
            @for (doc of rows(); track doc.id) {
              <li class="card" [attr.data-selected]="isSelected(doc.id) ? '' : null">
                @if (selectable()) {
                  <input
                    type="checkbox"
                    [checked]="isSelected(doc.id)"
                    [attr.aria-label]="'Select ' + label(doc)"
                    (change)="toggle(doc.id, $any($event.target).checked)"
                  />
                }
                <mt-icon [name]="icon(doc)" class="big" />
                <a class="mt-ell" [routerLink]="doc.id">{{ name(doc) }}</a>
                @if (doc.deletedAt) {
                  <span class="caption t-3 mt-ell">{{ doc.name }}</span>
                }
                <span class="caption t-3">{{ categoryLabels[doc.category] }} · {{ added(doc) }}</span>
                <span class="tags">
                  @if (doc.privileged) {
                    <mt-badge tone="brand">Privileged</mt-badge>
                  }
                  @if (status(doc); as s) {
                    @if (s.kind !== 'ready') {
                      <mt-badge [tone]="s.tone">{{ s.label }}</mt-badge>
                    }
                  }
                </span>
              </li>
            }
          </ul>
        }
        @if (docs.hasMore()) {
          <button mtButton size="sm" class="more" [loading]="docs.loadingMore()" (click)="docs.loadMore()">
            Show more documents
          </button>
        }
      }
    }

    @if (dragging()) {
      <div class="drop" aria-hidden="true">
        <mt-icon name="upload" />
        <span class="title-m">Drop files to add them to this matter</span>
        <span class="caption">Up to 20 at a time, 50 MB each</span>
      </div>
    }

    @if (selectedRows().length) {
      <mt-documents-bulk-bar
        [count]="selectedRows().length"
        [canDownload]="canDownload()"
        [canMove]="canUpload()"
        [canDelete]="canDelete()"
        [liveSelected]="liveSelected().length > 0"
        [removedSelected]="removedSelected().length > 0"
        [busy]="actions.busy()"
        [zipping]="zipping()"
        (download)="downloadSelected()"
        (move)="move($event)"
        (remove)="removeSelected()"
        (restore)="restoreSelected()"
        (clear)="selection.set([])"
      />
    }

    <ng-template #categoryMenu>
      <mt-menu aria-label="Category">
        @for (category of categories; track category) {
          <button
            mtMenuItemCheckbox
            [checked]="f().categories.includes(category)"
            (checkedChange)="toggleCategory(category, $event)"
          >
            {{ categoryLabels[category] }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #typeMenu>
      <mt-menu aria-label="Type">
        @for (type of types; track type) {
          <button mtMenuItemCheckbox [checked]="f().types.includes(type)" (checkedChange)="toggleType(type, $event)">
            {{ typeLabels[type] }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #privMenu>
      <mt-menu aria-label="Privileged">
        <button
          mtMenuItem
          [icon]="f().privileged === 'any' ? 'check' : undefined"
          (click)="setFilters({ privileged: 'any' })"
        >
          Privileged or not
        </button>
        <button
          mtMenuItem
          [icon]="f().privileged === 'yes' ? 'check' : undefined"
          (click)="setFilters({ privileged: 'yes' })"
        >
          Privileged only
        </button>
        <button
          mtMenuItem
          [icon]="f().privileged === 'no' ? 'check' : undefined"
          (click)="setFilters({ privileged: 'no' })"
        >
          Not privileged
        </button>
      </mt-menu>
    </ng-template>
    <ng-template #sortMenu>
      <mt-menu aria-label="Sort by">
        @for (key of sortKeys; track key) {
          <button mtMenuItem [icon]="sort().key === key ? 'check' : undefined" (click)="sortBy(key)">
            {{ sortLabels[key] }}
          </button>
        }
        <mt-menu-separator />
        <button mtMenuItem [icon]="sort().direction === 'asc' ? 'check' : undefined" (click)="setDirection('asc')">
          Ascending
        </button>
        <button mtMenuItem [icon]="sort().direction === 'desc' ? 'check' : undefined" (click)="setDirection('desc')">
          Descending
        </button>
      </mt-menu>
    </ng-template>
  `,
})
export class MatterDocuments {
  protected readonly screen = inject(MatterScreen);
  protected readonly actions = inject(DocumentActions);
  private readonly uploads = inject(DocumentUploads);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly picker = viewChild<ElementRef<HTMLInputElement>>('picker');

  protected readonly canUpload = computed(() => this.uploadAllowed() && !this.screen.deleted());
  protected readonly canDelete = computed(() => this.deleteAllowed() && !this.screen.deleted());
  /** Every role that sees the matter can download a selection as a zip (CORE-12b). */
  protected readonly canDownload = computed(() => !this.screen.deleted());
  protected readonly canPrivileged = can('privileged.view');
  private readonly uploadAllowed = can('document.upload');
  private readonly deleteAllowed = can('document.delete');
  protected readonly selectable = computed(() => this.canDownload() || this.canUpload() || this.canDelete());

  protected readonly matterId = computed(() => this.screen.id() ?? '');
  /** Every document the role may see, removed ones included (filtered here, so uploads can follow them). */
  protected readonly docs = this.actions.repo.watchQuery(() =>
    this.screen.id()
      ? matterDocumentsQuery({ privilegedVisible: this.canPrivileged(), includeDeleted: true, pageSize: 100 })
      : null,
  );
  protected readonly byId = computed(
    () => new Map(this.docs.value().map((doc) => [doc.id, doc as DocumentRow] as const)),
  );

  protected readonly layout = signal<Layout>(storedLayout());
  protected readonly filters = signal<DocumentFilters>(NO_FILTERS);
  protected readonly f = this.filters.asReadonly();
  protected readonly sort = signal<DocumentSort>(DEFAULT_SORT);
  readonly selection = signal<readonly string[]>([]);
  protected readonly dragging = signal(false);
  private dragDepth = 0;
  /** The zip job being prepared, watched until it finishes. */
  protected readonly zipJob = signal<string | null>(null);
  private readonly startingZip = signal(false);
  protected readonly zipping = computed(() => this.startingZip() || this.zipJob() !== null);

  protected readonly rows = computed(() =>
    sortDocuments(
      (this.docs.value() as DocumentRow[]).filter((doc) => matchesFilters(doc, this.filters())),
      this.sort(),
    ),
  );
  protected readonly filtered = computed(() => hasFilters(this.filters()));
  protected readonly duplicates = computed(() =>
    (this.docs.value() as DocumentRow[]).filter((doc) => !doc.deletedAt && documentStatus(doc).kind === 'duplicate'),
  );
  protected readonly selectedRows = computed(() => {
    const chosen = new Set(this.selection());
    return this.rows().filter((row) => chosen.has(row.id));
  });
  protected readonly liveSelected = computed(() => this.selectedRows().filter((row) => !row.deletedAt));
  protected readonly removedSelected = computed(() => this.selectedRows().filter((row) => !!row.deletedAt));
  protected readonly uploadCount = computed(
    () => this.uploads.items().filter((i) => i.matterId === this.matterId()).length,
  );

  protected readonly countText = computed(() => {
    const live = (this.docs.value() as DocumentRow[]).filter((doc) => !doc.deletedAt).length;
    return documentCount(live) + (this.docs.hasMore() ? '+' : '');
  });
  protected readonly loadError = computed(() => errorCopy(this.docs.error()));
  protected readonly categoryText = computed(() => {
    const chosen = this.filters().categories;
    if (!chosen.length) return 'Category';
    return chosen.length === 1
      ? DOCUMENT_CATEGORY_LABELS[chosen[0] as DocumentCategory]
      : `${chosen.length} categories`;
  });
  protected readonly typeText = computed(() => {
    const chosen = this.filters().types;
    if (!chosen.length) return 'Type';
    return chosen.length === 1 ? FILE_TYPE_LABELS[chosen[0] as FileType] : `${chosen.length} types`;
  });
  protected readonly privilegedText = computed(
    () => ({ any: 'Privileged', yes: 'Privileged only', no: 'Not privileged' })[this.filters().privileged],
  );
  protected readonly tableSort = computed<MtSort>(() => ({
    column: this.sort().key,
    direction: this.sort().direction,
  }));

  protected readonly accept = UPLOAD_ACCEPT;
  protected readonly noFilters = NO_FILTERS;
  protected readonly categories = DOCUMENT_CATEGORIES;
  protected readonly categoryLabels = DOCUMENT_CATEGORY_LABELS;
  protected readonly types = FILE_TYPES;
  protected readonly typeLabels = FILE_TYPE_LABELS;
  protected readonly sortLabels = SORT_LABELS;
  protected readonly sortKeys = Object.keys(SORT_LABELS) as DocumentSortKey[];
  protected readonly layoutOptions: MtOption<Layout>[] = [
    { value: 'table', label: 'Table' },
    { value: 'grid', label: 'Grid' },
  ];
  protected readonly columns: MtTableColumn<DocumentRow>[] = [
    { id: 'name', header: 'Name', sortable: true, cellClass: 'title' },
    { id: 'category', header: 'Category', sortable: true, value: (row) => DOCUMENT_CATEGORY_LABELS[row.category] },
    { id: 'type', header: 'Type', sortable: true, value: (row) => FILE_TYPE_LABELS[documentFileType(row)] },
    {
      id: 'size',
      header: 'Size',
      sortable: true,
      numeric: true,
      value: (row) => formatBytes(row.sizeBytes ?? row.upload?.sizeBytes),
    },
    { id: 'added', header: 'Added', sortable: true, value: (row) => formatDateOnly(row.createdAt ?? null) },
    { id: 'version', header: 'Version', numeric: true, value: (row) => (row.version ? `v${row.version}` : '—') },
  ];
  /** On a phone, the name and date only (the grid shows the rest), so names aren't squeezed away. */
  private readonly narrow = signal(false);
  private static readonly NARROW_COLUMNS = new Set(['name', 'added']);
  protected readonly shownColumns = computed(() =>
    this.narrow() ? this.columns.filter((column) => MatterDocuments.NARROW_COLUMNS.has(column.id)) : this.columns,
  );
  protected readonly rowKey = (row: DocumentRow) => row.id;

  constructor() {
    const media = typeof matchMedia === 'function' ? matchMedia(MOBILE_QUERY) : null;
    if (media) {
      this.narrow.set(media.matches);
      const update = (event: MediaQueryListEvent) => this.narrow.set(event.matches);
      media.addEventListener('change', update);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', update));
    }
    // ⌘K's "Upload document" on this matter (CORE-15): opens the file picker once it's shown.
    onIntent(
      'upload',
      () => this.canUpload() && this.openPicker(),
      () => !!this.picker(),
    );
  }
  protected readonly rowLabel = (row: DocumentRow) => rowName(row);

  protected on(value: unknown): '' | null {
    return value ? '' : null;
  }

  protected asRow(cell: unknown): DocumentRow {
    return cell as DocumentRow;
  }

  protected name(doc: DocumentRow): string {
    return documentDisplayName(doc);
  }

  protected label(doc: DocumentRow): string {
    return rowName(doc);
  }

  protected icon(doc: DocumentRow) {
    return fileTypeIcon(documentFileType(doc));
  }

  protected status(doc: DocumentRow) {
    return documentStatus(doc);
  }

  protected added(doc: DocumentRow): string {
    return formatDateOnly(doc.createdAt ?? null);
  }

  protected duplicateOf(doc: DocumentRow): string {
    return duplicateText(doc.duplicateOf ? this.byId().get(doc.duplicateOf) : undefined).replace(/^D/, 'd');
  }

  protected setLayout(layout: Layout | null): void {
    const next = layout === 'grid' ? 'grid' : 'table';
    this.layout.set(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Private browsing: the choice lasts until the page closes.
    }
  }

  protected setFilters(change: Partial<DocumentFilters>): void {
    this.filters.update((filters) => ({ ...filters, ...change }));
    this.selection.set([]);
  }

  protected toggleCategory(category: DocumentCategory, on: boolean): void {
    const rest = this.filters().categories.filter((c) => c !== category);
    this.setFilters({ categories: on ? [...rest, category] : rest });
  }

  protected toggleType(type: FileType, on: boolean): void {
    const rest = this.filters().types.filter((t) => t !== type);
    this.setFilters({ types: on ? [...rest, type] : rest });
  }

  protected sortBy(key: DocumentSortKey): void {
    this.sort.set({ key, direction: key === 'added' || key === 'size' ? 'desc' : 'asc' });
  }

  protected setDirection(direction: 'asc' | 'desc'): void {
    this.sort.update((sort) => ({ ...sort, direction }));
  }

  protected sortByColumn(sort: MtSort | null): void {
    this.sort.set(
      sort && sort.column in SORT_LABELS
        ? { key: sort.column as DocumentSortKey, direction: sort.direction }
        : DEFAULT_SORT,
    );
  }

  protected isSelected(id: string): boolean {
    return this.selection().includes(id);
  }

  protected toggle(id: string, on: boolean): void {
    this.selection.update((ids) => (on ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id)));
  }

  protected open(doc: DocumentRow): void {
    void this.router.navigate(['/matters', this.matterId(), 'documents', doc.id]);
  }

  protected openPicker(): void {
    this.picker()?.nativeElement.click();
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.add([...(input.files ?? [])]);
    input.value = '';
  }

  /** Starts a zip of the live selected documents; `zipFinished` downloads it. */
  protected async downloadSelected(): Promise<void> {
    if (this.zipping()) return;
    this.startingZip.set(true);
    try {
      const result = await this.actions.startZip(this.liveSelected().map((row) => row.id));
      if (result) this.zipJob.set(result.jobId);
    } finally {
      this.startingZip.set(false);
    }
  }

  /** The zip job finished: download the zip, or leave the failure toast up. */
  protected async zipFinished(jobId: string, job: JobView): Promise<void> {
    this.zipJob.set(null);
    if (job.status === 'succeeded') await this.actions.downloadZip(jobId);
  }

  protected async move(category: DocumentCategory): Promise<void> {
    if (
      await this.actions.moveToCategory(
        this.liveSelected().map((row) => row.id),
        category,
      )
    )
      this.selection.set([]);
  }

  protected async removeSelected(): Promise<void> {
    if (await this.actions.remove(this.liveSelected().map((row) => row.id))) this.selection.set([]);
  }

  protected async restoreSelected(): Promise<void> {
    if (await this.actions.restore(this.removedSelected().map((row) => row.id))) this.selection.set([]);
  }

  // ---------- drag and drop ----------

  private carriesFiles(event: DragEvent): boolean {
    return this.canUpload() && !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  }

  protected onDragEnter(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth++;
    this.dragging.set(true);
  }

  protected onDragOver(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  protected onDragLeave(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (!this.dragDepth) this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.dragging.set(false);
    this.add([...(event.dataTransfer?.files ?? [])]);
  }

  private add(files: File[]): void {
    const matterId = this.matterId();
    if (!files.length || !matterId) return;
    // A privileged matter's uploads are privileged on the server; nothing to say here.
    const { dropped } = this.uploads.add(matterId, files);
    if (dropped) {
      this.toasts.show({
        title: `${dropped === 1 ? '1 file' : `${dropped} files`} not added`,
        description: 'You can add up to 20 files at a time. Add the rest once these are done.',
        tone: 'danger',
      });
    }
  }
}
