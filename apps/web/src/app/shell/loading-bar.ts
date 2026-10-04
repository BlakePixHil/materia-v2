import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router } from '@angular/router';

/** Delay before the bar appears, so instant navigations don't flash it. */
export const LOADING_BAR_DELAY_MS = 150;

/** A thin bar at the top of the main panel while a route (and its lazy chunk) loads. */
@Component({
  selector: 'mt-loading-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'mt-loading-bar',
    '[attr.data-active]': 'active() ? "" : null',
    role: 'progressbar',
    'aria-label': 'Loading page',
    '[attr.aria-hidden]': '!active()',
  },
  template: `<i></i>`,
})
export class MtLoadingBar {
  protected readonly active = signal(false);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        clearTimeout(timer);
        timer = setTimeout(() => this.active.set(true), LOADING_BAR_DELAY_MS);
      } else if (
        event instanceof NavigationEnd ||
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        clearTimeout(timer);
        this.active.set(false);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(timer);
      subscription.unsubscribe();
    });
  }
}
