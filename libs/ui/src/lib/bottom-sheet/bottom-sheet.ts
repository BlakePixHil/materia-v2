import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { injectDialogRef, NgpDialog, NgpDialogOverlay, NgpDialogTitle } from 'ng-primitives/dialog';

/** How far the sheet must be dragged down (px) to close, and up to expand. */
const DRAG_CLOSE_PX = 80;
const DRAG_EXPAND_PX = 60;

/**
 * The phone's dialog (`mt-bottom-sheet`): slides up from the bottom for a short task. Opened like a
 * dialog (`DialogService` or `[mtDialogTrigger]`), with the same focus trap, Escape and scroll lock.
 *
 * - Drag the handle (pointer events): down past 80px closes; up expands from the 50% snap point to 90%.
 * - The handle is also a button: Enter toggles between the two heights.
 * - When the on-screen keyboard opens (iOS Safari resizes the visual viewport, not the layout
 *   viewport), the sheet moves up by the keyboard's height using `visualViewport`.
 */
@Component({
  selector: 'mt-bottom-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/overlay.css',
    '../../generated/components/modal.css',
    '../../generated/components/sheet.css',
  ],
  imports: [NgpDialogOverlay, NgpDialog, NgpDialogTitle],
  host: { style: 'display: contents' },
  template: `
    <div ngpDialogOverlay class="mt-overlay mt-modal-root" data-sheet>
      <div
        ngpDialog
        class="mt-sheet"
        [attr.data-snap]="snap()"
        [attr.data-dragging]="dragOffset() !== 0 ? '' : null"
        [style.transform]="dragOffset() ? 'translateY(' + dragOffset() + 'px)' : null"
        [style.bottom.px]="keyboardInset() || null"
      >
        <button
          type="button"
          class="grab"
          [attr.aria-label]="snap() === 'half' ? 'Expand sheet' : 'Shrink sheet'"
          (click)="toggleSnap()"
          (pointerdown)="dragStart($event)"
          (pointermove)="dragMove($event)"
          (pointerup)="dragEnd()"
          (pointercancel)="dragCancel()"
        ></button>
        <h2 ngpDialogTitle class="title-m">{{ title() }}</h2>
        <ng-content />
      </div>
    </div>
  `,
})
export class MtBottomSheet {
  readonly title = input.required<string>();
  /** Starting height: `half` (50%) or `full` (90%). */
  readonly initialSnap = input<'half' | 'full'>('half');

  protected readonly snap = signal<'half' | 'full'>('half');
  protected readonly dragOffset = signal(0);
  protected readonly keyboardInset = signal(0);
  private readonly ref = injectDialogRef({ optional: true });
  private startY: number | null = null;
  private moved = false;

  constructor() {
    afterNextRender(() => this.snap.set(this.initialSnap()));
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (vv) {
      const update = () => this.keyboardInset.set(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
      inject(DestroyRef).onDestroy(() => {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      });
    }
  }

  protected toggleSnap(): void {
    if (this.moved) {
      this.moved = false;
      return;
    }
    this.snap.set(this.snap() === 'half' ? 'full' : 'half');
  }

  protected dragStart(event: PointerEvent): void {
    this.startY = event.clientY;
    this.moved = false;
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  protected dragMove(event: PointerEvent): void {
    if (this.startY === null) return;
    const delta = event.clientY - this.startY;
    if (Math.abs(delta) > 4) this.moved = true;
    // Follow the finger downwards; resist upwards movement.
    this.dragOffset.set(delta > 0 ? delta : delta / 4);
  }

  protected dragEnd(): void {
    const delta = this.dragOffset() > 0 ? this.dragOffset() : this.dragOffset() * 4;
    this.startY = null;
    this.dragOffset.set(0);
    if (delta > DRAG_CLOSE_PX) {
      if (this.snap() === 'full') this.snap.set('half');
      else void this.ref?.close();
    } else if (delta < -DRAG_EXPAND_PX) {
      this.snap.set('full');
    }
  }

  protected dragCancel(): void {
    this.startY = null;
    this.dragOffset.set(0);
  }
}
