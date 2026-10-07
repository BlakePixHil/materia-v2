import { DOCUMENT, inject, InjectionToken } from '@angular/core';

import type { DeviceItem } from '@materia/data-access/repository';

import { indexedDbPushStore, type PushStore } from './push-store';
import { environment } from '../../../environments/environment';
import { isIos, isStandalone } from '../pwa/install-prompt';

/**
 * Whether this browser can get web push (MOB-04): `ok`; `install` on an iPhone or iPad in Safari,
 * where push needs Materia added to the Home Screen; or `unsupported`.
 */
export type PushSupport = 'ok' | 'install' | 'unsupported';

/** The browser side of push: permission, the FCM token on Materia's service worker, and this device. */
export interface PushPlatform {
  support(): PushSupport;
  /** The notification permission (`default` where there is none). */
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** This browser's FCM token, subscribing to push on Materia's service worker if needed. */
  token(): Promise<string>;
  /** Unsubscribes this browser from push, so even a device record left behind gets nothing. */
  unsubscribe(): Promise<void>;
  /** What the devices list calls this browser. */
  describe(): Pick<DeviceItem, 'platform' | 'label'>;
  readonly store: PushStore;
}

type BrowserNavigator = Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { platform?: string };

/** `Chrome on macOS`, `Safari on iPhone`, `Materia app on iPhone` (installed), for Settings → Devices. */
export function deviceLabel(navigator: BrowserNavigator, standalone: boolean): string {
  const ua = navigator.userAgent;
  const ios = isIos(navigator);
  const os = ios
    ? /iPad/.test(ua) || !/iPhone|iPod/.test(ua)
      ? 'iPad'
      : 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'this device';
  if (standalone) return `Materia app on ${os}`;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser\//.test(ua)
      ? 'Samsung Internet'
      : /Firefox\/|FxiOS\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  return `${browser} on ${os}`;
}

/** The devices list's platform: iPhone or iPad, Android, or any other browser. */
export function devicePlatform(navigator: BrowserNavigator): DeviceItem['platform'] {
  if (isIos(navigator)) return 'ios';
  return /Android/.test(navigator.userAgent) ? 'android' : 'web';
}

/** How long to wait for Materia's service worker before giving up on turning push on. */
const WORKER_TIMEOUT_MS = 15_000;

/**
 * The browser's push (MOB-04). Firebase Messaging loads only to get a token, on the service worker
 * the app already has (`sw.js`), with FCM's default VAPID key. The emulators have no FCM: there
 * the token is `emulator-{deviceId}`, which the emulator's push outbox accepts.
 */
export function browserPushPlatform(view: Window | null, store = indexedDbPushStore()): PushPlatform {
  const nav = view?.navigator;
  const notifications = (view as (Window & { Notification?: typeof Notification }) | null)?.Notification;
  const worker = async (): Promise<ServiceWorkerRegistration> => {
    const container = nav?.serviceWorker;
    if (!container) throw new Error('This browser can’t get push notifications');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        container.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Materia isn’t ready for notifications yet. Reload the page and try again.')),
            WORKER_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    support() {
      if (!nav) return 'unsupported';
      const ready = !!notifications && 'serviceWorker' in nav && !!view && 'PushManager' in view;
      if (isIos(nav) && !isStandalone(view)) return 'install';
      return ready && typeof view?.indexedDB !== 'undefined' ? 'ok' : 'unsupported';
    },
    permission: () => notifications?.permission ?? 'default',
    requestPermission: async () => (notifications ? notifications.requestPermission() : 'denied'),
    async token() {
      if (environment.useEmulators) return `emulator-${await store.deviceId()}`;
      const [{ getMessaging, getToken }, { firebaseApp }, registration] = await Promise.all([
        import('firebase/messaging'),
        import('../firebase-app'),
        worker(),
      ]);
      return getToken(getMessaging(firebaseApp()), { serviceWorkerRegistration: registration });
    },
    async unsubscribe() {
      if (environment.useEmulators || !nav?.serviceWorker) return;
      const registration = await nav.serviceWorker.getRegistration();
      await (await registration?.pushManager?.getSubscription())?.unsubscribe();
    },
    describe: () =>
      nav
        ? { platform: devicePlatform(nav), label: deviceLabel(nav, isStandalone(view)) }
        : { platform: 'web', label: 'Browser on this device' },
    store,
  };
}

export const PUSH_PLATFORM = new InjectionToken<PushPlatform>('PUSH_PLATFORM', {
  providedIn: 'root',
  factory: () => browserPushPlatform(inject(DOCUMENT).defaultView),
});
