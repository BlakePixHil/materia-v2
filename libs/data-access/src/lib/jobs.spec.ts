import { TestBed } from '@angular/core/testing';

import { firestoreJobSource, toJobView } from './jobs';
import { ListenerRegistry } from './listener-registry';

describe('toJobView', () => {
  it('reads a job document with safe defaults', () => {
    expect(toJobView(undefined)).toBeNull();
    expect(toJobView({})).toEqual({ status: 'queued', progress: { done: 0, total: 0 }, warnings: [] });
    expect(
      toJobView({
        status: 'failed',
        progress: { done: 2, total: 5, stage: 'merging' },
        error: { code: 'PDF_ENCRYPTED', message: 'x', retryable: false, inputIndex: 1 },
        warnings: [],
        output: { storagePath: 'orgs/o/exports/j.pdf', pages: 3 },
        input: { secret: 'ignored' },
      }),
    ).toEqual({
      status: 'failed',
      progress: { done: 2, total: 5, stage: 'merging' },
      error: { code: 'PDF_ENCRYPTED', message: 'x', retryable: false, inputIndex: 1 },
      warnings: [],
      output: { storagePath: 'orgs/o/exports/j.pdf', pages: 3 },
    });
  });
});

/** A fake full-SDK Firestore with one document listener at a time. */
function fakeFirestore() {
  const state = {
    path: null as string | null,
    next: null as ((snap: unknown) => void) | null,
    error: null as ((e: unknown) => void) | null,
  };
  const sdk = {
    doc: (_db: unknown, ...path: string[]) => path.join('/'),
    onSnapshot: (path: string, next: (snap: unknown) => void, error: (e: unknown) => void) => {
      Object.assign(state, { path, next, error });
      return () => Object.assign(state, { path: null, next: null, error: null });
    },
  };
  const emit = (data: Record<string, unknown> | undefined) => state.next?.({ data: () => data });
  return { source: { get: async () => ({ sdk, db: {} }) as never }, state, emit };
}

describe('firestoreJobSource', () => {
  it('reports changes only, and stops listening once the job finishes', async () => {
    const fs = fakeFirestore();
    const registry = TestBed.inject(ListenerRegistry);
    const next = vi.fn();
    firestoreJobSource(fs.source, registry).watch('o', 'j', next, vi.fn());
    expect(registry.labels()).toEqual(['orgs/o/jobs/j']);
    await vi.waitFor(() => expect(fs.state.path).toBe('orgs/o/jobs/j'));
    fs.emit({ status: 'queued' });
    fs.emit({ status: 'queued' });
    fs.emit({ status: 'running', progress: { done: 1, total: 2 } });
    fs.emit({ status: 'succeeded' });
    expect(next.mock.calls.map(([job]) => job?.status)).toEqual(['queued', 'running', 'succeeded']);
    expect(fs.state.path).toBeNull();
    expect(registry.active()).toBe(0);
  });

  it('reports a refused read and stops', async () => {
    const fs = fakeFirestore();
    const registry = TestBed.inject(ListenerRegistry);
    const error = vi.fn();
    firestoreJobSource(fs.source, registry).watch('o', 'j', vi.fn(), error);
    await vi.waitFor(() => expect(fs.state.error).not.toBeNull());
    const denied = { code: 'permission-denied' };
    fs.state.error?.(denied);
    expect(error).toHaveBeenCalledWith(denied);
    expect(registry.active()).toBe(0);
  });

  it('stops when unsubscribed or on an org switch, and never attaches after an early stop', async () => {
    const fs = fakeFirestore();
    const registry = TestBed.inject(ListenerRegistry);
    const source = firestoreJobSource(fs.source, registry);
    const next = vi.fn();
    source.watch('o', 'j', next, vi.fn());
    await vi.waitFor(() => expect(fs.state.path).not.toBeNull());
    registry.stopAll();
    expect(fs.state.path).toBeNull();

    source.watch('o', 'j2', next, vi.fn())();
    await new Promise((resolve) => setTimeout(resolve));
    expect(fs.state.path).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it('reports a failure to load Firestore', async () => {
    const error = vi.fn();
    firestoreJobSource({ get: () => Promise.reject(new Error('offline')) }, TestBed.inject(ListenerRegistry)).watch(
      'o',
      'j',
      vi.fn(),
      error,
    );
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
  });
});
