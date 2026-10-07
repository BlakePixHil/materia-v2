import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  InjectionToken,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import { MtButton, MtIconButton } from '@materia/ui';

/** The browser's cameras (`navigator.mediaDevices`), or null where there are none. Tests replace it. */
export const MEDIA_DEVICES = new InjectionToken<Pick<MediaDevices, 'getUserMedia'> | null>('MEDIA_DEVICES', {
  providedIn: 'root',
  factory: () =>
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
      ? navigator.mediaDevices
      : null,
});

/** A photo of the page at the camera's full resolution, as a near-lossless JPEG. */
const CAPTURE_QUALITY = 0.92;

/** Why the camera didn't open, and what to do instead. */
export function cameraErrorCopy(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Materia isn’t allowed to use the camera. Allow it in your browser’s settings, or take the photos with your camera app.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'There’s no camera Materia can use. Choose photos instead.';
  }
  return 'The camera didn’t start. Take the photos with your camera app instead.';
}

/**
 * The in-app camera (MOB-05): the back camera full screen, a shutter, and how many pages so far, so
 * a multi-page document is one photo after another without leaving Materia. Each photo goes out as
 * `captured`; Done or Escape closes it (`closed`). When the camera can't start, `failed` says why
 * and the Scan screen falls back to the phone's own camera app.
 */
@Component({
  selector: 'mt-scan-camera',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtIconButton],
  host: {
    class: 'mt-scan-camera',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Camera',
    '(keydown.escape)': 'close()',
  },
  template: `
    <video #video playsinline muted aria-hidden="true"></video>
    <div class="top">
      <button mtIconButton icon="x" label="Close the camera" (click)="close()"></button>
      <span class="count" role="status">{{ countText() }}</span>
    </div>
    @if (!ready()) {
      <p class="starting" role="status">Starting the camera…</p>
    }
    <div class="bottom">
      <span class="last">
        @if (lastUrl(); as url) {
          <img [src]="url" alt="" />
        }
      </span>
      <button
        #shutter
        type="button"
        class="shutter"
        aria-label="Take photo"
        [disabled]="!ready() || busy()"
        (click)="shoot()"
      ></button>
      <span class="done">
        <button mtButton variant="secondary" (click)="close()">Done</button>
      </span>
    </div>
    <div class="flash" aria-hidden="true" [attr.data-on]="flashing() ? '' : null"></div>
  `,
  styles: `
    .mt-scan-camera {
      position: fixed;
      inset: 0;
      z-index: var(--layer-modal);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background: #000;
      color: #fff;
    }
    .mt-scan-camera video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .mt-scan-camera .top,
    .mt-scan-camera .bottom {
      position: relative;
      display: flex;
      align-items: center;
      gap: var(--space-12);
      padding: var(--space-12) max(var(--space-16), env(safe-area-inset-right, 0px)) var(--space-12)
        max(var(--space-16), env(safe-area-inset-left, 0px));
      background: rgb(0 0 0 / 0.45);
    }
    .mt-scan-camera .top {
      padding-top: calc(var(--space-12) + env(safe-area-inset-top, 0px));
      justify-content: space-between;
    }
    .mt-scan-camera .top .mt-icon-btn {
      color: #fff;
    }
    .mt-scan-camera .count {
      font: 600 15px/20px var(--font-sans);
      font-variant-numeric: tabular-nums;
    }
    .mt-scan-camera .starting {
      position: relative;
      margin: auto;
      font: 400 15px/22px var(--font-sans);
    }
    .mt-scan-camera .bottom {
      justify-content: space-between;
      padding-bottom: calc(var(--space-20) + env(safe-area-inset-bottom, 0px));
    }
    .mt-scan-camera .last,
    .mt-scan-camera .done {
      display: flex;
      flex: 1;
      min-width: 0;
    }
    .mt-scan-camera .done {
      justify-content: flex-end;
    }
    .mt-scan-camera .last img {
      width: 44px;
      height: 56px;
      object-fit: cover;
      border: 2px solid #fff;
      border-radius: var(--radius-sm);
    }
    .mt-scan-camera .shutter {
      flex: none;
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 4px solid #fff;
      background: rgb(255 255 255 / 0.85);
      box-shadow: 0 0 0 2px rgb(0 0 0 / 0.4);
      cursor: pointer;
      transition: transform var(--motion-fast) var(--ease-out);
    }
    .mt-scan-camera .shutter:active:not(:disabled) {
      transform: scale(0.92);
    }
    .mt-scan-camera .shutter:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .mt-scan-camera .shutter:focus-visible {
      outline: 3px solid var(--border-focus);
      outline-offset: 3px;
    }
    .mt-scan-camera .flash {
      position: absolute;
      inset: 0;
      background: #fff;
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--motion-slow) var(--ease-out);
    }
    .mt-scan-camera .flash[data-on] {
      opacity: 0.6;
      transition: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .mt-scan-camera .flash {
        display: none;
      }
      .mt-scan-camera .shutter {
        transition: none;
      }
    }
  `,
})
export class ScanCamera {
  /** Pages already in the scan (the count goes on from there). */
  readonly pages = input(0);
  readonly captured = output<Blob>();
  readonly closed = output();
  readonly failed = output<string>();

  private readonly devices = inject(MEDIA_DEVICES);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly shutter = viewChild.required<ElementRef<HTMLButtonElement>>('shutter');
  private stream: MediaStream | null = null;
  private stopped = false;

  protected readonly ready = signal(false);
  protected readonly busy = signal(false);
  protected readonly flashing = signal(false);
  protected readonly lastUrl = signal<string | null>(null);
  private readonly taken = signal(0);
  protected readonly countText = computed(() => {
    const count = this.pages() + this.taken();
    return count === 1 ? '1 page' : `${count} pages`;
  });

  constructor() {
    afterNextRender(() => void this.start());
    inject(DestroyRef).onDestroy(() => {
      this.stop();
      const url = this.lastUrl();
      if (url) URL.revokeObjectURL(url);
    });
  }

  private async start(): Promise<void> {
    try {
      if (!this.devices) throw Object.assign(new Error('No camera'), { name: 'NotFoundError' });
      const stream = await this.devices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const video = this.video().nativeElement;
      video.srcObject = stream;
      await video.play();
      this.ready.set(true);
      // Wait for the shutter to enable before moving focus to it.
      queueMicrotask(() => setTimeout(() => this.shutter().nativeElement.focus()));
    } catch (error) {
      if (this.stopped) return;
      this.stop();
      this.failed.emit(cameraErrorCopy(error));
    }
  }

  protected async shoot(): Promise<void> {
    const video = this.video().nativeElement;
    if (!video.videoWidth || this.busy()) return;
    this.busy.set(true);
    this.flashing.set(true);
    setTimeout(() => this.flashing.set(false), 60);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', CAPTURE_QUALITY));
      canvas.width = canvas.height = 0;
      if (!blob) return;
      const previous = this.lastUrl();
      if (previous) URL.revokeObjectURL(previous);
      this.lastUrl.set(URL.createObjectURL(blob));
      this.taken.update((n) => n + 1);
      this.captured.emit(blob);
    } finally {
      this.busy.set(false);
    }
  }

  protected close(): void {
    this.stop();
    this.closed.emit();
  }

  private stop(): void {
    this.stopped = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
