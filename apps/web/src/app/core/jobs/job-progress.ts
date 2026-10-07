import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  InjectionToken,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import {
  FirestoreClient,
  firestoreJobSource,
  ListenerRegistry,
  type JobSource,
  type JobView,
} from '@materia/data-access';
import { isErrorCode } from '@materia/domain';
import { MtProgress, ToastService } from '@materia/ui';

import { AuthState } from '../auth/auth-state';
import { ERROR_COPY } from '../error-copy';

/** Watches `orgs/{orgId}/jobs/{jobId}` with a snapshot listener; Firestore loads on first use (FND-19). */
export const JOB_SOURCE = new InjectionToken<JobSource>('JOB_SOURCE', {
  providedIn: 'root',
  factory: () => firestoreJobSource(inject(FirestoreClient), inject(ListenerRegistry)),
});

const STAGE_COPY: Record<string, string> = {
  rendering: 'Preparing the document',
  printing: 'Creating the PDF',
  'checking inputs': 'Checking the documents',
  merging: 'Combining the documents',
  stamping: 'Adding stamps and page numbers',
  bookmarks: 'Adding bookmarks',
  finalising: 'Finishing the PDF',
  zipping: 'Adding the documents to the zip',
  saving: 'Saving',
  // The full export of a practice (SEC-05).
  data: 'Exporting the records',
  documents: 'Adding the documents',
  files: 'Adding the other files',
  final: 'Writing the manifest',
};

/** The words under the bar for a job's state. */
export function jobStatusText(job: JobView | null): string {
  if (!job || job.status === 'queued') return 'Waiting to start…';
  if (job.status === 'succeeded') return 'Ready';
  if (job.status === 'failed')
    return job.error && isErrorCode(job.error.code) ? ERROR_COPY[job.error.code] : ERROR_COPY.INTERNAL;
  return `${STAGE_COPY[job.progress.stage ?? ''] ?? 'Working'}…`;
}

/**
 * Shows a background job's progress (FND-24): a progress bar while it runs, then a toast when it
 * finishes or fails. Give it the id a `jobs-*` callable returned:
 *
 * ```html
 * <mt-job-progress [jobId]="jobId" label="Court book" (finished)="open($event)" />
 * ```
 *
 * It reads `orgs/{activeOrg}/jobs/{jobId}`, which only the member who started the job can see.
 */
@Component({
  selector: 'mt-job-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtProgress],
  template: `
    <mt-progress
      [value]="value()"
      [max]="max()"
      [label]="label()"
      [valueLabel]="statusText()"
      [tone]="job()?.status === 'failed' ? 'danger' : job()?.status === 'succeeded' ? 'success' : 'brand'"
    />
    <p class="mt-job-progress-status" aria-live="polite">{{ statusText() }}</p>
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-2, 8px);
    }
    .mt-job-progress-status {
      margin: 0;
      font-size: var(--text-sm, 13px);
      color: var(--text-secondary, inherit);
    }
  `,
})
export class JobProgress {
  readonly jobId = input.required<string>();
  /** What the job makes, for the accessible name and the toast ("Court book"). */
  readonly label = input.required<string>();
  /** Emits once, when the job succeeds or fails. */
  readonly finished = output<JobView>();

  private readonly source = inject(JOB_SOURCE);
  private readonly auth = inject(AuthState);
  private readonly toast = inject(ToastService);

  protected readonly job = signal<JobView | null>(null);
  protected readonly max = computed(() => Math.max(1, this.job()?.progress.total ?? 1));
  protected readonly value = computed(() => {
    const job = this.job();
    return job?.status === 'succeeded' ? this.max() : (job?.progress.done ?? 0);
  });
  protected readonly statusText = computed(() => jobStatusText(this.job()));

  constructor() {
    let stop: (() => void) | undefined;
    inject(DestroyRef).onDestroy(() => stop?.());
    effect(() => {
      const orgId = this.auth.activeOrgId();
      const jobId = this.jobId();
      untracked(() => {
        stop?.();
        this.job.set(null);
        if (!orgId) return;
        let reported = false;
        stop = this.source.watch(
          orgId,
          jobId,
          (job) => {
            this.job.set(job);
            if (!job || reported || (job.status !== 'succeeded' && job.status !== 'failed')) return;
            reported = true;
            this.report(job);
          },
          () => {
            if (!reported) {
              reported = true;
              this.toast.show({
                tone: 'danger',
                title: `${this.label()} progress is unavailable`,
                description: ERROR_COPY.UNAVAILABLE,
              });
            }
          },
        );
      });
    });
  }

  private report(job: JobView): void {
    if (job.status === 'succeeded') {
      this.toast.show({ tone: 'success', title: `${this.label()} is ready` });
    } else {
      this.toast.show({
        tone: 'danger',
        title: `${this.label()} failed`,
        description: jobStatusText(job),
        duration: 0,
      });
    }
    this.finished.emit(job);
  }
}
