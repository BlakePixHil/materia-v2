import { computed, DestroyRef, effect, inject, Injectable, InjectionToken, signal } from '@angular/core';

import { IDLE_WARNING_SECONDS } from '@materia/domain';
import { DialogService, type MtDialogHandle } from '@materia/ui';

import { AuthState } from './auth-state';
import { SESSION_NOW, SessionPolicy } from './session-policy';

/** The channel tabs share activity and the inactivity sign-out on. */
export const IDLE_CHANNEL = 'materia.session';

/** Activity tells other tabs at most this often. */
export const ACTIVITY_BROADCAST_MS = 5_000;

type IdleMessage = { type: 'activity'; at: number } | { type: 'idle-sign-out' };

/** A BroadcastChannel, or null where there is none (tests replace it). */
export const IDLE_BROADCAST = new InjectionToken<(name: string) => BroadcastChannel | null>('IDLE_BROADCAST', {
  factory: () => (name) => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null),
});

/**
 * Work that must not be cut off by the inactivity sign-out (SEC-04): an upload or a recording
 * holds the session open while it runs. `hold()` returns the release.
 */
@Injectable({ providedIn: 'root' })
export class ActivityHolds {
  private readonly count = signal(0);
  readonly active = computed(() => this.count() > 0);

  hold(): () => void {
    this.count.update((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count.update((n) => n - 1);
    };
  }
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Inactivity sign-out (SEC-04). Counts from the last click, key press, scroll or touch in any tab
 * (tabs share activity over a BroadcastChannel). `IDLE_WARNING_SECONDS` before the org's limit a
 * dialog counts down with "Stay signed in"; at the limit every tab signs out and shows "Signed out
 * due to inactivity". Uploads and recordings (`ActivityHolds`) defer it while they run.
 */
@Injectable({ providedIn: 'root' })
export class IdleTimeout {
  private readonly auth = inject(AuthState);
  private readonly policy = inject(SessionPolicy);
  private readonly holds = inject(ActivityHolds);
  private readonly dialogs = inject(DialogService);
  private readonly clock = inject(SESSION_NOW);
  private readonly openChannel = inject(IDLE_BROADCAST);

  private last = this.clock();
  private lastBroadcast = 0;
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private dialog: MtDialogHandle<boolean> | null = null;
  private opening = false;

  /** Seconds left while the warning shows, else null. */
  readonly secondsLeft = signal<number | null>(null);
  readonly idleMinutes = computed(() => this.policy.policy()?.sessionIdleMinutes ?? null);
  private readonly running = computed(() => this.auth.status() === 'ready' && this.idleMinutes() !== null);

  private readonly onActivity = () => this.activity(this.clock());

  constructor() {
    effect(() => (this.running() ? this.start() : this.stop()));
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Activity in this tab (or "Stay signed in"): resets the count here and tells the other tabs. */
  activity(at: number): void {
    this.last = Math.max(this.last, at);
    if (this.secondsLeft() !== null) this.hideWarning();
    if (at - this.lastBroadcast >= ACTIVITY_BROADCAST_MS) {
      this.lastBroadcast = at;
      this.post({ type: 'activity', at });
    }
  }

  /** Checks the time left; runs every second while signed in. */
  tick(): void {
    const minutes = this.idleMinutes();
    if (minutes === null) return;
    const now = this.clock();
    // An upload or recording keeps the session open, here and in the other tabs.
    if (this.holds.active()) this.activity(now);
    const left = this.last + minutes * 60_000 - now;
    if (left <= 0) {
      this.post({ type: 'idle-sign-out' });
      void this.signOut();
    } else if (left <= IDLE_WARNING_SECONDS * 1000) {
      this.secondsLeft.set(Math.ceil(left / 1000));
      void this.showWarning();
    } else if (this.secondsLeft() !== null) {
      this.hideWarning();
    }
  }

  /** Signs this tab out for inactivity (also when another tab did). */
  async signOut(): Promise<void> {
    this.stop();
    await this.policy.end('idle');
  }

  private start(): void {
    if (this.timer) return;
    this.last = this.clock();
    for (const type of ACTIVITY_EVENTS)
      document.addEventListener(type, this.onActivity, { capture: true, passive: true });
    this.channel = this.openChannel(IDLE_CHANNEL);
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent<IdleMessage>) => {
        const message = event.data;
        if (message?.type === 'activity') {
          this.last = Math.max(this.last, message.at);
          if (this.secondsLeft() !== null) this.hideWarning();
        } else if (message?.type === 'idle-sign-out') {
          void this.signOut();
        }
      };
    }
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, this.onActivity, { capture: true });
    this.channel?.close();
    this.channel = null;
    this.hideWarning();
  }

  private post(message: IdleMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed channel: nothing to tell.
    }
  }

  private async showWarning(): Promise<void> {
    if (this.dialog || this.opening) return;
    this.opening = true;
    try {
      const { IdleWarningDialog } = await import('./idle-warning-dialog');
      if (this.secondsLeft() === null || !this.timer) return;
      const handle = this.dialogs.open<IdleTimeout, boolean>(IdleWarningDialog, {
        data: this,
        closeOnEscape: false,
        closeOnOutsideClick: false,
      });
      this.dialog = handle;
      void handle.result.then((signOutNow) => {
        if (this.dialog === handle) this.dialog = null;
        if (signOutNow === true) {
          this.post({ type: 'idle-sign-out' });
          void this.signOut();
        } else if (this.secondsLeft() !== null) {
          this.activity(this.clock());
        }
      });
    } finally {
      this.opening = false;
    }
  }

  private hideWarning(): void {
    this.secondsLeft.set(null);
    const dialog = this.dialog;
    this.dialog = null;
    dialog?.close(false);
  }
}
