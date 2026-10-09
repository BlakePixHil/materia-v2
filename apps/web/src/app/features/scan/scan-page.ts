import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { can, Connectivity, OrgContext } from '@materia/data-access';
import { todayMatterRepository } from '@materia/data-access/repository';
import { DOCUMENT_MAX_BYTES } from '@materia/domain';
import {
  DialogService,
  MT_MENU,
  MtButton,
  MtEmptyState,
  MtIcon,
  MtIconButton,
  MtNote,
  type MtOption,
  MtSegmentedControl,
  MtSelect,
  MtSwitch,
  MtTextField,
  ToastService,
} from '@materia/ui';

import { MEDIA_DEVICES, ScanCamera } from './scan-camera';
import type { ScanCropData } from './scan-crop-dialog';
import { type Quad, rotateQuad } from './scan-image';
import { scanPdf } from './scan-pdf';
import { SCAN_PROCESSOR, ScanError, type ScannedPage } from './scan-processor';
import { ScanQueue } from './scan-queue';
import { pickMatter } from '../../core/timer/timer-dialogs';
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS, type DocumentCategory } from '../documents/documents-view';
import { type HasUnsavedChanges, warnBeforeUnload } from '../settings/unsaved-changes';

/** Pages in one scan: plenty for a will or a grant, and few enough for a phone to hold. */
export const SCAN_MAX_PAGES = 30;
/** The document's file name, `.pdf` included, fits the upload's 255 characters. */
const NAME_MAX = 251;

/** A page of the scan: its photo being made into a page, the page, or why it couldn't be. */
interface ScanItem {
  id: string;
  page?: ScannedPage;
  thumbUrl?: string;
  /** Being made (or made again after turning or re-cropping). */
  busy: boolean;
  error?: string;
}

interface ChosenMatter {
  id: string;
  number: string;
  title: string;
  archived: boolean;
}

type ScanMode = 'colour' | 'grey';

/** "Scan 7 Oct 2026": the name until someone types a better one. */
export function defaultScanName(now: Date): string {
  return `Scan ${new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(now)}`;
}

/** The name as a file name: trimmed, with `.pdf` once. */
export function scanFileName(name: string): string {
  const trimmed = name
    .trim()
    .replace(/\.pdf$/i, '')
    .trim();
  return `${trimmed}.pdf`;
}

let nextItem = 0;

/**
 * Scan a document (`/record/scan`, MOB-05): photograph a paper document page by page, with the
 * in-app camera or the phone's own, or choose photos already taken. Each page is found in its photo,
 * straightened and compressed on the phone, one at a time; the corners can be dragged when the edges
 * weren't found, a page turned, moved or removed, and the whole scan kept in colour or made black
 * and white. Saving makes one PDF, a page per photo in this order, and adds it to the matter's
 * documents as a camera upload (CORE-12, `source: 'camera'`). The PDF waits on the phone
 * (`ScanQueue`) until it's uploaded, so a scan saved without a connection goes when it's back.
 */
