import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** Whether the browser thinks it's online, as a signal (for the offline states). */
@Injectable({ providedIn: 'root' })
export class Connectivity {
  private readonly state = signal(globalThis.navigator?.onLine ?? true);
  readonly online = this.state.asReadonly();

  constructor() {
    const win = globalThis.window as Window | undefined;
    if (!win?.addEventListener) return;
    const update = () => this.state.set(globalThis.navigator?.onLine ?? true);
    win.addEventListener('online', update);
    win.addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      win.removeEventListener('online', update);
      win.removeEventListener('offline', update);
    });
  }
}
