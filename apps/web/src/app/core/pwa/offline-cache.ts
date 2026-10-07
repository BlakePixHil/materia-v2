import { DOCUMENT, inject, Injectable } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/** Files the app shell is made of, worth having for an offline start. */
const SHELL_FILE = /\.(?:js|css|woff2)$/;

/**
 * Fills the service worker's cache on the first visit (MOB-01), so the app starts offline after
 * one visit. The worker installs after the first page has loaded, so it never saw the files that
 * page fetched: once it takes control, the same files are fetched again through it (from the HTTP
 * cache, so nothing downloads twice). Later visits load through the worker, which caches what
 * they fetch as they go.
 */
@Injectable({ providedIn: 'root' })
export class OfflineCache {
  private readonly sw = inject(SwUpdate);
  private readonly view = inject(DOCUMENT).defaultView;
  private started = false;

  start(): void {
    const container = this.view?.navigator.serviceWorker;
    if (this.started || !this.sw.isEnabled || !container || container.controller) return;
    this.started = true;
    container.addEventListener('controllerchange', () => void this.warm(), { once: true });
  }

  /** Same-origin scripts, styles and fonts this page has loaded. */
  shellFiles(): string[] {
    const view = this.view;
    if (!view?.performance?.getEntriesByType) return [];
    const files = new Set<string>();
    for (const entry of view.performance.getEntriesByType('resource')) {
      const url = new URL(entry.name, view.location.href);
      if (url.origin === view.location.origin && SHELL_FILE.test(url.pathname)) files.add(url.pathname);
    }
    return [...files];
  }

  private async warm(): Promise<void> {
    const view = this.view;
    if (!view) return;
    await Promise.allSettled(this.shellFiles().map((file) => view.fetch(file)));
  }
}
