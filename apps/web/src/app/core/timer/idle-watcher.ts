/**
 * Idle detection for the running timer (BILL-02), loaded only while a timer runs. Where the Idle
 * Detection API is available and the person has already allowed it (Chrome's "idle-detection"
 * permission; this never asks), it reports the whole device going idle, so time spent in another
 * app isn't mistaken for idleness. Otherwise only input in the app counts: keys, pointer, wheel and
 * touch. Either way, once there has been nothing for `thresholdMs`, `onIdle` gets when it began.
 */
export interface IdleWatchOptions {
  thresholdMs: number;
  /** The device clock. */
  now: () => number;
  /** Idle since this device time; called once per idle spell. */
  onIdle: (sinceMs: number) => void;
  /** How often in-app activity is checked. */
  checkEveryMs?: number;
  /** For tests: the window and the Idle Detection API. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'> & { document?: Document };
  idleDetector?: IdleDetectorLike | null;
}

/** The parts of `IdleDetector` used (it isn't in TypeScript's DOM library yet). */
export interface IdleDetectorLike {
  start(options: { threshold: number; signal: AbortSignal }): Promise<void>;
  addEventListener(type: 'change', listener: () => void): void;
  readonly userState: 'active' | 'idle' | null;
  readonly screenState: 'locked' | 'unlocked' | null;
}

const ACTIVITY = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart', 'focus'] as const;

/** The Idle Detection API, when it exists and is already permitted (null otherwise). */
async function permittedDetector(): Promise<IdleDetectorLike | null> {
  const Detector = (globalThis as { IdleDetector?: new () => IdleDetectorLike }).IdleDetector;
  if (!Detector) return null;
  try {
    const status = await globalThis.navigator?.permissions?.query({ name: 'idle-detection' as PermissionName });
    return status?.state === 'granted' ? new Detector() : null;
  } catch {
    return null;
  }
}

/** Starts watching; returns the function that stops it. */
export function watchIdle(options: IdleWatchOptions): () => void {
  const target = options.target ?? globalThis.window;
  const every = options.checkEveryMs ?? 15_000;
  let lastActivity = options.now();
  let reported = false;
  let stopped = false;
  const abort = new AbortController();

  const activity = () => {
    lastActivity = options.now();
    reported = false;
  };
  const check = () => {
    if (stopped || reported) return;
    if (options.now() - lastActivity >= options.thresholdMs) {
      reported = true;
      options.onIdle(lastActivity);
    }
  };

  // In-app activity, until (unless) the Idle Detection API takes over.
  const listen = () => {
    for (const type of ACTIVITY) target?.addEventListener(type, activity, { passive: true, capture: true });
    target?.document?.addEventListener('visibilitychange', check);
  };
  const unlisten = () => {
    for (const type of ACTIVITY) target?.removeEventListener(type, activity, { capture: true });
    target?.document?.removeEventListener('visibilitychange', check);
  };
  listen();
  const timer = setInterval(check, every);

  const detector = options.idleDetector === undefined ? permittedDetector() : Promise.resolve(options.idleDetector);
  void detector.then(async (idle) => {
    if (!idle || stopped) return;
    try {
      await idle.start({ threshold: Math.max(60_000, options.thresholdMs), signal: abort.signal });
    } catch {
      return; // Refused after all: in-app activity stays in charge.
    }
    if (stopped) return;
    unlisten();
    clearInterval(timer);
    idle.addEventListener('change', () => {
      if (stopped) return;
      if (idle.userState === 'idle' || idle.screenState === 'locked') {
        if (!reported) {
          reported = true;
          // "idle" comes a threshold after the last input; a locked screen, as it locks.
          options.onIdle(idle.userState === 'idle' ? options.now() - options.thresholdMs : options.now());
        }
      } else reported = false;
    });
  });

  return () => {
    stopped = true;
    abort.abort();
    unlisten();
    clearInterval(timer);
  };
}
