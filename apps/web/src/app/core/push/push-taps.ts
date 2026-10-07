import type { Router } from '@angular/router';

/** What `sw.js` posts to an open Materia window when its push is tapped (MOB-04). */
export const PUSH_OPEN_MESSAGE = 'materia:push-open';

/**
 * A tap on a push while Materia is open (MOB-04): the service worker focuses the window and posts
 * `{ type: PUSH_OPEN_MESSAGE, url: '/open?…' }`, which opens in place, without a reload.
 */
export function listenForPushTaps(router: Pick<Router, 'navigateByUrl'>, view: Window | null): void {
  view?.navigator?.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== PUSH_OPEN_MESSAGE || typeof data.url !== 'string' || !data.url.startsWith('/open?')) return;
    void router.navigateByUrl(data.url);
  });
}
