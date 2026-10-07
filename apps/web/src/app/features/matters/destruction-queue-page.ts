import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import {
  DESTRUCTION_QUEUE_QUERY,
  destructionQueueRepository,
  MATTER_CALLABLES,
  type DestructionQueueItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  destructionCertificateId,
  type ApproveDestructionInput,
  type ApproveDestructionResult,
  type DestructionCertificateUrlInput,
  type DestructionCertificateUrlResult,
} from '@materia/domain';
import {
  DialogService,
  formatDateOnly,
  MATTER_TYPE_LABELS,
  MtButton,
  MtEmptyState,
  MtNote,
  MtSettingsSection,
  ToastService,
} from '@materia/ui';

import { MatterNameDialog, type MatterNameDialogData } from './matter-name-dialog';
import { retentionErrorCopy } from './matters-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';

type Entry = WithId<DestructionQueueItem>;

/**
 * The destruction queue (`/matters/destruction`, CORE-19; owners and admins, behind the
 * `matters.destruction` flag). `matters-queueDestruction` lists closed matters past their
 * retention date each month; an admin approves each one by typing its number, after a recent
 * sign-in. `matters-destroy` then deletes the matter's records and files, keeps a tombstone and the
 * audit trail, and issues a certificate, downloaded here.
 */
@Component({
  selector: 'mt-destruction-queue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtEmptyState, MtNote, MtSettingsSection, RouterLink],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <h1 class="title-l" style="margin: 0">Destruction queue</h1>
    @if (!allowed()) {
      <mt-empty-state
        icon="shield"
        title="Owners and admins only"
        description="Only owners and admins review matters for destruction."
        [headingLevel]="2"
      >
        <a mtButton variant="primary" routerLink="/matters">Back to matters</a>
      </mt-empty-state>
    } @else {
      <p style="margin: 0; color: var(--text-secondary)">
        Closed matters past their retention date are listed here each month. Approving one deletes its records,
        documents and files for good, keeps a record that it existed, and issues a destruction certificate. Backups keep
        the data until they expire.
      </p>
      @if (loadError(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }

      <mt-settings-section title="Awaiting approval" [headingLevel]="2">
        @for (entry of pending(); track entry.id) {
          <div class="mt-row entry">
            <span class="mt-grow">
              <span class="body num">{{ entry.number }}</span>
              {{ entry.title ?? '' }}
              <span class="caption t-3 info"
                >{{ typeLabel(entry) }} · closed {{ day(entry.closedAt) }} · kept until
                {{ day(entry.destroyAfter) }}</span
              >
            </span>
            <a mtButton variant="ghost" size="sm" [routerLink]="['/matters', entry.matterId]">Open</a>
            <button mtButton variant="danger" size="sm" (click)="approve(entry)">Approve…</button>
          </div>
        } @empty {
          <p class="caption t-3" style="margin: 0">Nothing is due for destruction.</p>
        }
      </mt-settings-section>

      @if (inProgress().length) {
        <mt-settings-section title="Being destroyed" [headingLevel]="2">
          @for (entry of inProgress(); track entry.id) {
            <div class="mt-row entry">
              <span class="mt-grow">
                <span class="body num">{{ entry.number }}</span>
                <span class="caption t-3 info"
                  >Approved {{ day(entry.approvedAt) }}. The certificate appears here when done.</span
                >
              </span>
            </div>
          }
        </mt-settings-section>
      }

      <mt-settings-section title="Destroyed" [headingLevel]="2">
        @for (entry of destroyed(); track entry.id) {
          <div class="mt-row entry">
            <span class="mt-grow">
              <span class="body num">{{ entry.number }}</span>
              {{ entry.title ?? '' }}
              <span class="caption t-3 info">{{ typeLabel(entry) }} · destroyed {{ day(entry.destroyedAt) }}</span>
            </span>
            <button mtButton variant="secondary" size="sm" iconStart="document" (click)="certificate(entry)">
              Certificate
            </button>
          </div>
        } @empty {
          <p class="caption t-3" style="margin: 0">No matters destroyed yet.</p>
        }
      </mt-settings-section>
    }
  `,
  styles: `
    .entry {
      gap: var(--space-8);
      align-items: center;
      padding-block: var(--space-8);
      border-bottom: 1px solid var(--border-subtle);
    }
    .num {
      font-family: var(--font-mono);
      margin-inline-end: var(--space-8);
    }
    .info {
      display: block;
    }
  `,
})
export class DestructionQueuePage {
  private readonly callables = inject(CALLABLES);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly flags = inject(FeatureFlagService);
  private readonly canDestroy = can('matter.destroy');

  protected readonly allowed = computed(() => this.canDestroy() && this.flags.isOn('matters.destruction'));
  private readonly queue = destructionQueueRepository().watchQuery(() =>
    this.allowed() ? DESTRUCTION_QUEUE_QUERY : null,
  );
  protected readonly loadError = computed(() => (this.queue.error() ? errorCopy(this.queue.error()) : null));
  private readonly entries = this.queue.value;
  protected readonly pending = computed(() => this.entries().filter((entry) => entry.status === 'pending'));
  protected readonly inProgress = computed(() =>
    this.entries().filter((entry) => entry.status === 'approved' || entry.status === 'destroying'),
  );
  protected readonly destroyed = computed(() => this.entries().filter((entry) => entry.status === 'destroyed'));
  private readonly busy = signal(false);

  protected day(value: Date | string | undefined): string {
    return value ? formatDateOnly(value) : '—';
  }

  protected typeLabel(entry: Entry): string {
    return MATTER_TYPE_LABELS[entry.type];
  }

  /** Approves one destruction: the admin types the matter number (and signed in recently). */
  protected async approve(entry: Entry): Promise<void> {
    if (this.busy()) return;
    await this.dialogs.open<MatterNameDialogData, string | undefined>(MatterNameDialog, {
      data: {
        title: `Destroy ${entry.number}?`,
        label: `Type ${entry.number} to confirm`,
        confirm: 'Destroy matter',
        description:
          'Its records, documents and files are deleted for good, and Clerk forgets it. This can’t be undone. A record that the matter existed, the audit trail and a destruction certificate are kept.',
        maxLength: 60,
        submit: async (typed) => {
          if (typed.trim().toLowerCase() !== entry.number.toLowerCase()) return `Type ${entry.number} exactly.`;
          this.busy.set(true);
          try {
            await this.callables.call<Omit<ApproveDestructionInput, 'requestId'>, ApproveDestructionResult>(
              MATTER_CALLABLES.approveDestruction,
              { matterId: entry.matterId, confirmation: typed.trim() },
              { idempotent: true },
            );
            this.toasts.show({ title: `${entry.number} is being destroyed`, tone: 'success' });
            return undefined;
          } catch (error) {
            const details = (error as { details?: { reason?: unknown } } | null)?.details;
            return retentionErrorCopy(details?.reason) ?? errorCopy(error);
          } finally {
            this.busy.set(false);
          }
        },
      },
    }).result;
  }

  /** Opens the destruction certificate (a short-lived signed link). */
  protected async certificate(entry: Entry): Promise<void> {
    try {
      const { url } = await this.callables.call<DestructionCertificateUrlInput, DestructionCertificateUrlResult>(
        MATTER_CALLABLES.destructionCertificateUrl,
        { certificateId: entry.certificateId ?? destructionCertificateId(entry.matterId) },
      );
      globalThis.open?.(url, '_blank', 'noopener');
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t open the certificate', description: errorCopy(error), tone: 'danger' });
    }
  }
}
