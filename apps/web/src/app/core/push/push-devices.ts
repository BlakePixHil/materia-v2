import { computed, inject, Injectable, signal } from '@angular/core';

import { OrgContext } from '@materia/data-access';
import { myDevicesRepository } from '@materia/data-access/repository';

import { PUSH_PLATFORM } from './push-platform';

/**
 * Push on this browser, for the signed-in person (MOB-04):
 * `on`, `off`, `denied` (blocked in the browser: Materia never asks again), `install` (an iPhone or
 * iPad in Safari: install Materia first) or `unsupported`.
 */
export type PushStatus = 'on' | 'off' | 'denied' | 'install' | 'unsupported';

/** What `enable()` ended with: the browser's prompt can be dismissed without an answer. */
export type EnableOutcome = 'on' | 'denied' | 'dismissed';

/** The token and `lastSeenAt` are refreshed at most this often. */
export const PUSH_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * This browser as one of the person's push devices (`users/{uid}/devices/{deviceId}`, MOB-04).
 * Turning it on asks for the browser's permission (only from a button, after Materia has said why),
 * gets an FCM token on Materia's service worker and registers the device. On start, a device that
 * is on refreshes its token and last-seen date at most daily, and forgets itself when it was
 * removed elsewhere or the permission was taken away. Sign-out deletes it.
 */
@Injectable({ providedIn: 'root' })
export class PushDevices {
  private readonly platform = inject(PUSH_PLATFORM);
  private readonly context = inject(OrgContext);
  private readonly devices = myDevicesRepository();
  private readonly permission = signal(this.platform.permission());
  /** This browser's device id, once registered for the signed-in person. */
  private readonly registered = signal<string | null>(null);
  private loading: Promise<void> | undefined;
  private readonly settled = signal(false);

  /** This browser's device id (for "This device" in Settings), once read. */
  readonly deviceId = signal<string | null>(null);
  readonly busy = signal(false);
  readonly status = computed<PushStatus>(() => {
    const support = this.platform.support();
    if (support !== 'ok') return support;
    if (this.permission() === 'denied') return 'denied';
    return this.permission() === 'granted' && this.registered() ? 'on' : 'off';
  });

  /**
   * The first `load` has finished, read or not: `status` can be trusted. A screen that shows the
   * offer can wait for it, so the offer is drawn with the screen rather than pushing it down after.
   */
  readonly loaded = this.settled.asReadonly();

  /** Reads this browser's registration once; `status` is `off` until it has. */
  load(): Promise<void> {
    return (this.loading ??= this.read()
      .catch(() => {
        this.loading = undefined;
      })
      .finally(() => this.settled.set(true)));
  }

  /**
   * Asks the browser for permission, then registers this device. Call it from a button: browsers
   * only show their prompt for a click, and Materia explains first.
   */
  async enable(): Promise<EnableOutcome> {
    const uid = this.context.uid();
    if (!uid) throw new Error('Sign in to get notifications');
    this.busy.set(true);
    try {
      const permission = await this.platform.requestPermission();
      this.permission.set(permission);
      if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'dismissed';
      const id = await this.platform.store.deviceId();
      this.deviceId.set(id);
      const token = await this.platform.token();
      await this.write(id, token);
      await this.platform.store.save({ uid, token, refreshedAt: Date.now() });
      this.registered.set(id);
      return 'on';
    } finally {
      this.busy.set(false);
    }
  }

  /** Stops pushes to this browser: deletes the device and unsubscribes. */
  async disable(): Promise<void> {
    this.busy.set(true);
    try {
      const id = await this.platform.store.deviceId();
      await this.devices.hardDelete(id);
      await this.forget();
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * On start: refreshes the token and `lastSeenAt` at most daily (devices unseen for 60 days are
   * deleted by the server), or forgets the registration when the device was removed elsewhere or
   * the browser no longer allows notifications.
   */
  async refresh(now = Date.now()): Promise<void> {
    if (this.platform.support() !== 'ok') return;
    await this.load();
    const record = await this.platform.store.read();
    const uid = this.context.uid();
    if (!record || !uid || record.uid !== uid) return;
    const id = await this.platform.store.deviceId();
    if (this.platform.permission() !== 'granted') {
      await this.devices.hardDelete(id).catch(() => undefined);
      await this.forget();
      return;
    }
    if (now - record.refreshedAt < PUSH_REFRESH_MS) return;
    if (!(await this.devices.get(id))) {
      await this.forget();
      return;
    }
    const token = await this.platform.token();
    await this.write(id, token);
    await this.platform.store.save({ uid, token, refreshedAt: now });
  }

  /** Sign-out: this browser stops getting the person's pushes. Never throws. */
  async signOut(): Promise<void> {
    try {
      const record = await this.platform.store.read();
      if (!record) return;
      const id = await this.platform.store.deviceId();
      if (record.uid === this.context.uid()) await this.devices.hardDelete(id).catch(() => undefined);
      await this.forget();
    } catch {
      // Sign-out goes ahead; the server prunes a device it can no longer reach.
    }
  }

  private async read(): Promise<void> {
    if (this.platform.support() !== 'ok') return;
    const [id, record] = await Promise.all([this.platform.store.deviceId(), this.platform.store.read()]);
    this.deviceId.set(id);
    this.registered.set(record && record.uid === this.context.uid() ? id : null);
  }

  private async write(id: string, token: string): Promise<void> {
    const { platform, label } = this.platform.describe();
    if (await this.devices.get(id)) {
      await this.devices.update(id, { token, platform, label }, { stamp: ['lastSeenAt'] });
    } else {
      await this.devices.create({ token, platform, label, lastSeenAt: new Date() }, { id });
    }
  }

  private async forget(): Promise<void> {
    this.registered.set(null);
    await this.platform.unsubscribe().catch(() => undefined);
    await this.platform.store.clear();
  }
}
