import { watchIdle, type IdleDetectorLike } from './idle-watcher';

/** Idle detection for the running timer (BILL-02), on a fake clock. */

const MIN = 60_000;

function setup(idleDetector: IdleDetectorLike | null = null) {
  vi.useFakeTimers({ now: Date.parse('2026-10-06T10:00:00.000Z') });
  const target = new EventTarget() as EventTarget & { document?: Document };
  const idle: number[] = [];
  const stop = watchIdle({
    thresholdMs: 15 * MIN,
    now: () => Date.now(),
    onIdle: (since) => idle.push(since),
    target: target as never,
    idleDetector,
  });
  return { target, idle, stop };
}

class FakeDetector extends EventTarget implements IdleDetectorLike {
  userState: 'active' | 'idle' | null = 'active';
  screenState: 'locked' | 'unlocked' | null = 'unlocked';
  started: { threshold: number } | null = null;
  async start(options: { threshold: number }) {
    this.started = { threshold: options.threshold };
  }
  set(user: 'active' | 'idle', screen: 'locked' | 'unlocked' = 'unlocked') {
    this.userState = user;
    this.screenState = screen;
    this.dispatchEvent(new Event('change'));
  }
}

describe('watchIdle', () => {
  afterEach(() => vi.useRealTimers());

  it('reports idle time once nothing has happened in the app for the threshold, from the last input', () => {
    const { target, idle, stop } = setup();
    vi.advanceTimersByTime(10 * MIN);
    target.dispatchEvent(new Event('keydown'));
    const lastInput = Date.now();
    vi.advanceTimersByTime(14 * MIN);
    expect(idle).toEqual([]);
    vi.advanceTimersByTime(MIN + 15_000);
    expect(idle).toEqual([lastInput]);
    // Once per idle spell.
    vi.advanceTimersByTime(30 * MIN);
    expect(idle).toHaveLength(1);
    // Input starts a new spell.
    target.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(16 * MIN);
    expect(idle).toHaveLength(2);
    stop();
  });

  it('stops watching when stopped', () => {
    const { idle, stop } = setup();
    stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(idle).toEqual([]);
  });

  it('uses the Idle Detection API when it is permitted', async () => {
    const detector = new FakeDetector();
    const { target, idle, stop } = setup(detector);
    await vi.advanceTimersByTimeAsync(0);
    expect(detector.started).toEqual({ threshold: 15 * MIN });
    // In-app activity no longer counts: time in another app isn't idle.
    vi.advanceTimersByTime(30 * MIN);
    target.dispatchEvent(new Event('keydown'));
    expect(idle).toEqual([]);
    detector.set('idle');
    expect(idle).toEqual([Date.now() - 15 * MIN]);
    detector.set('active');
    vi.advanceTimersByTime(MIN);
    detector.set('active', 'locked');
    expect(idle).toEqual([expect.any(Number), Date.now()]);
    stop();
  });
});
