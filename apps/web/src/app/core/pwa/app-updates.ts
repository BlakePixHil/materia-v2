import { DestroyRef, DOCUMENT, inject, Injectable, InjectionToken, Injector } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

import { DataLifecycle } from '@materia/data-access';
import { CLIENT_COMPAT_VERSION } from '@materia/domain';
import { DialogService, ToastService, type MtToastRef } from '@materia/ui';

import { CALLABLES } from '../data/callables';

/** How often an open app looks for a new version and checks it can still talk to the API. */
export const UPDATE_CHECK_MS = 30 * 60_000;
/** The first check waits until the app has settled. */
export const FIRST_CHECK_MS = 60_000;
/** How long a reload waits for offline edits to reach the server first. */
export const SYNC_BEFORE_RELOAD_MS = 10_000;
/** Tabs of the app tell each other to reload on this channel, so they all move to the new version. */
export const UPDATE_CHANNEL = 'materia-app-updates';

/** Reloads the page; tests replace it. */
export const PAGE_RELOAD = new InjectionToken<() => void>('PAGE_RELOAD', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return () => view?.location.reload();
  },
});

export const UPDATE_COPY = {
  ready: 'New version available',
  readyDescription: 'Reload to start using it. Anything you’ve saved stays as it is.',
  reload: 'Reload',
  compatTitle: 'Reload to keep working',
  compatBody:
    'Materia has been updated, and this copy is too old to keep saving reliably. Save anything you’re in the middle of, then reload.',
  compatConfirm: 'Reload now',
  compatCancel: 'Save my work first',
  compatToast: 'Reload Materia when you’ve saved your work',
} as const;

interface PingResult {
  minClientVersion?: number;
}

/**
 * Keeps an open app current (MOB-01), so nobody is stuck on an old build after a deploy:
 * - a new version, once the service worker has it: a "New version available" toast with Reload;
 * - an API that has moved past this build (`system-ping`'s `minClientVersion` above
 *   `CLIENT_COMPAT_VERSION`): a dialog asking the person to save their work and reload;
 * - a service worker that can't serve this version any more (`unrecoverable`): unregister it and
 *   reload.
 * It checks once the app has settled, every 30 minutes while the page is visible, and on coming
 * back to a tab that hasn't checked for that long. A reload in one tab reloads the others too
 * (`BroadcastChannel`), so they all move to the same version. Reloads wait for offline edits to
 * sync first, up to `SYNC_BEFORE_RELOAD_MS`.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly sw = inject(SwUpdate);
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly data = inject(DataLifecycle);
  private readonly injector = inject(Injector);
  private readonly reloadPage = inject(PAGE_RELOAD);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  private started = false;
  private lastCheck = 0;
  private channel: BroadcastChannel | null = null;
  private readyToast: MtToastRef | null = null;
  private compatAsked = false;
  private reloading = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(UPDATE_CHANNEL);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if ((event.data as { type?: unknown } | null)?.type === 'reload') void this.reload({ broadcast: false });
      };
      this.channel = channel;
      this.destroyRef.onDestroy(() => channel.close());
    }

    if (this.sw.isEnabled) {
      const versions = this.sw.versionUpdates.subscribe((event) => {
        if (event.type === 'VERSION_READY') this.offerReload();
      });
      const broken = this.sw.unrecoverable.subscribe(() => void this.recover());
      this.destroyRef.onDestroy(() => {
        versions.unsubscribe();
        broken.unsubscribe();
      });
    }

    const visible = () => this.document.visibilityState !== 'hidden';
    const first = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    const every = setInterval(() => {
      if (visible()) void this.check();
    }, UPDATE_CHECK_MS);
    const onVisible = () => {
      if (visible() && this.lastCheck && Date.now() - this.lastCheck >= UPDATE_CHECK_MS) void this.check();
    };
    this.document.addEventListener('visibilitychange', onVisible);
    this.destroyRef.onDestroy(() => {
      clearTimeout(first);
      clearInterval(every);
      this.document.removeEventListener('visibilitychange', onVisible);
    });
  }

  /** Looks for a new version and checks this build against the API. Offline, it waits for the next check. */
  async check(): Promise<void> {
    this.lastCheck = Date.now();
    if (globalThis.navigator?.onLine === false) return;
    await Promise.allSettled([
      this.sw.isEnabled ? this.sw.checkForUpdate() : Promise.resolve(false),
      this.checkCompat(),
    ]);
  }

  /**
   * Reloads into the newest version: activates it in the service worker, tells the other tabs,
   * waits for offline edits to sync (up to `SYNC_BEFORE_RELOAD_MS`), then reloads.
   */
  async reload(options: { broadcast: boolean } = { broadcast: true }): Promise<void> {
    if (this.reloading) return;
    this.reloading = true;
    if (options.broadcast) this.channel?.postMessage({ type: 'reload' });
    if (this.sw.isEnabled) await this.sw.activateUpdate().catch(() => false);
    await this.waitForSync();
    this.reloadPage();
  }

  private offerReload(): void {
    if (this.readyToast || this.reloading) return;
    this.readyToast = this.toasts.show({
      title: UPDATE_COPY.ready,
      description: UPDATE_COPY.readyDescription,
      duration: 0,
      action: { label: UPDATE_COPY.reload, run: () => void this.reload() },
    });
  }

  private async checkCompat(): Promise<void> {
    if (this.compatAsked) return;
    const result = await this.injector.get(CALLABLES).call<object, PingResult>('system-ping', {});
    if (typeof result?.minClientVersion !== 'number' || result.minClientVersion <= CLIENT_COMPAT_VERSION) return;
    this.compatAsked = true;
    this.readyToast?.dismiss();
    const now = await this.dialogs.confirm({
      title: UPDATE_COPY.compatTitle,
      body: UPDATE_COPY.compatBody,
      confirmLabel: UPDATE_COPY.compatConfirm,
      cancelLabel: UPDATE_COPY.compatCancel,
    });
    if (now) {
      await this.reload();
      return;
    }
    this.toasts.show({
      title: UPDATE_COPY.compatToast,
      duration: 0,
      action: { label: UPDATE_COPY.reload, run: () => void this.reload() },
    });
  }

  /** The service worker can't serve this version (its files are gone): start again without it. */
  private async recover(): Promise<void> {
    const container = globalThis.navigator?.serviceWorker;
    const registrations = await container?.getRegistrations().catch(() => []);
    await Promise.all((registrations ?? []).map((registration) => registration.unregister().catch(() => false)));
    await this.reload({ broadcast: false });
  }

  private async waitForSync(): Promise<void> {
    if (!(await this.data.hasUnsyncedChanges().catch(() => false))) return;
    await Promise.race([
      this.data.waitForSync().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SYNC_BEFORE_RELOAD_MS)),
    ]);
  }
}
