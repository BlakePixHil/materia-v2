import { DestroyRef, Injectable, signal } from '@angular/core';

export interface ListenerOptions {
  /** Stops the listener when this injector (a component, a route) is destroyed. */
  destroyRef?: DestroyRef;
  /** For debugging: what the listener follows (a path, never data). */
  label?: string;
}

interface Entry {
  stop: () => void;
  label: string;
  detach?: () => void;
}

/**
 * Every Firestore listener in the app (FND-19). Repositories, the tenancy port and the job source
 * add each `onSnapshot` unsubscribe here, so an org switch or a sign-out can stop all of them at
 * once (`stopAll`) and nothing from one org keeps streaming into the next. Listeners tied to a
 * `DestroyRef` stop with their component.
 */
@Injectable({ providedIn: 'root' })
export class ListenerRegistry {
  private readonly entries = new Map<number, Entry>();
  private readonly resets = new Set<() => void>();
  private nextId = 0;
  private readonly activeCount = signal(0);

  /** How many listeners are attached (or attaching) right now. */
  readonly active = this.activeCount.asReadonly();

  /**
   * Tracks a listener. Returns a function that stops it and forgets it; calling it twice is safe.
   * The registry calls `stop` itself on `stopAll` or when `destroyRef` is destroyed.
   */
  add(stop: () => void, options: ListenerOptions = {}): () => void {
    const id = this.nextId++;
    const entry: Entry = { stop, label: options.label ?? 'listener' };
    this.entries.set(id, entry);
    this.activeCount.set(this.entries.size);
    const release = () => this.release(id);
    if (options.destroyRef) {
      try {
        entry.detach = options.destroyRef.onDestroy(release);
      } catch {
        // Already destroyed: the listener must not outlive it.
        release();
      }
    }
    return release;
  }

  /** The labels of the attached listeners (for tests and debugging). */
  labels(): string[] {
    return [...this.entries.values()].map((entry) => entry.label);
  }

  /** Registers a store reset to run on `stopAll` (an org switch or sign-out). Returns the unregister. */
  onReset(reset: () => void): () => void {
    this.resets.add(reset);
    return () => this.resets.delete(reset);
  }

  /** Stops every listener and resets every store: for an org switch and for sign-out. */
  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.release(id);
    for (const reset of [...this.resets]) {
      try {
        reset();
      } catch {
        // One failing reset must not keep data from the previous org on screen.
      }
    }
  }

  private release(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.activeCount.set(this.entries.size);
    entry.detach?.();
    try {
      entry.stop();
    } catch {
      // The SDK may already have torn the listener down (terminate, sign-out in another tab).
    }
  }
}
