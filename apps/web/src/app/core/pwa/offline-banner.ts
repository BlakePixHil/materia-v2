import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  Directive,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';

import { MtIcon, ToastService } from '@materia/ui';

import { SyncStatus } from './sync-status';

export const OFFLINE_COPY = {
  lead: 'You’re offline.',
  body: 'Changes save on this device and sync when you reconnect.',
  backOnline: 'Back online',
} as const;

/** How many page-level offline notes are on screen. */
@Injectable({ providedIn: 'root' })
export class PageOfflineNotes {
  readonly count = signal(0);
}

/**
 * Marks a page's own offline note ("You’re offline. These are the matters as they were…"): while
 * one is on screen the shell's banner stays away, so the page doesn't say it twice.
 */
@Directive({ selector: '[mtPageOfflineNote]' })
export class MtPageOfflineNote {
  constructor() {
    const notes = inject(PageOfflineNotes);
    notes.count.update((n) => n + 1);
    inject(DestroyRef).onDestroy(() => notes.count.update((n) => n - 1));
  }
}

/**
 * The offline Banner under the top bar (MOB-01, the Banner spec): after 3 seconds offline, or when
 * no live read has reached the server for 10, and not while the page shows its own offline note.
 * It clears on reconnect with a "Back online" toast.
 */
@Component({
  selector: 'mt-offline-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/banner.css'],
  imports: [MtIcon],
  host: { style: 'display: contents' },
  template: `
    @if (shown()) {
      <div class="mt-banner" data-tone="warning" role="status" data-offline-banner>
        <mt-icon name="wifi-off" />
        <span class="mt-grow"
          ><b>{{ copy.lead }}</b> {{ copy.body }}</span
        >
      </div>
    }
  `,
})
export class MtOfflineBanner {
  private readonly status = inject(SyncStatus);
  private readonly notes = inject(PageOfflineNotes);
  protected readonly copy = OFFLINE_COPY;
  protected readonly shown = computed(() => this.status.offline() && this.notes.count() === 0);

  constructor() {
    const toasts = inject(ToastService);
    let wasOffline = false;
    effect(() => {
      const offline = this.status.offline();
      if (wasOffline && !offline) untracked(() => toasts.show({ title: OFFLINE_COPY.backOnline, tone: 'success' }));
      wasOffline = offline;
    });
  }
}