@Component({
  selector: 'mt-scan-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    MT_MENU,
    MtButton,
    MtEmptyState,
    MtIcon,
    MtIconButton,
    MtNote,
    MtSegmentedControl,
    MtSelect,
    MtSwitch,
    MtTextField,
    ScanCamera,
  ],
  host: { class: 'mt-scan' },
  template: `
    <h1 class="mt-sr">Scan a document</h1>
    <input #chooser type="file" accept="image/*" multiple hidden data-testid="scan-files" (change)="picked($event)" />
    <input
      #capturer
      type="file"
      accept="image/*"
      capture="environment"
      hidden
      data-testid="scan-capture"
      (change)="picked($event)"
    />

    @if (notice(); as text) {
      <mt-note tone="warning" data-testid="scan-notice">
        {{ text }}
        @if (cameraBlocked()) {
          <span class="mt-row note-actions">
            <button mtButton size="sm" variant="secondary" iconStart="camera" (click)="capturer.click()">
              Use the camera app
            </button>
          </span>
        }
      </mt-note>
    }

    @if (!items().length) {
      <mt-empty-state
        icon="camera"
        title="Photograph each page"
        description="Lay the document flat on a darker surface, in good light. Materia finds the edges of each page and straightens it."
        [headingLevel]="2"
      >
        <button mtButton variant="primary" iconStart="camera" (click)="takePhotos()">Take photos</button>
        <button mtButton variant="secondary" iconStart="images" (click)="chooser.click()">Choose photos</button>
      </mt-empty-state>
    } @else {
      <section class="pages" aria-labelledby="scan-pages">
        <div class="head">
          <h2 class="label" id="scan-pages">Pages</h2>
          <span class="caption t-3 count">{{ countText() }}</span>
          <span class="mt-grow"></span>
          <mt-segmented-control
            label="Colour"
            [options]="modes"
            [ngModel]="mode()"
            (ngModelChange)="mode.set($event ?? 'colour')"
          />
        </div>
        <ol #list class="list" [attr.data-mode]="mode()">
          @for (item of items(); track item.id; let i = $index; let last = $last) {
            <li class="row" data-page-row [attr.data-dragging]="dragging() === item.id ? '' : null">
              <button
                type="button"
                class="grip"
                [attr.data-grip]="item.id"
                [attr.aria-label]="'Move page ' + (i + 1)"
                aria-describedby="scan-grip-help"
                (pointerdown)="grab($event, item.id)"
                (pointermove)="drag($event)"
                (pointerup)="drop($event)"
                (pointercancel)="drop($event)"
                (keydown)="gripKey($event, item.id)"
              >
                <mt-icon name="grip" [size]="20" />
              </button>
              <span class="thumb">
                @if (item.thumbUrl) {
                  <img [src]="item.thumbUrl" alt="" />
                }
                @if (item.busy) {
                  <span class="spin"><mt-icon name="loader" [size]="16" /></span>
                } @else if (item.error) {
                  <span class="bad"><mt-icon name="alert" [size]="16" /></span>
                }
              </span>
              <span class="text">
                <span class="tt">Page {{ i + 1 }}</span>
                <span class="ts" [attr.data-tone]="tone(item)">{{ detail(item) }}</span>
              </span>
              <button
                mtIconButton
                icon="more"
                [label]="'Page ' + (i + 1) + ' actions'"
                [tooltip]="false"
                [mtMenuTrigger]="menu"
              ></button>
              <ng-template #menu>
                <mt-menu [attr.aria-label]="'Page ' + (i + 1)">
                  @if (item.page && !item.busy) {
                    <button mtMenuItem icon="crop" (click)="adjust(item.id)">Adjust corners</button>
                    <button mtMenuItem icon="rotate" (click)="rotate(item.id)">Turn right</button>
                  }
                  @if (i > 0) {
                    <button mtMenuItem icon="arrow-up" (click)="move(item.id, -1)">Move up</button>
                  }
                  @if (!last) {
                    <button mtMenuItem icon="arrow-down" (click)="move(item.id, 1)">Move down</button>
                  }
                  <mt-menu-separator />
                  <button mtMenuItem icon="trash" (click)="remove(item.id)">Remove page</button>
                </mt-menu>
              </ng-template>
            </li>
          }
        </ol>
        <p id="scan-grip-help" class="mt-sr">
          Drag to put the pages in order, or select one and use the up and down arrow keys.
        </p>
        <div class="mt-row add">
          <button mtButton variant="secondary" iconStart="camera" [disabled]="full()" (click)="takePhotos()">
            Take photos
          </button>
          <button mtButton variant="ghost" iconStart="images" [disabled]="full()" (click)="chooser.click()">
            Choose photos
          </button>
        </div>
      </section>

      <form id="scan-form" class="details" aria-labelledby="scan-details" (submit)="$event.preventDefault(); save()">
        <h2 class="label" id="scan-details">Details</h2>
        <div class="matter" role="group" aria-labelledby="scan-matter">
          <span class="label" id="scan-matter">Matter</span>
          <div class="mt-row choice">
            @if (matter(); as chosen) {
              <span class="mt-grow chosen" data-testid="scan-matter">
                <span class="num">{{ chosen.number }}</span>
                @if (chosen.title) {
                  <span class="mt-ell">{{ chosen.title }}</span>
                }
              </span>
              <button mtButton variant="ghost" size="sm" type="button" (click)="chooseMatter()">Change</button>
            } @else if (matterLoading()) {
              <span class="caption t-3 mt-grow" role="status">Loading the matter…</span>
            } @else {
              <button mtButton variant="secondary" size="sm" type="button" (click)="chooseMatter()">
                Choose a matter
              </button>
            }
          </div>
          @if (matter()?.archived) {
            <p class="caption problem" role="alert">
              This matter is archived, so it can’t take new documents. Choose another, or reopen it first.
            </p>
          }
        </div>
        <mt-text-field
          name="name"
          label="Name"
          suffix=".pdf"
          [ngModel]="name()"
          (ngModelChange)="name.set($event ?? '')"
        />
        <mt-select
          name="category"
          label="Category"
          [native]="true"
          [options]="categoryOptions"
          [ngModel]="category()"
          (ngModelChange)="category.set($event ?? 'other')"
        />
        @if (canPrivileged()) {
          <mt-switch
            name="privileged"
            label="Privileged"
            description="Hidden from paralegals and read-only users, and never sent anywhere without someone choosing to."
            [ngModel]="privileged()"
            (ngModelChange)="privileged.set(!!$event)"
          />
        }
      </form>

      <!-- Outside the form, so it stays in reach however long the list of pages is. -->
      <div class="save">
        @if (shownProblem(); as text) {
          <p class="caption problem" role="alert" data-testid="scan-problem">{{ text }}</p>
        }
        <button
          mtButton
          variant="primary"
          type="submit"
          form="scan-form"
          iconStart="upload"
          [loading]="saving()"
          [disabled]="working()"
        >
          {{ saveLabel() }}
        </button>
      </div>
    }

    <p class="mt-sr" role="status">{{ announcement() }}</p>

    @if (camera()) {
      <mt-scan-camera
        [pages]="items().length"
        (captured)="addPhotos([$event])"
        (closed)="camera.set(false)"
        (failed)="cameraFailed($event)"
      />
    }
  `,
  styles: `
    .mt-scan {
      display: flex;
      flex-direction: column;
      gap: var(--space-24);
      width: 100%;
      max-width: 640px;
    }
    .mt-scan .note-actions {
      margin-top: var(--space-8);
    }
    .mt-scan .pages,
    .mt-scan .details {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-scan h2 {
      margin: 0;
    }
    .mt-scan .head {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-scan .count {
      font-variant-numeric: tabular-nums;
    }
    .mt-scan .list {
      display: flex;
      flex-direction: column;
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      background: var(--bg-surface);
      overflow: hidden;
    }
    .mt-scan .row {
      display: flex;
      align-items: center;
      gap: var(--space-12);
      min-height: 88px;
      padding: var(--space-8) var(--space-8) var(--space-8) 0;
      background: var(--bg-surface);
      transition: background-color var(--motion-fast) var(--ease-out);
    }
    .mt-scan .row + .row {
      border-top: 1px solid var(--border-subtle);
    }
    .mt-scan .row[data-dragging] {
      position: relative;
      z-index: 1;
      background: var(--bg-hover);
      box-shadow: var(--shadow-popover);
    }
    .mt-scan .grip {
      display: grid;
      place-items: center;
      align-self: stretch;
      width: 44px;
      padding: 0;
      border: 0;
      background: none;
      color: var(--icon-muted);
      cursor: grab;
      touch-action: none;
      outline: none;
      -webkit-tap-highlight-color: transparent;
    }
    .mt-scan .grip:focus-visible {
      box-shadow: inset var(--focus-ring);
    }
    .mt-scan .row[data-dragging] .grip {
      cursor: grabbing;
      color: var(--icon-default);
    }
    .mt-scan .thumb {
      position: relative;
      display: grid;
      place-items: center;
      flex: none;
      width: 52px;
      height: 68px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--bg-sunken);
      overflow: hidden;
    }
    .mt-scan .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: filter var(--motion-base) var(--ease-out);
    }
    .mt-scan .list[data-mode='grey'] .thumb img {
      filter: grayscale(1) contrast(1.1);
    }
    .mt-scan .thumb .spin,
    .mt-scan .thumb .bad {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: rgb(255 255 255 / 0.6);
      color: var(--icon-default);
    }
    .mt-scan .thumb .spin svg {
      animation: mt-scan-spin 0.9s linear infinite;
    }
    .mt-scan .thumb .bad {
      color: var(--text-danger);
    }
    .mt-scan .text {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      gap: 2px;
    }
    .mt-scan .text .tt {
      font: 600 15px/20px var(--font-sans);
    }
    .mt-scan .text .ts {
      font: 400 13px/18px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-scan .text .ts[data-tone='warning'] {
      color: var(--text-warning);
    }
    .mt-scan .text .ts[data-tone='danger'] {
      color: var(--text-danger);
    }
    .mt-scan .add {
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-scan .matter {
      display: flex;
      flex-direction: column;
      gap: var(--space-6, 6px);
    }
    .mt-scan .matter .choice {
      gap: var(--space-8);
      align-items: center;
      min-height: 36px;
    }
    .mt-scan .matter .chosen {
      display: flex;
      gap: var(--space-8);
      min-width: 0;
      align-items: baseline;
    }
    .mt-scan .matter .num {
      flex: none;
      font: 500 13px/18px var(--font-mono);
      color: var(--text-secondary);
    }
    .mt-scan .problem {
      margin: 0;
      color: var(--text-danger);
    }
    .mt-scan .save {
      position: sticky;
      bottom: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      margin: 0 calc(-1 * var(--space-16));
      padding: var(--space-12) var(--space-16);
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-scan .save .mt-btn {
      width: 100%;
    }
    @media (max-width: 767px) {
      .mt-scan .save {
        bottom: calc(64px + env(safe-area-inset-bottom, 0px));
      }
      .mt-scan .add .mt-btn {
        flex: 1;
      }
      /* Colour or black and white: the full width, with 44px targets. */
      .mt-scan .head .mt-seg {
        flex-basis: 100%;
      }
      .mt-scan .head .mt-seg-item {
        flex: 1;
        justify-content: center;
        height: 44px;
        font-size: 14px;
      }
    }
    @keyframes mt-scan-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .mt-scan .row,
      .mt-scan .thumb img {
        transition: none;
      }
      .mt-scan .thumb .spin svg {
        animation: none;
      }
    }
  `,
})
export class ScanPage implements HasUnsavedChanges {
  private readonly processor = inject(SCAN_PROCESSOR);
  private readonly queue = inject(ScanQueue);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly org = inject(OrgContext);
  private readonly online = inject(Connectivity).online;
  private readonly hasCamera = !!inject(MEDIA_DEVICES);
  private readonly matters = todayMatterRepository();
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly capturer = viewChild.required<ElementRef<HTMLInputElement>>('capturer');
  protected readonly canPrivileged = can('privileged.view');

