import { computed, DestroyRef, effect, inject, Injectable, InjectionToken, signal, untracked } from '@angular/core';

import {
  Connectivity,
  OrgContext,
  TIMER_PORT,
  timerCallables,
  type TimerPatch,
  type TimerSnapshot,
  type TimerState,
} from '@materia/data-access';
import {
  can,
  estimateServerOffset,
  needsSkewReview,
  pausePatch,
  TIMER_IDLE_MINUTES,
  timerElapsedMs,
  withoutIdle,
} from '@materia/domain';
import { DialogService, ToastService } from '@materia/ui';

import { CALLABLES } from '../data/callables';
import { errorCopy } from '../error-copy';

/** What a timer starts on. */
export interface TimerTarget {
  matterId: string;
  matterNumber: string;
  taskId?: string | undefined;
}

/** How long without input in the app, while the timer runs, before asking about idle time (BILL-02). */
export const TIMER_IDLE_MS = new InjectionToken<number>('TIMER_IDLE_MS', {
  providedIn: 'root',
  factory: () => TIMER_IDLE_MINUTES * 60_000,
});

/** How often a running timer's devices re-measure their clock against the server's. */
export const TIMER_HEARTBEAT_MS = 10 * 60_000;

/**
 * The global timer (BILL-02), for the shell and every place that starts one: the live
 * `users/{uid}/timer/current`, the elapsed time (ticking each second while it runs) on the
 * server's clock, and the actions. Each device measures its clock's offset from the server's from
 * its own writes (every write stamps `lastHeartbeatAt` with the server time; a heartbeat on load
 * and every 10 minutes while running), so a timer started on a laptop shows the same time on a
 * phone. The dialogs (switching, idle time, saving) load on first use.
 */
@Injectable({ providedIn: 'root' })
export class TimerStore {
  private readonly context = inject(OrgContext);
  private readonly online = inject(Connectivity).online;
  private readonly port = inject(TIMER_PORT);
  private readonly callables = timerCallables(inject(CALLABLES));
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  /** The device clock (tests replace it). */
  now: () => number = () => Date.now();

  private readonly snapshot = signal<TimerSnapshot | null>(null);
  /** The timer, or null when there is none (or before the first answer). */
  readonly timer = computed(() => this.snapshot()?.timer ?? null);
  readonly running = computed(() => !!this.timer()?.running);
  /** The device clock's offset from the server's, once measured (ms to add to `Date.now()`). */
  readonly offsetMs = signal(0);
  private readonly tick = signal(0);
  /** Elapsed time on the server's clock; ticks each second while running. */
  readonly elapsedMs = computed(() => {
    this.tick();
    const timer = this.timer();
    return timer ? timerElapsedMs(timer, this.now(), this.offsetMs()) : 0;
  });
  /** The server flagged the timer as forgotten and the person hasn't dismissed the banner since. */
  readonly forgotten = computed(() => {
    const flag = this.timer()?.forgotten;
    if (!flag) return null;
    const seen = this.timer()?.forgottenSeenAt;
    return seen && seen.getTime() >= flag.at.getTime() ? null : flag;
  });
  /** Whether the person's role records time. */
  readonly canRecord = computed(() => {
    const role = this.context.role();
    return !!role && can(role, 'time.record');
  });

  /** The device time of my last write still waiting for its server time, to measure the offset. */
  private sentAt: number | null = null;
  /** Offline-started timers check the clock once the start reaches the server. */
  private reviewStart = false;
  private beatOnLoad = true;
  private busy = false;
  private idleOpen = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect((onCleanup) => {
      const uid = this.context.uid();
      this.snapshot.set(null);
      this.beatOnLoad = true;
      if (!uid) return;
      const stop = untracked(() =>
        this.port.watch(
          uid,
          (snapshot) => this.received(snapshot),
          () => this.snapshot.set({ timer: null, pending: false, fromCache: true }),
        ),
      );
      onCleanup(stop);
    });

