import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';

import { OrgContext } from '@materia/data-access';
import { DomainError, type ExportKind, type Role } from '@materia/domain';
import { ToastService } from '@materia/ui';

import { EXPORT_DOWNLOAD, exportFilters, MtExportButton } from './export-button';
import { CALLABLES } from '../data/callables';

/** The list "Export" button (INS-03). Fictional data only. */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const SUCCEEDED = {
  jobId: 'job-1',
  status: 'succeeded',
  rows: 1234,
  url: 'https://storage.example.test/matters.csv',
  expiresAt: '2026-10-06T00:05:00Z',
  fileName: 'Matters 2026-10-06.csv',
};

async function setup(
  role: Role,
  kind: ExportKind,
  answer: () => Promise<unknown> = async () => SUCCEEDED,
  filters: Record<string, unknown> = {},
) {
  const calls: { name: string; data: unknown; options: unknown }[] = [];
  const downloads: string[] = [];
  const toasts: { tone?: string; title: string; description?: string }[] = [];
  const result = await render(MtExportButton, {
    inputs: { kind, filters },
    providers: [
      {
        provide: CALLABLES,
        useValue: {
          call: async (name: string, data: unknown, options: unknown) => {
            calls.push({ name, data, options });
            return answer();
          },
        },
      },
      { provide: EXPORT_DOWNLOAD, useValue: (url: string) => downloads.push(url) },
      { provide: ToastService, useValue: { show: (toast: { title: string }) => void toasts.push(toast) } },
    ],
  });
  TestBed.inject(OrgContext).setSession({ uid: 'user-ada', orgId: 'org-harbour', role });
  result.fixture.detectChanges();
  const click = async (name: string) => {
    screen.getByRole(name === 'Export' ? 'button' : 'menuitem', { name }).click();
    await settle();
    result.fixture.detectChanges();
    await result.fixture.whenStable();
  };
  return { ...result, calls, downloads, toasts, click };
}

describe('MtExportButton', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((node) => node.remove()));

  it('is hidden from read-only members and from lists the role can’t export', async () => {
    expect((await setup('readonly', 'matters')).queryByRole('button')).toBeNull();
  });

  it('is hidden from a paralegal on invoices', async () => {
    expect((await setup('paralegal', 'invoices')).queryByRole('button')).toBeNull();
  });

  it('downloads a small export at once and says how many rows, without privileged matters', async () => {
    const page = await setup('lawyer', 'matters', undefined, { status: ['open'], query: '', mine: false });
    await page.click('Export');
    await page.click('CSV without privileged matters');
    expect(page.calls).toEqual([
      {
        name: 'exports-create',
        data: { kind: 'matters', filters: { status: ['open'] } },
        options: { idempotent: true },
      },
    ]);
    expect(page.downloads).toEqual(['https://storage.example.test/matters.csv']);
    expect(page.toasts).toEqual([{ tone: 'success', title: 'Matters exported', description: '1,234 rows' }]);
  });

  it('lets a lawyer include privileged matters', async () => {
    const page = await setup('owner', 'deadlines');
    await page.click('Export');
    await page.click('CSV including privileged matters');
    expect(page.calls[0]?.data).toEqual({ kind: 'deadlines', filters: {}, includePrivileged: true });
  });

  it('gives a paralegal a plain button that never includes privileged matters', async () => {
    const page = await setup('paralegal', 'matters');
    await page.click('Export');
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(page.calls[0]?.data).toEqual({ kind: 'matters', filters: {} });
  });

  it('has nothing privileged to ask about for contacts', async () => {
    const page = await setup('owner', 'contacts');
    await page.click('Export');
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(page.calls[0]?.data).toEqual({ kind: 'contacts', filters: {} });
  });

  it('says a large export is being prepared in the background', async () => {
    const page = await setup('paralegal', 'contacts', async () => ({ jobId: 'job-2', status: 'queued' }));
    await page.click('Export');
    expect(page.downloads).toEqual([]);
    expect(page.toasts).toEqual([expect.objectContaining({ title: 'Preparing your contacts export' })]);
  });

  it('explains a refusal', async () => {
    const page = await setup('paralegal', 'contacts', async () => {
      throw new DomainError('PERMISSION_DENIED', 'nope');
    });
    await page.click('Export');
    expect(page.toasts).toEqual([expect.objectContaining({ tone: 'danger', title: 'The export didn’t download' })]);
    expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('exportFilters', () => {
  it('keeps only the filters that are set', () => {
    expect(
      exportFilters({ a: 'x', b: '', c: null, d: undefined, e: false, f: [], g: ['open'], h: true, i: 0 }),
    ).toEqual({ a: 'x', g: ['open'], h: true, i: 0 });
  });
});
