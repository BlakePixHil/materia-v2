import { ErrorHandler, Injectable, InjectionToken, inject, Injector } from '@angular/core';

import { ToastService } from '@materia/ui';

/** Where unexpected errors are reported (the app provides FND-21's client error reporter). Must not log personal data. */
export type ErrorReporter = (error: unknown) => void;

export const ERROR_REPORTER = new InjectionToken<ErrorReporter>('ERROR_REPORTER', {
  // Name only: messages can contain data, and logs carry ids only.
  factory: () => (error) => console.error('Unexpected error', error instanceof Error ? error.name : typeof error),
});

/**
 * Global error handler (FND-12): tells the person something went wrong with a toast (at most one per
 * few seconds) and reports the error. The message never includes the error details.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly injector = inject(Injector);
  private lastToastAt = 0;
  /** Injected clock, for tests. */
  now: () => number = () => Date.now();

  handleError(error: unknown): void {
    this.injector.get(ERROR_REPORTER)(error);
    const now = this.now();
    if (now - this.lastToastAt < 4000) return;
    this.lastToastAt = now;
    this.injector.get(ToastService).show({
      tone: 'danger',
      title: 'Something went wrong',
      description: 'Try again. If it keeps happening, reload the page.',
    });
  }
}
