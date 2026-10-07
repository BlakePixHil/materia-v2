import { inject, Injectable } from '@angular/core';

import type { NotificationPrefs } from '@materia/domain';
import { ToastService } from '@materia/ui';

import { PushDevices } from './push-devices';
import { errorCopy } from '../error-copy';
import { UserPrefsService } from '../profile/user-prefs';

/** What a person sees when the browser blocks notifications for Materia (MOB-04). */
export const PUSH_BLOCKED_HELP =
  'To get alerts, allow notifications for Materia in your browser’s site settings (on an iPhone or iPad: Settings → Notifications → Materia), then reload.';

/**
 * Push on, for the preferences too: the push channel itself, and deadline reminders on it unless
 * the person already chose for them. Deadline escalations push by default.
 */
export function pushOnPrefs(notifications: NotificationPrefs): NotificationPrefs {
  const kinds = notifications.kinds ?? {};
  const reminders = kinds['deadline_reminder'] ?? {};
  return {
    ...notifications,
    push: true,
    kinds: { ...kinds, deadline_reminder: { ...reminders, push: reminders.push ?? true } },
  };
}

/**
 * Turning deadline alerts on and off for this device (MOB-04), the same from the offer beside
 * critical deadlines and from Settings → Preferences: the browser's permission, the device, the
 * preferences, and a toast saying what happened.
 */
@Injectable({ providedIn: 'root' })
export class PushSetup {
  private readonly devices = inject(PushDevices);
  private readonly prefs = inject(UserPrefsService);
  private readonly toasts = inject(ToastService);

  /** Whether alerts ended up on. */
  async turnOn(): Promise<boolean> {
    try {
      const outcome = await this.devices.enable();
      if (outcome === 'denied') {
        this.toasts.show({ title: 'Notifications are blocked for Materia', description: PUSH_BLOCKED_HELP });
        return false;
      }
      if (outcome === 'dismissed') return false;
      const notifications = this.prefs.prefs().notifications;
      const next = pushOnPrefs(notifications);
      if (JSON.stringify(next) !== JSON.stringify(notifications)) {
        await this.prefs.save({ notifications: next });
      }
      this.toasts.show({
        title: 'Deadline alerts are on for this device',
        description: 'Change which alerts you get in Settings → Preferences.',
        tone: 'success',
      });
      return true;
    } catch (error) {
      this.toasts.show({ title: 'Alerts didn’t turn on', description: errorCopy(error), tone: 'danger' });
      return false;
    }
  }

  async turnOff(): Promise<void> {
    try {
      await this.devices.disable();
      this.toasts.show({ title: 'This device won’t get push notifications', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Alerts didn’t turn off', description: errorCopy(error), tone: 'danger' });
    }
  }
}
