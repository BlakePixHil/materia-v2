import { inject, Injectable } from '@angular/core';
import {
  GuardsCheckStart,
  Router,
  type ActivatedRouteSnapshot,
  type PreloadingStrategy,
  type Route,
} from '@angular/router';
import { EMPTY, from, Observable } from 'rxjs';

/**
 * Starts downloading the lazy pages a navigation will show (every `loadComponent` in its target
 * tree) when its guards start. The router downloads them only once every guard has passed, and the
 * shell's guards wait for Auth to restore the session and for the org's policy (SEC-04), so on a
 * reload the page chunks used to wait for both. Only downloads: nothing renders before the guards
 * pass, and the router's own load then finds the module already fetched.
 */
export function prefetchPagesDuringGuards(): void {
  const router = inject(Router);
  router.events.subscribe((event) => {
    if (event instanceof GuardsCheckStart) prefetchComponents(event.state.root);
  });
}

/** Calls every `loadComponent` in the tree; a failed download is left for the router to report. */
export function prefetchComponents(snapshot: ActivatedRouteSnapshot): void {
  const load = snapshot.routeConfig?.loadComponent;
  if (load) Promise.resolve(load()).catch(() => undefined);
  for (const child of snapshot.children) prefetchComponents(child);
}

/** How long after a navigation the remaining pages start to download. */
export const PRELOAD_DELAY_MS = 3000;

/** Whether the browser asked to save data (Save-Data, or a 2G connection). */
export function saveData(nav: Navigator | undefined = globalThis.navigator): boolean {
  const connection = (nav as { connection?: { saveData?: boolean; effectiveType?: string } } | undefined)?.connection;
  return !!connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '');
}

/**
 * Downloads every other lazy page once the first one has had `PRELOAD_DELAY_MS` to load its data,
 * one at a time, so opening another page later doesn't wait for its chunks. That matters most on
 * dev, where each deploy replaces every chunk. Skipped when the browser asks to save data. A route
 * opts out with `data: { preload: false }`.
 */
@Injectable({ providedIn: 'root' })
export class DelayedPreloading implements PreloadingStrategy {
  /** Starts with the delay, on the first navigation's preload; each download waits for the last. */
  private queue: Promise<unknown> | null = null;

  preload(route: Route, load: () => Observable<unknown>): Observable<unknown> {
    if (route.data?.['preload'] === false || saveData()) return EMPTY;
    this.queue ??= new Promise((resolve) => setTimeout(resolve, PRELOAD_DELAY_MS));
    const next = this.queue.then(
      () =>
        new Promise<unknown>((resolve) => {
          // A failed download is retried by the router when the page is opened.
          load().subscribe({ complete: () => resolve(undefined), error: () => resolve(undefined) });
        }),
    );
    this.queue = next;
    return from(next);
  }
}
