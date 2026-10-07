import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  input,
  output,
  signal,
  ViewEncapsulation,
} from '@angular/core';

import { MtIcon } from '../icon/icon';

/** How far (px) the indicator must be pulled to refresh, and the furthest it goes. */
const PULL_COMMIT_PX = 64;
const PULL_MAX_PX = 96;
/** The finger moves this much further than the indicator, so the pull feels weighted. */
const PULL_RESISTANCE = 0.5;

/**
 * Pull to refresh (`mt-pull-refresh`, MOB-02): put it first on a page whose window scrolls. Pulled
 * down from the top of the page with a finger, it says "Pull to refresh", then "Release to refresh",
 * and emits `refresh` when let go past 64px; it shows "Refreshing…" while `refreshing` is set.
 *
 * Touch only: a mouse or a keyboard reloads the way it always has. While it's on the page the browser's
 * own pull-to-reload (Chrome on Android) is off, so one pull doesn't reload the whole app.
 */
@Component({
  selector: 'mt-pull-refresh',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/ptr.css',
  imports: [MtIcon],
  host: {
    class: 'mt-ptr',
    '[attr.data-pulling]': 'pull() > 0 ? "" : null',
    '[attr.data-ready]': 'ready() ? "" : null',
    '[attr.data-refreshing]': 'refreshing() ? "" : null',
    '[style.--mt-pull]': 'offset() + "px"',
  },
  template: `
    <mt-icon name="refresh" [size]="16" [style.transform]="refreshing() ? null : 'rotate(' + turn() + 'deg)'" />
    <span aria-hidden="true">{{ label() }}</span>
    <span class="mt-sr" role="status">{{ refreshing() ? 'Refreshing…' : '' }}</span>
  `,
})
export class MtPullToRefresh {
  /** The page is refreshing: the indicator stays open with "Refreshing…". */
  readonly refreshing = input(false, { transform: booleanAttribute });
  readonly refresh = output();

  /** How far the indicator is pulled down, in px. */
  protected readonly pull = signal(0);
  protected readonly ready = computed(() => this.pull() >= PULL_COMMIT_PX);
  /** How far the pill has come down from under the header. */
  protected readonly offset = computed(() => (this.refreshing() ? PULL_COMMIT_PX : this.pull()));
  protected readonly turn = computed(() => Math.round((this.pull() / PULL_COMMIT_PX) * 180));
  protected readonly label = computed(() => {
    if (this.refreshing()) return 'Refreshing…';
    return this.ready() ? 'Release to refresh' : 'Pull to refresh';
  });

  constructor() {
    const document = inject(DOCUMENT);
    const view = document.defaultView;
    if (!view) return;
    const root = document.documentElement;
    const overscroll = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = 'contain';

    let startY: number | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      startY = event.touches.length === 1 && touch && view.scrollY <= 0 && !this.refreshing() ? touch.clientY : null;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (startY === null || !touch) return;
      const dy = touch.clientY - startY;
      // Scrolled back up past where it started, or the page has scrolled: not a pull.
      if (dy <= 0 || view.scrollY > 0) {
        this.pull.set(0);
        return;
      }
      this.pull.set(Math.min(PULL_MAX_PX, dy * PULL_RESISTANCE));
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      const pulled = this.ready();
      this.pull.set(0);
      if (pulled) this.refresh.emit();
    };
    const options = { passive: true } as const;
    document.addEventListener('touchstart', onStart, options);
    document.addEventListener('touchmove', onMove, options);
    document.addEventListener('touchend', onEnd, options);
    document.addEventListener('touchcancel', onEnd, options);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      root.style.overscrollBehaviorY = overscroll;
    });
  }
}