    // Tick each second while running, and re-measure the clock now and then.
    effect((onCleanup) => {
      if (!this.running()) return;
      const ticker = setInterval(() => this.tick.update((n) => n + 1), 1000);
      const beat = setInterval(() => this.heartbeat(), TIMER_HEARTBEAT_MS);
      onCleanup(() => {
        clearInterval(ticker);
        clearInterval(beat);
      });
    });

    // Idle detection runs while the timer does (loaded then: it isn't in the initial bundle).
    const idleMs = inject(TIMER_IDLE_MS);
    effect((onCleanup) => {
      if (!this.running()) return;
      let stopped = false;
      let release: (() => void) | undefined;
      void import('./idle-watcher').then(({ watchIdle }) => {
        if (stopped) return;
        release = watchIdle({ thresholdMs: idleMs, now: () => this.now(), onIdle: (since) => this.idle(since) });
      });
      onCleanup(() => {
        stopped = true;
        release?.();
      });
    });
    destroyRef.onDestroy(() => this.snapshot.set(null));
  }

  /** The server's time now, by this device's clock and offset. */
  serverNow(): number {
    return this.now() + this.offsetMs();
  }

  // ---------- actions ----------

  /**
   * Starts a timer on a matter (the matter header, a task, ⌘K or Shift+T). On the timer's own
   * matter it resumes a paused timer; with another timer running it asks first: stop and save it,
   * or discard it.
   */
  async start(target: TimerTarget): Promise<void> {
    const uid = this.context.uid();
    const orgId = this.context.orgId();
    if (!uid || !orgId || this.busy) return;
    if (!this.canRecord()) {
      this.toasts.show({ title: 'Your role can’t record time', tone: 'danger' });
      return;
    }
    this.busy = true;
    try {
      const current = this.timer();
      if (current) {
        if (current.matterId === target.matterId) {
          if (!current.running) this.resume();
          else this.toasts.show({ title: `The timer is already running on ${current.matterNumber}` });
          return;
        }
        if (!(await this.replace(current, target))) return;
      }
      this.sentAt = this.now();
      const offline = !this.online();
      this.reviewStart = offline;
      const outcome = await this.port.start(
        uid,
        { orgId, matterId: target.matterId, matterNumber: target.matterNumber, taskId: target.taskId },
        { offline, now: new Date(this.now()) },
      );
      if (!outcome.started && outcome.current.matterId !== target.matterId) {
        this.toasts.show({ title: `A timer is already running on ${outcome.current.matterNumber}` });
        return;
      }
      if (outcome.started)
        this.toasts.show({
          title: `Timer started on ${target.matterNumber}`,
          ...(offline ? { description: 'You’re offline: it uses this device’s clock until you reconnect.' } : {}),
        });
    } catch (error) {
      this.toasts.show({ title: 'The timer didn’t start', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy = false;
    }
  }

  /** Shift+T: starts or pauses the timer for the matter that's open. */
  toggle(target: TimerTarget | null): void {
    const current = this.timer();
    if (current && (!target || current.matterId === target.matterId)) {
      if (current.running) this.pause();
      else this.resume();
      return;
    }
    if (target) void this.start(target);
  }

  pause(): void {
    const timer = this.timer();
    if (!timer?.running) return;
    this.write(pausePatch(timer, this.serverNow()));
  }

  resume(): void {
    const timer = this.timer();
    if (!timer || timer.running) return;
    const offline = !this.online();
    this.write({
      running: true,
      ...(offline ? { startedAt: new Date(this.now()), clientStarted: true } : { startedAt: 'server' }),
    });
  }

  /** Pauses the timer and opens the save dialog (rounded units, narrative, billable). */
  async stop(): Promise<void> {
    if (!this.timer()) return;
    this.pause();
    const { openStopTimer } = await import('./timer-dialogs');
    await openStopTimer(this.dialogs);
  }

  /** Switch (or start with no matter open): pick a matter and time it (asking about a running timer). */
  async switchMatter(title?: string): Promise<void> {
    const { pickMatter } = await import('./timer-dialogs');
    const matter = await pickMatter(this.dialogs, title);
    if (matter) await this.start(matter);
  }

  /** Throws the timer away. */
  async discard(): Promise<void> {
    const uid = this.context.uid();
    if (!uid || !this.timer()) return;
    this.port.discard(uid).catch((error: unknown) => this.failed(error));
  }

  /** Saves my timer as draft entries (`time-stopTimer`). */
  save(input: { narrative: string; billable?: boolean; split?: boolean; matterId?: string }) {
    return this.callables.stop({ split: false, ...input });
  }

  /** Keeps the narrative typed so far on the timer (it follows the person to other devices). */
  saveNarrative(text: string): void {
    const timer = this.timer();
    if (!timer || timer.narrativeDraft === text) return;
    this.write({ narrativeDraft: text });
  }

  /** "Keep it running" on the forgotten-timer banner. */
  dismissForgotten(): void {
    if (this.forgotten()) this.write({ forgottenSeenAt: 'server' });
  }

  /**
   * No input since `sinceMs` (this device's clock): asks whether to keep the idle time, discard it
   * (the timer carries on from now) or stop at the time the person went idle.
   */
  async idle(sinceMs: number): Promise<void> {
    if (this.idleOpen || !this.running()) return;
    this.idleOpen = true;
    try {
      const { askIdle } = await import('./timer-dialogs');
      const choice = await askIdle(this.dialogs, new Date(sinceMs));
      const timer = this.timer();
      if (!timer?.running || !choice || choice === 'keep') return;
      const kept = withoutIdle(timer, sinceMs + this.offsetMs());
      if (choice === 'discard') {
        this.write({ ...kept, startedAt: this.online() ? 'server' : new Date(this.now()) });
        return;
      }
      this.write({ ...kept, running: false });
      await this.stop();
    } finally {
      this.idleOpen = false;
    }
  }

  // ---------- internals ----------

  /** Asks how to end the running timer before another starts; false when the person cancels. */
  private async replace(current: TimerState, target: TimerTarget): Promise<boolean> {
    const { askSwitch } = await import('./timer-dialogs');
    const choice = await askSwitch(this.dialogs, {
      from: current.matterNumber,
      to: target.matterNumber,
      elapsedMs: this.elapsedMs(),
    });
    if (choice === 'discard') {
      const uid = this.context.uid();
      if (!uid) return false;
      // Online, the new timer's transaction reads the server, so the delete must be there first.
      // Offline, both writes queue in order.
      const done = this.port.discard(uid);
      if (this.online()) await done;
      else done.catch((error: unknown) => this.failed(error));
      return true;
    }
    if (choice !== 'save') return false;
    try {
      const result = await this.save({ narrative: current.narrativeDraft });
      this.toasts.show({ title: `Saved the time on ${current.matterNumber}`, tone: 'success' });
      return !!result;
    } catch (error) {
      this.toasts.show({ title: 'The timer didn’t save', description: errorCopy(error), tone: 'danger' });
      return false;
    }
  }

  private write(patch: TimerPatch): void {
    const uid = this.context.uid();
    if (!uid) return;
    this.sentAt = this.now();
    this.port.update(uid, patch).catch((error: unknown) => this.failed(error));
  }

  private heartbeat(): void {
    if (this.timer()) this.write({});
  }

  private failed(error: unknown): void {
    this.toasts.show({ title: 'The timer didn’t update', description: errorCopy(error), tone: 'danger' });
  }

  private received(snapshot: TimerSnapshot): void {
    this.snapshot.set(snapshot);
    const timer = snapshot.timer;
    if (!timer || snapshot.pending || snapshot.fromCache) return;
    // My write reached the server: its heartbeat is the server's time, which measures my clock.
    if (this.sentAt !== null && timer.lastHeartbeatAt) {
      const offset = estimateServerOffset(this.sentAt, this.now(), timer.lastHeartbeatAt.getTime());
      this.sentAt = null;
      this.offsetMs.set(offset);
      // Started offline: keep the device's start, but flag it when the clock was well out.
      if (this.reviewStart && timer.clientStarted && timer.needsReview === undefined) {
        this.reviewStart = false;
        this.write({ needsReview: needsSkewReview(offset) });
      }
      return;
    }
    if (this.beatOnLoad) {
      this.beatOnLoad = false;
      this.heartbeat();
    }
  }
}
