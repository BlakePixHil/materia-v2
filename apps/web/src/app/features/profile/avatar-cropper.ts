import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { AVATAR_MAX_BYTES, AVATAR_SIZE, squareCrop } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtNote } from '@materia/ui';

export interface AvatarCropData {
  file: File;
}

/** The preview's side in CSS pixels. */
const PREVIEW = 240;

/**
 * Loads a photo for drawing. Browsers decode JPEG, PNG and WebP; Safari also decodes HEIC (an
 * iPhone photo), so on an iPhone or Mac a HEIC photo works as it is. Rejects what can't be read.
 */
export async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draws the cropped square onto a canvas `size` pixels a side. */
function draw(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  size: number,
  zoom: number,
  panX: number,
  panY: number,
) {
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return;
  const crop = squareCrop(image.naturalWidth, image.naturalHeight, zoom, panX, panY);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
}

/**
 * Crop a photo to a square (CORE-20): zoom with the slider, move it by dragging or with the arrow
 * keys. Closes with a 512px PNG, downscaled here so a 20 MB phone photo uploads as a small file.
 */
@Component({
  selector: 'mt-avatar-cropper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDialog, MtNote],
  template: `
    <mt-dialog size="sm" title="Crop your photo" description="Drag the photo or use the arrow keys to move it.">
      @if (problem(); as text) {
        <mt-note tone="danger">{{ text }}</mt-note>
      }
      <div class="mt-col" style="gap: 12px; align-items: center">
        <canvas
          #preview
          class="crop-preview"
          tabindex="0"
          role="img"
          aria-label="Photo preview"
          [style.width.px]="previewSize"
          [style.height.px]="previewSize"
          (pointerdown)="startDrag($event)"
          (pointermove)="drag($event)"
          (pointerup)="endDrag()"
          (pointercancel)="endDrag()"
          (keydown)="nudge($event)"
        ></canvas>
        <label class="mt-col" style="gap: 4px; width: 100%">
          <span class="label">Zoom</span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.05"
            [value]="zoom()"
            (input)="zoom.set(+$any($event.target).value)"
          />
        </label>
      </div>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" [disabled]="!ready()" [loading]="saving()" (click)="save()">
          Use photo
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .crop-preview {
      border-radius: 50%;
      background: var(--bg-sunken);
      cursor: grab;
      touch-action: none;
      outline-offset: 4px;
    }
    .crop-preview:active {
      cursor: grabbing;
    }
    input[type='range'] {
      width: 100%;
      accent-color: var(--bg-brand);
    }
  `,
})
export class AvatarCropper {
  protected readonly ref = injectDialogRef<AvatarCropData, Blob | undefined>();
  protected readonly previewSize = PREVIEW;
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('preview');
  private readonly image = signal<HTMLImageElement | null>(null);
  protected readonly zoom = signal(1);
  private readonly pan = signal({ x: 0, y: 0 });
  protected readonly problem = signal<string | null>(null);
  protected readonly ready = signal(false);
  protected readonly saving = signal(false);
  private dragFrom: { x: number; y: number; pan: { x: number; y: number } } | null = null;

  constructor() {
    const destroyed = signal(false);
    inject(DestroyRef).onDestroy(() => destroyed.set(true));
    afterNextRender(() => {
      loadImage(this.ref.data.file).then(
        (image) => {
          if (destroyed()) return;
          this.image.set(image);
          this.ready.set(true);
        },
        () =>
          this.problem.set(
            'This photo can’t be opened in this browser. HEIC photos open in Safari; elsewhere, save it as a JPEG or PNG first.',
          ),
      );
    });
    effect(() => {
      const image = this.image();
      if (!image) return;
      const ratio = globalThis.devicePixelRatio || 1;
      draw(this.canvas().nativeElement, image, Math.round(PREVIEW * ratio), this.zoom(), this.pan().x, this.pan().y);
    });
  }

  /** How far one preview pixel moves the crop, in pan units (-1..1 spans the slack). */
  private panPerPixel(): { x: number; y: number } {
    const image = this.image();
    if (!image) return { x: 0, y: 0 };
    const crop = squareCrop(image.naturalWidth, image.naturalHeight, this.zoom());
    const scale = crop.size / PREVIEW;
    const slackX = (image.naturalWidth - crop.size) / 2;
    const slackY = (image.naturalHeight - crop.size) / 2;
    return { x: slackX ? scale / slackX : 0, y: slackY ? scale / slackY : 0 };
  }

  private setPan(x: number, y: number): void {
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    this.pan.set({ x: clamp(x), y: clamp(y) });
  }

  protected startDrag(event: PointerEvent): void {
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.dragFrom = { x: event.clientX, y: event.clientY, pan: this.pan() };
  }

  protected drag(event: PointerEvent): void {
    if (!this.dragFrom) return;
    const per = this.panPerPixel();
    // Dragging the photo right shows more of its left: the crop moves the other way.
    this.setPan(
      this.dragFrom.pan.x - (event.clientX - this.dragFrom.x) * per.x,
      this.dragFrom.pan.y - (event.clientY - this.dragFrom.y) * per.y,
    );
  }

  protected endDrag(): void {
    this.dragFrom = null;
  }

  protected nudge(event: KeyboardEvent): void {
    const step = 0.1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    this.setPan(this.pan().x + move[0], this.pan().y + move[1]);
  }

  protected async save(): Promise<void> {
    const image = this.image();
    if (!image) return;
    this.saving.set(true);
    try {
      const canvas = document.createElement('canvas');
      draw(canvas, image, AVATAR_SIZE, this.zoom(), this.pan().x, this.pan().y);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png || png.size > AVATAR_MAX_BYTES) {
        this.problem.set('That photo couldn’t be made small enough. Try another one.');
        return;
      }
      void this.ref.close(png);
    } finally {
      this.saving.set(false);
    }
  }
}
