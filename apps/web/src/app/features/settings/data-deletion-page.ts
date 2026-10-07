import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import type { JobView } from '@materia/data-access';
import {
  EXPORT_TTL_DAYS,
  ORG_DELETION_CALLABLES,
  ORG_DELETION_GRACE_DAYS,
  ORG_EXPORT_CALLABLE,
  type OrgExportInput,
  type OrgExportResult,
  type RequestOrgDeletionResult,
} from '@materia/domain';
import {
  DialogService,
  MT_ORG_TIMEZONE,
  MtButton,
  MtCheckbox,
  MtNote,
  MtSettingsRow,
  MtSettingsSection,
  ToastService,
} from '@materia/ui';

import { AuthState } from '../../core/auth/auth-state';
import { SessionPolicy } from '../../core/auth/session-policy';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { JobProgress } from '../../core/jobs/job-progress';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';

/** "6 November 2026", in the practice's time zone. */
export function deletionDay(at: Date, timeZone: string): string {
  return at.toLocaleDateString('en-AU', { timeZone, day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Settings → Data and deletion (`/settings/data`, SEC-05, ADR-058): owners only (everyone else sees
 * the shell's banner while a deletion is scheduled).
 * - Export everything (`exports-orgFull`, confirming it's them): every record as JSON Lines with
 *   its schema, the documents (the current version, or every version), a README and a manifest of
 *   checksums, as one or more zips kept for 7 days. The owner first confirms they understand the
 *   export holds privileged material. Progress shows here; `export_ready` tells them when it's done.
 * - Delete this practice (`orgs-requestDeletion`, typing its name): read-only for 30 days, then
 *   deleted by the job; any owner cancels in the meantime (`orgs-cancelDeletion`).
 */
@Component({
  selector: 'mt-data-deletion-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    JobProgress,
    MtButton,
    MtCheckbox,
    MtNeedsConnection,
    MtNote,
    MtSettingsRow,
    MtSettingsSection,
  ],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Data and deletion</h1>
      <p style="margin: 0; color: var(--text-secondary)">Take a full copy of {{ orgName() }}, or delete it.</p>
    </div>

    @if (scheduled(); as at) {
      <mt-note tone="danger" data-deletion-scheduled>
        {{ orgName() }} will be deleted on {{ day(at) }}. Until then it’s read-only: everyone can still read and export,
        but nothing can be changed. You can cancel the deletion below.
      </mt-note>
    }

    <mt-settings-section
      title="Export everything"
      description="A complete copy of the practice, to keep or to move to another system."
      [headingLevel]="2"
    >
      <ul class="mt-col" style="margin: 0; padding-left: 20px; gap: 4px; color: var(--text-secondary)">
        <li>
          Every record (matters, contacts, tasks, deadlines, notes, time, invoices, Clerk conversations, the audit log)
          as JSON Lines, with a schema for each kind.
        </li>
        <li>The documents, by matter: the current version of each, or every version.</li>
        <li>A README explaining the files, and a manifest with a checksum for every file.</li>
        <li>Large practices come as several zip files. The download is kept for {{ ttlDays }} days.</li>
      </ul>
      <mt-checkbox
        name="allVersions"
        label="Include every version of each document"
        description="Otherwise only the current version of each document is included."
        [ngModel]="allVersions()"
        (ngModelChange)="allVersions.set($event === true)"
      />
      <mt-note tone="warning" data-privileged-explainer>
        The export includes privileged and confidential material: client records, file notes, Clerk conversations and
        documents marked privileged. Anyone holding the files can read them. Download them only to a device the practice
        controls, and keep them as securely as the practice’s own files.
      </mt-note>
      <mt-checkbox
        name="acknowledgePrivileged"
        label="I understand the export includes privileged material, and I’ll keep it secure"
        [ngModel]="acknowledged()"
        (ngModelChange)="acknowledged.set($event === true)"
      />
      <div class="mt-row" style="gap: 8px; flex-wrap: wrap; align-items: center">
        <button
          mtButton
          mtNeedsConnection
          variant="primary"
          type="button"
          iconStart="arrow-down"
          [disabled]="!acknowledged()"
          [loading]="exporting()"
          (click)="exportAll()"
        >
          Export everything
        </button>
        @if (readyJobId(); as id) {
          <a mtButton variant="secondary" [routerLink]="['/exports', id]">Download the export</a>
        }
      </div>
      @if (jobId(); as id) {
        <mt-job-progress [jobId]="id" label="The full export" (finished)="exported(id, $event)" />
        <p style="margin: 0; color: var(--text-tertiary)">
          You can leave this page: you’ll get a notification when the export is ready.
        </p>
      }
    </mt-settings-section>

    <mt-settings-section
      title="Delete this practice"
      description="Permanently delete the practice and everything in it."
      [headingLevel]="2"
    >
      @if (scheduled(); as at) {
        <mt-settings-row
          title="Deletion scheduled"
          [description]="'On ' + day(at) + '. Until then the practice is read-only, and any owner can cancel.'"
          data-deletion-row
        >
          <button
            mtButton
            mtNeedsConnection
            variant="secondary"
            size="sm"
            type="button"
            [loading]="cancelling()"
            (click)="cancel()"
          >
            Cancel deletion
          </button>
        </mt-settings-row>
      } @else {
        <ul class="mt-col" style="margin: 0; padding-left: 20px; gap: 4px; color: var(--text-secondary)">
          <li>
            The practice becomes read-only straight away, for {{ graceDays }} days, and everyone in it is told. Any
            owner can cancel during that time. Export everything first if you want a copy.
          </li>
          <li>
            Then everything is deleted: matters, documents and every version, notes, time, invoices, Clerk
            conversations, the audit log, and the connections to Microsoft, Google and Xero.
          </li>
          <li>People keep their sign-in and any other practices they belong to.</li>
          <li>
            Owners get a certificate of deletion by email. Copies in backups taken before then expire on their own
            schedule (all within about 13 months), and are never restored for a deleted practice.
          </li>
          <li>A legal hold, or an export still being made, stops the deletion.</li>
        </ul>
        <div>
          <button
            mtButton
            mtNeedsConnection
            variant="danger"
            type="button"
            [loading]="deleting()"
            (click)="requestDeletion()"
          >
            Delete this practice…
          </button>
        </div>
      }
    </mt-settings-section>
  `,
})
export class DataDeletionPage {
  private readonly auth = inject(AuthState);
  private readonly session = inject(SessionPolicy);
  private readonly callables = inject(CALLABLES);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);

  protected readonly ttlDays = EXPORT_TTL_DAYS;
  protected readonly graceDays = ORG_DELETION_GRACE_DAYS;
  protected readonly orgName = computed(() => this.auth.claims().orgName ?? 'the practice');
  /** The scheduled deletion, from the org document; what this tab just did shows until it catches up. */
  protected readonly scheduled = linkedSignal<Date | null>(() => this.session.deletionScheduledAt());

  protected readonly allVersions = signal(false);
  protected readonly acknowledged = signal(false);
  protected readonly exporting = signal(false);
  protected readonly jobId = signal<string | null>(null);
  protected readonly readyJobId = signal<string | null>(null);
  protected readonly deleting = signal(false);
  protected readonly cancelling = signal(false);

  protected day(at: Date): string {
    return deletionDay(at, this.timeZone);
  }

  protected async exportAll(): Promise<void> {
    if (!this.acknowledged()) return;
    this.exporting.set(true);
    this.readyJobId.set(null);
    try {
      const result = await this.callables.call<Omit<OrgExportInput, 'requestId'>, OrgExportResult>(
        ORG_EXPORT_CALLABLE,
        { allVersions: this.allVersions(), acknowledgePrivileged: true },
        { idempotent: true },
      );
      this.jobId.set(result.jobId);
      this.toasts.show({
        title: 'Export started',
        description: 'You’ll be notified when it’s ready.',
        tone: 'success',
      });
    } catch (error) {
      this.toasts.show({ title: 'The export didn’t start', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.exporting.set(false);
    }
  }

  protected exported(jobId: string, job: JobView): void {
    if (job.status === 'succeeded') this.readyJobId.set(jobId);
  }

  protected async requestDeletion(): Promise<void> {
    const name = this.auth.claims().orgName ?? '';
    const confirmed = await this.dialogs.confirm({
      title: `Delete ${name}?`,
      body:
        `The practice becomes read-only now and is permanently deleted in ${ORG_DELETION_GRACE_DAYS} days, ` +
        'with every matter, document and record in it. Everyone in it is told, and any owner can cancel until then. ' +
        'Type the practice’s name to confirm.',
      confirmLabel: 'Delete practice',
      tone: 'danger',
      typedConfirmation: name,
    });
    if (!confirmed) return;
    this.deleting.set(true);
    try {
      const result = await this.callables.call<{ confirmation: string }, RequestOrgDeletionResult>(
        ORG_DELETION_CALLABLES.request,
        { confirmation: name },
        { idempotent: true },
      );
      const at = new Date(result.deletionScheduledAt);
      this.scheduled.set(at);
      this.toasts.show({ title: `${name} will be deleted on ${this.day(at)}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({
        title: 'The practice wasn’t scheduled for deletion',
        description: errorCopy(error),
        tone: 'danger',
      });
    } finally {
      this.deleting.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Cancel the deletion?',
      body: 'The practice goes back to normal straight away, and everyone in it is told.',
      confirmLabel: 'Cancel deletion',
      cancelLabel: 'Keep it scheduled',
    });
    if (!confirmed) return;
    this.cancelling.set(true);
    try {
      await this.callables.call(ORG_DELETION_CALLABLES.cancel, {}, { idempotent: true });
      this.scheduled.set(null);
      this.toasts.show({ title: 'The deletion is cancelled', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The deletion wasn’t cancelled', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.cancelling.set(false);
    }
  }
}
