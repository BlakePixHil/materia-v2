import { effect, inject, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * `?do=` intents (CORE-15): a command that acts on another page (⌘K's "Add task" on a matter, "New
 * contact" from anywhere) navigates there with `?do=<intent>`, and the page that hosts the action
 * runs it. One mechanism serves the open matter's commands and a search result's sub-commands, and
 * the link works in a new tab too.
 */
export const INTENT_PARAM = 'do';

export type Intent =
  | 'add-task'
  | 'add-deadline'
  | 'record-event'
  | 'upload'
  | 'close'
  | 'new-contact'
  | 'log-time'
  // A matter's Notes tab with the editor ready (the phone's Record tab and matter actions, MOB-02).
  | 'add-note'
  // Quick time entry over whatever page is open: the installed app's shortcut (MOB-01).
  | 'new-time-entry';

/** A URL with an intent (`/matters/m1/tasks?do=add-task`). */
export function intentUrl(path: string, intent: Intent): string {
  return `${path}?${INTENT_PARAM}=${intent}`;
}

/**
 * Runs `handler` once the route's `?do=` names `intent` and `ready()` holds (the page has loaded
 * what the action needs). The parameter is removed in place first, so Back or a reload doesn't run
 * it again, and the handler runs after that navigation: navigating closes open dialogs, and the
 * handler usually opens one. Call in an injection context.
 */
export function onIntent(intent: Intent, handler: () => void, ready: () => boolean = () => true): void {
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const params = toSignal(route.queryParamMap, { initialValue: route.snapshot.queryParamMap });
  let pending = false;
  effect(() => {
    if (pending || params().get(INTENT_PARAM) !== intent || !ready()) return;
    pending = true;
    untracked(() => {
      void router
        .navigate([], {
          relativeTo: route,
          queryParams: { [INTENT_PARAM]: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        })
        .then((done) => done && handler())
        .finally(() => (pending = false));
    });
  });
}
