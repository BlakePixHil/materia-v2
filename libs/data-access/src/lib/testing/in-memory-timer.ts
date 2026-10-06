import type { TimerPatch, TimerPort, TimerSnapshot, TimerStart, TimerStartOutcome, TimerState } from '../timer';

/**
 * An in-memory `TimerPort` for tests (BILL-02): one timer per uid, applied at once, with the
 * device's clock (`now`) standing in for the server's.
 */
export class InMemoryTimerPort implements TimerPort {
  private readonly timers = new Map<string, TimerState>();
  private readonly listeners = new Map<string, Set<(snapshot: TimerSnapshot) => void>>();
  /** Every write, in order, for assertions. */
  readonly writes: { op: 'start' | 'update' | 'discard'; uid: string; data?: unknown }[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The stored timer (a copy). */
  get(uid: string): TimerState | null {
    const timer = this.timers.get(uid);
    return timer ? { ...timer } : null;
  }

  /** Seeds (or clears) a timer, notifying listeners. */
  seed(uid: string, timer: TimerState | null): void {
    if (timer) this.timers.set(uid, { ...timer });
    else this.timers.delete(uid);
    this.emit(uid);
  }

  watch(uid: string, next: (snapshot: TimerSnapshot) => void): () => void {
    const set = this.listeners.get(uid) ?? new Set();
    this.listeners.set(uid, set);
    set.add(next);
    queueMicrotask(() => {
      if (set.has(next)) next(this.snapshot(uid));
    });
    return () => set.delete(next);
  }

  async start(uid: string, start: TimerStart, options: { offline: boolean; now: Date }): Promise<TimerStartOutcome> {
    const current = this.get(uid);
    if (current) return { started: false, current };
    const at = options.offline ? options.now : this.now();
    this.writes.push({ op: 'start', uid, data: { ...start, offline: options.offline } });
    this.seed(uid, {
      orgId: start.orgId,
      matterId: start.matterId,
      matterNumber: start.matterNumber,
      taskId: start.taskId,
      startedAt: at,
      accumulatedMs: 0,
      running: true,
      narrativeDraft: start.narrativeDraft ?? '',
      lastHeartbeatAt: this.now(),
      clientStarted: options.offline,
    });
    return { started: true };
  }

  async update(uid: string, patch: TimerPatch): Promise<void> {
    const current = this.timers.get(uid);
    if (!current) throw new Error('No timer');
    this.writes.push({ op: 'update', uid, data: patch });
    const now = this.now();
    const { startedAt, forgottenSeenAt, ...rest } = patch;
    this.seed(uid, {
      ...current,
      ...rest,
      ...(startedAt ? { startedAt: startedAt === 'server' ? now : startedAt } : {}),
      ...(forgottenSeenAt ? { forgottenSeenAt: now } : {}),
      lastHeartbeatAt: now,
    });
  }

  async discard(uid: string): Promise<void> {
    this.writes.push({ op: 'discard', uid });
    this.seed(uid, null);
  }

  private snapshot(uid: string): TimerSnapshot {
    return { timer: this.get(uid), pending: false, fromCache: false };
  }

  private emit(uid: string): void {
    for (const listener of this.listeners.get(uid) ?? []) listener(this.snapshot(uid));
  }
}
