import { DestroyRef, DOCUMENT, inject, Injectable, signal } from '@angular/core';

/** Below this the app uses its phone layout: the TabBar, a compact header and BottomSheets (MOB-02). */
export const MOBILE_QUERY = '(max-width: 767px)';

/** The CSS variable holding how much of the window the on-screen keyboard covers, in px. */
export const KEYBOARD_INSET_VAR = '--mt-keyboard-inset';

/**
 * Whether the window is phone-sized, kept up to date as it changes (rotation, a resized window).
 *
 * It also keeps `--mt-keyboard-inset` on the root element: iOS Safari shrinks the visual viewport,
 * not the layout viewport, when the keyboard opens, so a dialog shown as a sheet at the bottom of
 * the screen would sit under the keyboard. The sheet pads itself by this much instead.
 */
@Injectable({ providedIn: 'root' })
export class PhoneLayout {
  private readonly state = signal(false);
  readonly phone = this.state.asReadonly();

  constructor() {
    const document = inject(DOCUMENT);
    const view = document.defaultView;
    const destroyRef = inject(DestroyRef);
    const media = view?.matchMedia?.(MOBILE_QUERY);
    if (media) {
      this.state.set(media.matches);
      const onChange = (event: MediaQueryListEvent) => this.state.set(event.matches);
      media.addEventListener?.('change', onChange);
      destroyRef.onDestroy(() => media.removeEventListener?.('change', onChange));
    }

    const viewport = view?.visualViewport;
    if (view && viewport) {
      const root = document.documentElement;
      const update = () => {
        const inset = Math.max(0, Math.round(view.innerHeight - viewport.height - viewport.offsetTop));
        if (inset) root.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`);
        else root.style.removeProperty(KEYBOARD_INSET_VAR);
      };
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
      destroyRef.onDestroy(() => {
        viewport.removeEventListener('resize', update);
        viewport.removeEventListener('scroll', update);
        root.style.removeProperty(KEYBOARD_INSET_VAR);
      });
    }
  }
}