  protected readonly items = signal<readonly ScanItem[]>([]);
  protected readonly mode = signal<ScanMode>('colour');
  protected readonly name = signal(defaultScanName(new Date()));
  protected readonly category = signal<DocumentCategory>('other');
  protected readonly privileged = signal(false);
  protected readonly matter = signal<ChosenMatter | null>(null);
  protected readonly matterLoading = signal(false);
  protected readonly camera = signal(false);
  protected readonly cameraBlocked = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly dragging = signal<string | null>(null);
  protected readonly announcement = signal('');
  private readonly saved = signal(false);
  /** Problems show once Save has been tried. */
  private readonly tried = signal(false);
  private readonly saveError = signal<string | null>(null);

  readonly unsaved = computed(() => !this.saved() && this.items().length > 0);

  protected readonly modes: MtOption<ScanMode>[] = [
    { value: 'colour', label: 'Colour' },
    { value: 'grey', label: 'Black and white' },
  ];
  protected readonly categoryOptions: MtOption<DocumentCategory>[] = DOCUMENT_CATEGORIES.map((value) => ({
    value,
    label: DOCUMENT_CATEGORY_LABELS[value],
  }));

  protected readonly full = computed(() => this.items().length >= SCAN_MAX_PAGES);
  protected readonly working = computed(() => this.items().some((item) => item.busy));
  protected readonly countText = computed(() => {
    const count = this.items().length;
    return count === 1 ? '1 page' : `${count} pages`;
  });
  protected readonly saveLabel = computed(() => {
    if (this.saving()) return 'Saving…';
    if (this.working()) return 'Finishing the pages…';
    return 'Add to matter';
  });
  private readonly problem = computed(() => {
    const items = this.items();
    if (items.some((item) => item.error)) return 'Remove the photos that couldn’t be made into pages.';
    if (!items.some((item) => item.page)) return 'Add at least one page.';
    const matter = this.matter();
    if (!matter) return 'Choose the matter the document is for.';
    if (matter.archived) return 'Choose a matter that isn’t archived.';
    const name = this.name()
      .trim()
      .replace(/\.pdf$/i, '')
      .trim();
    if (!name) return 'Give the document a name.';
    if (name.length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters.`;
    return null;
  });
  protected readonly shownProblem = computed(() => this.saveError() ?? (this.tried() ? this.problem() : null));

  /** Pages are made one at a time, so a phone holds one full-size photo at most. */
  private work: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor() {
    warnBeforeUnload(this.unsaved);
    const matterId = inject(ActivatedRoute).snapshot.queryParamMap.get('matter');
    if (matterId) void this.loadMatter(matterId);
    // Record and app start load the queue with `import('./scan-queue')`, which the build serves as a
    // chunk of its own. Fetch it now, while there's a connection, so a scan saved offline still
    // shows on Record (and the service worker keeps it for a start without one).
    void import('./scan-queue').catch(() => undefined);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      for (const item of untracked(this.items)) if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    });
  }

  // ---------- adding pages ----------

  /** The in-app camera where the browser has one; otherwise (or once it failed) the phone's camera app. */
  protected takePhotos(): void {
    this.notice.set(null);
    if (this.hasCamera && !this.cameraBlocked()) this.camera.set(true);
    else this.capturer().nativeElement.click();
  }

  protected cameraFailed(message: string): void {
    this.camera.set(false);
    this.cameraBlocked.set(true);
    this.notice.set(message);
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    this.addPhotos(files);
  }

  addPhotos(photos: readonly Blob[]): void {
    if (!photos.length) return;
    const room = SCAN_MAX_PAGES - untracked(this.items).length;
    const taken = photos.slice(0, Math.max(0, room));
    if (taken.length < photos.length) {
      this.notice.set(
        `A scan holds up to ${SCAN_MAX_PAGES} pages. Save this one, then scan the rest as another document.`,
      );
    }
    for (const photo of taken) {
      const id = `scan-page-${++nextItem}`;
      this.items.update((items) => [...items, { id, busy: true }]);
      this.queueWork(() => this.make(id, photo));
    }
    if (taken.length) this.saveError.set(null);
  }

  private queueWork(task: () => Promise<void>): void {
    this.work = this.work.then(task).catch(() => undefined);
  }

  /** Makes the page from its photo (or makes it again with new corners). */
  private async make(id: string, photo: Blob, quad?: Quad): Promise<void> {
    if (this.destroyed || !this.find(id)) return;
    try {
      const page = await this.processor.process(photo, quad ? { quad } : {});
      if (this.destroyed || !this.find(id)) return;
      const thumbUrl = URL.createObjectURL(page.thumb);
      this.patch(id, (item) => {
        if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
        return { id, page, thumbUrl, busy: false };
      });
    } catch (error) {
      if (this.destroyed || !this.find(id)) return;
      const message =
        error instanceof ScanError ? error.message : 'This photo couldn’t be made into a page. Take it again.';
      if (this.find(id)?.page) {
        // Turning or re-cropping failed: the page stays as it was.
        this.patch(id, (item) => ({ ...item, busy: false }));
        this.toasts.show({ tone: 'danger', title: 'The page couldn’t be changed', description: message });
      } else {
        this.patch(id, (item) => ({ ...item, busy: false, error: message }));
      }
    }
  }

  // ---------- each page ----------

  protected detail(item: ScanItem): string {
    if (item.error) return item.error;
    if (!item.page) return 'Straightening…';
    if (item.busy) return 'Updating…';
    if (!item.page.found) return 'Edges not found. Adjust the corners if it needs cropping.';
    return 'Straightened';
  }

  protected tone(item: ScanItem): 'warning' | 'danger' | null {
    if (item.error) return 'danger';
    if (item.page && !item.page.found && !item.busy) return 'warning';
    return null;
  }

  protected rotate(id: string): void {
    const page = this.find(id)?.page;
    if (!page) return;
    this.patch(id, (item) => ({ ...item, busy: true }));
    this.queueWork(() => this.make(id, page.photo, rotateQuad(page.quad)));
  }

  protected async adjust(id: string): Promise<void> {
    const page = this.find(id)?.page;
    if (!page) return;
    const { ScanCropDialog } = await import('./scan-crop-dialog');
    const quad = await this.dialogs.open<ScanCropData, Quad>(ScanCropDialog, {
      data: {
        photo: page.photo,
        width: page.photoWidth,
        height: page.photoHeight,
        quad: page.quad,
        page: this.indexOf(id) + 1,
      },
    }).result;
    if (!quad || this.destroyed || this.find(id)?.page !== page) return;
    this.patch(id, (item) => ({ ...item, busy: true }));
    this.queueWork(() => this.make(id, page.photo, quad));
  }

  protected move(id: string, by: number): void {
    const from = this.indexOf(id);
    this.moveTo(id, from + by);
    this.focusGrip(id);
  }

  protected remove(id: string): void {
    const index = this.indexOf(id);
    const item = this.find(id);
    if (!item) return;
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    this.items.update((items) => items.filter((other) => other.id !== id));
    this.announcement.set(`Page ${index + 1} removed.`);
    if (this.items().length < SCAN_MAX_PAGES && this.notice()?.startsWith('A scan holds')) this.notice.set(null);
  }

  // ---------- dragging into order ----------

  protected grab(event: PointerEvent, id: string): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.dragging.set(id);
  }

  /** The page moves to the row the pointer is over, as it moves. */
  protected drag(event: PointerEvent): void {
    const id = this.dragging();
    const list = this.list()?.nativeElement;
    if (!id || !list) return;
    const rows = [...list.querySelectorAll<HTMLElement>('[data-page-row]')];
    // The first row whose middle is below the pointer; past the last row's middle, the end.
    const over = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    this.moveTo(id, over >= 0 ? over : rows.length - 1, false);
  }

  protected drop(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    const id = this.dragging();
    if (!id) return;
    this.dragging.set(null);
    this.announcement.set(`Page moved to position ${this.indexOf(id) + 1}.`);
  }

  protected gripKey(event: KeyboardEvent, id: string): void {
    const by = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!by) return;
    event.preventDefault();
    this.move(id, by);
  }

  private moveTo(id: string, to: number, announce = true): void {
    const items = [...this.items()];
    const from = items.findIndex((item) => item.id === id);
    const target = Math.min(items.length - 1, Math.max(0, to));
    if (from < 0 || from === target) return;
    const [item] = items.splice(from, 1);
    if (!item) return;
    items.splice(target, 0, item);
    this.items.set(items);
    if (announce) this.announcement.set(`Page moved to position ${target + 1}.`);
  }

  /** Moving a row re-inserts it, which drops focus: put it back on the row's handle. */
  private focusGrip(id: string): void {
    setTimeout(() => this.list()?.nativeElement.querySelector<HTMLElement>(`[data-grip="${id}"]`)?.focus());
  }

  // ---------- the matter ----------

  protected async chooseMatter(): Promise<void> {
    const picked = await pickMatter(this.dialogs, 'Choose the matter', 'The scan is added to this matter’s documents.');
    if (!picked || this.destroyed) return;
    this.matter.set({ id: picked.matterId, number: picked.matterNumber, title: '', archived: false });
    await this.loadMatter(picked.matterId);
  }

  private async loadMatter(id: string): Promise<void> {
    this.matterLoading.set(true);
    try {
      const found = await this.matters.get(id);
      if (this.destroyed) return;
      if (found && !found.deletedAt) {
        this.matter.set({ id, number: found.number, title: found.title, archived: found.status === 'archived' });
      }
    } catch {
      // Offline with the matter never read on this phone: keep what the picker gave, or choose one.
    } finally {
      this.matterLoading.set(false);
    }
  }

  // ---------- saving ----------

  protected async save(): Promise<void> {
    if (this.saving() || this.working()) return;
    this.tried.set(true);
    this.saveError.set(null);
    const matter = this.matter();
    const uid = this.org.uid();
    const orgId = this.org.orgId();
    if (this.problem() || !matter || !uid || !orgId) return;
    const pages = this.items().flatMap((item) => (item.page ? [item.page] : []));
    const fileName = scanFileName(this.name());
    this.saving.set(true);
    try {
      const grey = this.mode() === 'grey';
      const jpegs: Uint8Array[] = [];
      for (const page of pages) {
        jpegs.push(await blobBytes(grey ? await this.processor.grayscale(page.jpeg) : page.jpeg));
      }
      const bytes = scanPdf(jpegs, { title: fileName.replace(/\.pdf$/, ''), created: new Date() });
      if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
        throw new ScanError('This scan is over 50 MB. Remove some pages, or save it in black and white.');
      }
      const { queued } = await this.queue.add({
        id: newScanId(),
        orgId,
        uid,
        matterId: matter.id,
        matterLabel: matter.title ? `${matter.number} ${matter.title}` : matter.number,
        fileName,
        category: this.category(),
        ...(this.canPrivileged() && this.privileged() ? { privileged: true } : {}),
        pages: pages.length,
        pdf: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        savedAt: Date.now(),
      });
      this.saved.set(true);
      if (this.online() || !queued) {
        await this.router.navigateByUrl(`/matters/${matter.id}/documents`);
      } else {
        this.toasts.show({
          tone: 'success',
          title: 'Scan saved on this phone',
          description: `${fileName} uploads to ${matter.number} when you’re back online.`,
        });
        await this.router.navigateByUrl('/record');
      }
    } catch (error) {
      this.saveError.set(error instanceof ScanError ? error.message : 'The scan couldn’t be saved. Try again.');
    } finally {
      this.saving.set(false);
    }
  }

  // ---------- helpers ----------

  private find(id: string): ScanItem | undefined {
    return untracked(this.items).find((item) => item.id === id);
  }

  private indexOf(id: string): number {
    return untracked(this.items).findIndex((item) => item.id === id);
  }

  private patch(id: string, change: (item: ScanItem) => ScanItem): void {
    this.items.update((items) => items.map((item) => (item.id === id ? change(item) : item)));
  }
}

function newScanId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A Blob's bytes (`FileReader` where `Blob.arrayBuffer` is missing, as in older engines). */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}
