import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';

import { SyncStatus } from './sync-status';

/**
 * "Pending sync" in the top bar (MOB-01): how many documents hold changes saved on this device that
 * haven't reached the server yet. Shown while offline, or online when a change takes more than a
 * moment to sync.
 */
@Component({
  selector: 'mt-pending-sync',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/badge.css'],
  host: { style: 'display: contents' },
  template: `
    @if (status.showPending()) {
      <span class="mt-badge" data-tone="warning" role="status" [attr.title]="hint()" data-pending-sync>
        <span class="mt-pending-sync-label">{{ label() }}</span>
        <span class="mt-pending-sync-count" aria-hidden="true">{{ status.pending() }}</span>
      </span>
    }
  `,
  // On a phone the top bar is narrow: the count alone, with the label kept for screen readers.
  styles: `
    .mt-pending-sync-count {
      display: none;
    }
    @media (max-width: 767px) {
      .mt-pending-sync-label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      .mt-pending-sync-count {
        display: inline;
      }
    }
  `,
})
export class MtPendingSync {
  protected readonly status = inject(SyncStatus);
  protected readonly label = computed(() => {
    const n = this.status.pending();
    return `${n} ${n === 1 ? 'change' : 'changes'} to sync`;
  });
  protected readonly hint = computed(() =>
    this.status.online()
      ? 'Saved on this device. Syncing with Materia…'
      : 'Saved on this device. They sync when you’re back online.',
  );
}
