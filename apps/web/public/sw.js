/*
 * The service worker (MOB-01, ADR-020): Angular's ngsw-worker.js, with three changes made before it
 * loads.
 *
 * 1. Requests to other origins (Firestore, Functions, Storage, reCAPTCHA) and to Firebase's
 *    reserved /__/ paths never reach the worker: they go to the network exactly as they would
 *    without one. Firestore keeps its own offline cache (FND-19), and callables need a connection.
 * 2. A page load waits at most NAVIGATION_TIMEOUT_MS for the network, then gets the cached
 *    index.html. Angular's "freshness" strategy has no timeout of its own, so on a weak connection
 *    the app would otherwise wait as long as the browser does.
 * 3. Push notifications (MOB-04, ADR-065) are shown and tapped here, not by Angular's worker or the
 *    Firebase scripts (see below).
 *
 * Listeners run in the order they were added, so these run before Angular's.
 */
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__/')) {
    event.stopImmediatePropagation();
  }
});

// Angular's worker fetches through `self.fetch`, and falls back to the cached index.html when a
// page load's fetch rejects.
const networkFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  if (!(input instanceof Request) || input.mode !== 'navigate') return networkFetch(input, init);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The network took too long')), NAVIGATION_TIMEOUT_MS);
    networkFetch(input, init).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
};

/*
 * Push (MOB-04). Firebase Cloud Messaging delivers each push as JSON:
 * `{ notification: { title, body }, data: { link, orgId?, tag? } }`. This worker shows it (every
 * push shows a notification, as Safari requires), and Angular's worker, which would show it a
 * second time, never sees it. A tap focuses an open Materia window and asks it to open the link
 * in place, or opens a new window; either way the app's /open page opens the link, after asking
 * to switch when it belongs to another org.
 */
const PUSH_ICON = '/assets/icons/icon-192.png';
const PUSH_OPEN_MESSAGE = 'materia:push-open';

/** `/open?to=<link>&org=<orgId>`; a link that isn't an app path opens Today. */
function pushOpenUrl(data) {
  const link = typeof data.link === 'string' && /^\/(?![/\\])/.test(data.link) ? data.link : '/today';
  const params = new URLSearchParams({ to: link });
  if (typeof data.orgId === 'string' && data.orgId) params.set('org', data.orgId);
  return `/open?${params.toString()}`;
}

self.addEventListener('push', (event) => {
  event.stopImmediatePropagation();
  let payload = {};
  try {
    payload = (event.data && event.data.json()) || {};
  } catch {
    payload = {};
  }
  const notification = payload.notification || {};
  const data = payload.data || {};
  const options = {
    body: typeof notification.body === 'string' ? notification.body : '',
    icon: PUSH_ICON,
    data: { url: pushOpenUrl(data) },
  };
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag;
  const title = typeof notification.title === 'string' && notification.title ? notification.title : 'Materia';
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.stopImmediatePropagation();
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/today';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.filter((client) => new URL(client.url).origin === self.location.origin);
      const client =
        open.find((each) => each.focused) || open.find((each) => each.visibilityState === 'visible') || open[0];
      if (!client) {
        await self.clients.openWindow(url);
        return;
      }
      await client.focus();
      client.postMessage({ type: PUSH_OPEN_MESSAGE, url });
    })(),
  );
});

importScripts('./ngsw-worker.js');
