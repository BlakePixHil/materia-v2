import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { DomainError, GET_EXPORT_URL_CALLABLE, type GetExportUrlResult } from '@materia/domain';
import { MtButton, MtEmptyState } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { EXPORT_DOWNLOAD } from '../../core/exports/export-button';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';

/** Why an export can't be downloaded, in plain words. */
export function exportDownloadErrorCopy(error: unknown): string {
  const code = error instanceof DomainError ? error.code : (error as { code?: unknown } | null)?.code;
  if (code === 'NOT_FOUND') {
    return 'This export isn’t available. Exports are kept for 7 days, and only the person who made one can download it.';
  }
  if (code === 'FAILED_PRECONDITION') return 'This export isn’t ready yet. Try again in a minute.';
  return errorCopy(error);
}

/**
 * `/exports/:jobId` (INS-03): where an `export_ready` notification leads. Fetches a fresh
 * 5-minute link for the CSV and starts the download; "Download again" asks for another.
 */
@Component({
  selector: 'mt-export-download-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtEmptyState, MtNeedsConnection, RouterLink],
  template: `
    <div class="mt-col" style="max-width: 520px; margin: 48px auto; padding: 0 16px; gap: 12px">
      @if (error(); as message) {
        <mt-empty-state icon="alert" title="Can’t download this export" [description]="message" [headingLevel]="1">
          <a mtButton variant="primary" routerLink="/">Back to Today</a>
        </mt-empty-state>
      } @else {
        <h1 class="title-m" style="margin: 0">{{ fileName() ?? 'Your export' }}</h1>
        <p role="status" style="margin: 0; color: var(--text-secondary)">
          {{ fileName() ? 'Your download has started.' : 'Getting your download ready…' }}
        </p>
        @if (fileName()) {
          <div class="mt-row" style="gap: 8px">
            <button
              mtButton
              mtNeedsConnection
              variant="secondary"
              iconStart="arrow-down"
              [loading]="busy()"
              (click)="start()"
            >
              Download again
            </button>
          </div>
        }
      }
    </div>
  `,
})
export class ExportDownloadPage {
  private readonly callables = inject(CALLABLES);
  private readonly download = inject(EXPORT_DOWNLOAD);
  private readonly jobId = inject(ActivatedRoute).snapshot.paramMap.get('jobId') ?? '';

  protected readonly fileName = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    void this.start();
  }

  protected async start(): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.callables.call<{ jobId: string }, GetExportUrlResult>(GET_EXPORT_URL_CALLABLE, {
        jobId: this.jobId,
      });
      this.fileName.set(result.fileName);
      this.download(result.url);
    } catch (error) {
      this.error.set(exportDownloadErrorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }
}
