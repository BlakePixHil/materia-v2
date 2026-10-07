import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import { injectDialogRef, MtButton, MtDialog } from '@materia/ui';

import { isUsable, MIN_CROP_AREA, type Point, type Quad, WHOLE_PHOTO } from './scan-image';

export interface ScanCropData {
  /** The page's photo (its working copy) and its size in pixels. */
  photo: Blob;
  width: number;
  height: number;
  /** The corners as they are now. */
  quad: Quad;
  /** The page's number, for the title. */
  page: number;
}

const CORNER_NAMES = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'] as const;
/** An arrow key moves a corner 1% of the photo; with Shift, 5%. */
const STEP = 0.01;
const BIG_STEP = 0.05;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const percent = (value: number) => Math.round(value * 1000) / 10;

/**
 * Adjust corners (MOB-05): the page's photo with its four corners to drag onto the page's own
 * corners, for when the edges weren't found or were found wrong. A corner also moves with the
 * arrow keys. Apply gives the new corners; the page is straightened again from them.
 */
@Component({
  selector: 'mt-scan-crop-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtDialog],
  template: `
    <mt-dialog
      size="lg"
      [title]="'Adjust the corners of page ' + data.page"
      description="Drag each corner onto the corner of the page. The page is straightened to fit."
    >
      <div class="mt-scan-crop">
        <div #frame class="frame" [style.aspect-ratio]="data.width + ' / ' + data.height" [style.width]="frameWidth">
          @if (url) {
            <img [src]="url" alt="" draggable="false" />
          }
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path class="shade" fill-rule="evenodd" [attr.d]="shade()" />
            <polygon class="edge" [attr.points]="outline()" />
          </svg>
          @for (corner of quad(); track $index) {
            <button
              type="button"
              class="handle"
              [style.left.%]="corner.x * 100"
              [style.top.%]="corner.y * 100"
              [attr.aria-label]="cornerLabel($index, corner)"
              aria-describedby="mt-scan-crop-help"
              [attr.data-corner]="$index"
              [attr.data-dragging]="dragging() === $index ? '' : null"
              (pointerdown)="grab($event, $index)"
              (pointermove)="drag($event, $index)"
              (pointerup)="drop($event)"
              (pointercancel)="drop($event)"
              (keydown)="nudge($event, $index)"
            >
              <span class="dot"></span>
            </button>
          }
        </div>
        <p id="mt-scan-crop-help" class="mt-sr">
          Drag a corner, or select it and use the arrow keys. Shift moves it further.
        </p>
        @if (!usable()) {
          <p class="caption problem" role="alert">
            These corners don’t frame a page. Drag them onto the page’s four corners.
          </p>
        }
      </div>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" class="whole" (click)="reset()">Use the whole photo</button>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" [disabled]="!usable()" (click)="apply()">Apply</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-scan-crop {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-12);
      padding-block: var(--space-12);
    }
    .mt-scan-crop .frame {
      position: relative;
      max-width: 100%;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .mt-scan-crop .frame img,
    .mt-scan-crop .frame svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .mt-scan-crop .frame img {
      object-fit: fill;
      border-radius: var(--radius-sm);
      -webkit-user-drag: none;
    }
    .mt-scan-crop .shade {
      fill: rgb(0 0 0 / 0.45);
    }
    .mt-scan-crop .edge {
      fill: none;
      stroke: var(--border-focus);
      stroke-width: 2px;
      vector-effect: non-scaling-stroke;
    }
    .mt-scan-crop .handle {
      position: absolute;
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      margin: -22px 0 0 -22px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      cursor: grab;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
      outline: none;
    }
    .mt-scan-crop .handle .dot {
      width: 20px;
      height: 20px;
      border: 3px solid var(--border-focus);
      border-radius: 50%;
      background: var(--bg-surface);
      box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
      transition: transform var(--motion-fast) var(--ease-out);
    }
    .mt-scan-crop .handle[data-dragging] {
      cursor: grabbing;
    }
    .mt-scan-crop .handle[data-dragging] .dot {
      transform: scale(1.25);
    }
    .mt-scan-crop .handle:focus-visible .dot {
      box-shadow: var(--focus-ring);
    }
    .mt-scan-crop .problem {
      margin: 0;
      color: var(--text-danger);
    }
    .mt-dialog-f .whole {
      margin-right: auto;
    }
    @media (prefers-reduced-motion: reduce) {
      .mt-scan-crop .handle .dot {
        transition: none;
      }
    }
  `,
})
export class ScanCropDialog {
  protected readonly ref = injectDialogRef<ScanCropData, Quad>();
  protected readonly data = this.ref.data;
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');

  /** The photo, for as long as the dialog is open. */
  protected readonly url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(this.data.photo) : null;
  /** As wide as fits, and no taller than most of the screen. */
  protected readonly frameWidth = `min(100%, calc(56dvh * ${this.data.width / this.data.height}))`;

  protected readonly quad = signal<Quad>(this.data.quad);
  protected readonly dragging = signal<number | null>(null);
  protected readonly usable = computed(() => isUsable(this.quad(), MIN_CROP_AREA));
  protected readonly outline = computed(() =>
    this.quad()
      .map((point) => `${point.x * 100},${point.y * 100}`)
      .join(' '),
  );
  /** Darkens the photo outside the corners. */
  protected readonly shade = computed(
    () =>
      `M0 0H100V100H0Z M${this.quad()
        .map((point) => `${point.x * 100} ${point.y * 100}`)
        .join(' L')}Z`,
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.url) URL.revokeObjectURL(this.url);
    });
  }

  protected cornerLabel(index: number, point: Point): string {
    return `${CORNER_NAMES[index]} corner, ${percent(point.x)}% across, ${percent(point.y)}% down`;
  }

  protected grab(event: PointerEvent, index: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    (event.currentTarget as HTMLElement).focus();
    this.dragging.set(index);
  }

  protected drag(event: PointerEvent, index: number): void {
    if (this.dragging() !== index) return;
    const box = this.frame().nativeElement.getBoundingClientRect();
    if (!box.width || !box.height) return;
    this.move(index, { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
  }

  protected drop(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.dragging.set(null);
  }

  protected nudge(event: KeyboardEvent, index: number): void {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const moves: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const by = moves[event.key];
    if (!by) return;
    event.preventDefault();
    const point = this.quad()[index];
    if (!point) return;
    this.move(index, { x: point.x + by.x, y: point.y + by.y });
  }

  protected reset(): void {
    this.quad.set(WHOLE_PHOTO);
  }

  protected apply(): void {
    if (this.usable()) void this.ref.close(this.quad());
  }

  private move(index: number, to: Point): void {
    const quad = [...this.quad()] as [Point, Point, Point, Point];
    quad[index] = { x: clamp(to.x), y: clamp(to.y) };
    this.quad.set(quad);
  }
}
