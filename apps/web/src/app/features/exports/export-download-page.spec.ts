import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { DomainError } from '@materia/domain';

import { ExportDownloadPage, exportDownloadErrorCopy } from './export-download-page';
import { CALLABLES } from '../../core/data/callables';
import { EXPORT_DOWNLOAD } from '../../core/exports/export-button';

/** `/exports/:jobId`, where an `export_ready` notification leads (INS-03). Fictional data only. */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open(answer: () => Promise<unknown>) {
  const calls: { name: string; data: unknown }[] = [];
  const downloads: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'exports/:jobId', component: ExportDownloadPage }]),
      {
        provide: CALLABLES,
        useValue: {
          call: async (name: string, data: unknown) => {
            calls.push({ name, data });
            return answer();
          },
        },
      },
      { provide: EXPORT_DOWNLOAD, useValue: (url: string) => downloads.push(url) },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/exports/job-1');
  const stable = async () => {
    await settle();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  await stable();
  const el = () => harness.routeNativeElement as HTMLElement;
  const text = () => (el().textContent ?? '').replace(/\s+/g, ' ').trim();
  return { calls, downloads, text, el, stable };
}

describe('ExportDownloadPage', () => {
  it('fetches a fresh link and starts the download, and can download again', async () => {
    const page = await open(async () => ({
      url: 'https://storage.example.test/contacts.csv',
      expiresAt: '2026-10-06T00:05:00Z',
      fileName: 'Contacts 2026-10-06.csv',
    }));
    expect(page.calls).toEqual([{ name: 'jobs-getExportUrl', data: { jobId: 'job-1' } }]);
    expect(page.downloads).toEqual(['https://storage.example.test/contacts.csv']);
    expect(page.text()).toContain('Contacts 2026-10-06.csv');
    expect(page.text()).toContain('Your download has started.');

    [...page.el().querySelectorAll('button')].find((b) => b.textContent?.includes('Download again'))?.click();
    await page.stable();
    expect(page.downloads).toHaveLength(2);
  });

  it('explains an export that has expired or isn’t yours', async () => {
    const page = await open(async () => {
      throw new DomainError('NOT_FOUND', 'gone');
    });
    expect(page.downloads).toEqual([]);
    expect(page.text()).toContain('Can’t download this export');
    expect(page.text()).toContain('Exports are kept for 7 days');
  });
});

describe('exportDownloadErrorCopy', () => {
  it('says when an export isn’t ready yet', () => {
    expect(exportDownloadErrorCopy(new DomainError('FAILED_PRECONDITION', 'running'))).toContain('isn’t ready yet');
  });
});
