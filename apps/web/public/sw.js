/*
 * The service worker (MOB-01, ADR-020): Angular's ngsw-worker.js, with two changes made before it
 * loads.
 *
 * 1. Requests to other origins (Firestore, Functions, Storage, reCAPTCHA) and to Firebase's
 *    reserved /__/ paths never reach the worker: they go to the network exactly as they would
 *    without one. Firestore keeps its own offline cache (FND-19), and callables need a connection.
 * 2. A page load waits at most NAVIGATION_TIMEOUT_MS for the network, then gets the cached
 *    index.html. Angular's "freshness" strategy has no timeout of its own, so on a weak connection
 *    the app would otherwise wait as long as the browser does.
 *
 * Listeners run in the order they were added, so this one runs before Angular's.
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

importScripts('./ngsw-worker.js');
