import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { DomainError, GET_EXPORT_URL_CALLABLE, type GetExportUrlInput, type GetExportUrlResult } from '@materia/domain';
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
 * A split export's title from a part's file name: "Fictional Legal export 2026-10-07 part 1 of
 * 3.zip" (`jobs-getExportUrl`), or "… (part 1 of 3).zip" (`orgExportFileName`) → "Fictional Legal
 * export 2026-10-07".
 */
export function exportTitle(fileName: string): string {
  return fileName.replace(/ (?:\(part \d+(?: of \d+)?\)|part \d+ of \d+)\.[a-z0-9]+$/i, '');
}

/**
 * `/exports/:jobId` (INS-03): where an `export_ready` notification leads. Fetches a fresh
 * 5-minute link for the file and starts the download; "Download again" asks for another. A full
 * export of the practice split into several zips (SEC-05) starts the first and lists every part,
 * each fetched with its own link.
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
          @if (parts() > 1) {
            <p style="margin: 0; color: var(--text-secondary)" data-export-parts>
              This export is in {{ parts() }} zip files. Download each one, then unzip them all into the same folder.
            </p>
            <div class="mt-col" style="gap: 8px; align-items: flex-start">
              @for (part of partNumbers(); track part) {
                <button
                  mtButton
                  mtNeedsConnection
                  variant="secondary"
                  iconStart="arrow-down"
                  [loading]="busy() === part"
                  (click)="start(part)"
                >
                  Download part {{ part }} of {{ parts() }}
                </button>
              }
            </div>
          } @else {
            <div class="mt-row" style="gap: 8px">
              <button
                mtButton
                mtNeedsConnection
                variant="secondary"
                iconStart="arrow-down"
                [loading]="busy() === 1"
                (click)="start()"
              >
                Download again
              </button>
            </div>
          }
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
  /** The part being fetched, or null. */
  protected readonly busy = signal<number | null>(null);
  protected readonly parts = signal(1);
  protected readonly partNumbers = computed(() => Array.from({ length: this.parts() }, (_, i) => i + 1));

  constructor() {
    void this.start();
  }

  protected async start(part = 1): Promise<void> {
    this.busy.set(part);
    try {
      const input: GetExportUrlInput = part > 1 ? { jobId: this.jobId, part } : { jobId: this.jobId };
      const result = await this.callables.call<GetExportUrlInput, GetExportUrlResult>(GET_EXPORT_URL_CALLABLE, input);
      if (part === 1 || !this.fileName())
        this.fileName.set(result.parts && result.parts > 1 ? exportTitle(result.fileName) : result.fileName);
      this.parts.set(result.parts ?? 1);
      this.download(result.url);
    } catch (error) {
      this.error.set(exportDownloadErrorCopy(error));
    } finally {
      this.busy.set(null);
    }
  }
}
