import { DestroyRef, inject, type Signal } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';

import { DialogService } from '@materia/ui';

/** A page with a form that can have unsaved edits (CORE-21). */
export interface HasUnsavedChanges {
  /** True while the form differs from what is saved. */
  readonly unsaved: Signal<boolean>;
}

/** Leaving a page with unsaved edits asks first. */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = async (page) => {
  if (!page.unsaved()) return true;
  return inject(DialogService).confirm({
    title: 'Discard your changes?',
    body: 'You have changes on this page that aren’t saved.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    tone: 'danger',
  });
};

/**
 * Closing the tab or reloading with unsaved edits asks the browser's own question. Call in the
 * page's constructor.
 */
export function warnBeforeUnload(unsaved: Signal<boolean>): void {
  const listener = (event: BeforeUnloadEvent) => {
    if (!unsaved()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  globalThis.addEventListener?.('beforeunload', listener);
  inject(DestroyRef).onDestroy(() => globalThis.removeEventListener?.('beforeunload', listener));
}
