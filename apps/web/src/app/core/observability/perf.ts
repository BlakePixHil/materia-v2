/**
 * Firebase Performance Monitoring (FND-21), loaded after the app is idle in deployed builds. The
 * SDK records the page load and Web Vitals (LCP, INP, CLS) itself; `startTrace` adds the custom
 * traces. Traces are timed here and recorded once the SDK has loaded, so starting one costs
 * nothing. When an ad blocker or a failed load stops the SDK, traces are dropped silently.
 */
export type TraceName = 'matter_open' | 'palette_search' | 'clerk_first_token';

type Recorder = (name: TraceName, startTime: number, duration: number) => void;

let recorder: Recorder | null = null;
let pending: [TraceName, number, number][] | null = null;

/** Starts loading the SDK (once). Traces before then are buffered (up to 50). */
export function startPerformanceMonitoring(load: () => Promise<Recorder> = loadSdk): void {
  if (pending) return;
  pending = [];
  load().then(
    (record) => {
      recorder = record;
      try {
        for (const [name, start, duration] of pending ?? []) record(name, start, duration);
      } catch {
        // Monitoring must never break the app.
      }
      pending = [];
    },
    () => (pending = []),
  );
}

/** Starts a custom trace; call the returned function when the thing being measured is done. */
export function startTrace(name: TraceName): () => void {
  const start = Date.now();
  const t0 = performance.now();
  let done = false;
  return () => {
    if (done || !pending) return;
    done = true;
    const duration = Math.max(1, Math.round(performance.now() - t0));
    try {
      if (recorder) recorder(name, start, duration);
      else if (pending.length < 50) pending.push([name, start, duration]);
    } catch {
      // Monitoring must never break the app.
    }
  };
}

async function loadSdk(): Promise<Recorder> {
  const [{ getPerformance, trace }, { firebaseApp }] = await Promise.all([
    import('firebase/performance'),
    import('../firebase-app'),
  ]);
  const perf = getPerformance(firebaseApp());
  return (name, start, duration) => trace(perf, name).record(start, duration);
}

/** Test hook: forget the SDK. */
export function resetPerformanceMonitoring(): void {
  recorder = null;
  pending = null;
}
