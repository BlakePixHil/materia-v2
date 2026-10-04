import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';

import type { JobSource, JobView } from '@materia/data-access';
import { ToastService } from '@materia/ui';

import { JOB_SOURCE, JobProgress, jobStatusText } from './job-progress';
import { AuthState } from '../auth/auth-state';

/** A job source the test drives by hand. */
function fakeSource() {
  const watchers: {
    orgId: string;
    jobId: string;
    next: (job: JobView | null) => void;
    error: (e: unknown) => void;
    stopped: boolean;
  }[] = [];
  const source: JobSource = {
    watch(orgId, jobId, next, error) {
      const watcher = { orgId, jobId, next, error, stopped: false };
      watchers.push(watcher);
      return () => (watcher.stopped = true);
    },
  };
  return { source, watchers };
}

const view = (over: Partial<JobView>): JobView => ({
  status: 'running',
  progress: { done: 0, total: 6 },
  warnings: [],
  ...over,
});

async function setup(orgId: string | null = 'org-1') {
  const { source, watchers } = fakeSource();
  const finished = vi.fn();
  const result = await render(JobProgress, {
    inputs: { jobId: 'job-1', label: 'Court book' },
    on: { finished },
    providers: [
      { provide: JOB_SOURCE, useValue: source },
      { provide: AuthState, useValue: { activeOrgId: () => orgId } },
    ],
  });
  const show = vi.spyOn(TestBed.inject(ToastService), 'show').mockReturnValue({ dismiss: () => undefined });
  return { ...result, watchers, finished, show };
}

describe('JobProgress', () => {
  it('watches the job in the active org and shows its stage', async () => {
    const { watchers, fixture } = await setup();
    expect(watchers).toMatchObject([{ orgId: 'org-1', jobId: 'job-1' }]);
    expect(screen.getByText('Waiting to start…')).toBeTruthy();

    watchers[0]?.next(view({ progress: { done: 2, total: 6, stage: 'merging' } }));
    fixture.detectChanges();
    const bar = screen.getByRole('progressbar', { name: 'Court book' });
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('6');
    expect(bar.getAttribute('aria-valuetext')).toBe('Combining the documents…');
  });

  it('toasts once when the job succeeds and emits finished', async () => {
    const { watchers, show, finished, fixture } = await setup();
    const done = view({
      status: 'succeeded',
      progress: { done: 6, total: 6 },
      output: { storagePath: 'orgs/org-1/exports/job-1.pdf', pages: 3 },
    });
    watchers[0]?.next(done);
    watchers[0]?.next(done);
    fixture.detectChanges();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ tone: 'success', title: 'Court book is ready' });
    expect(finished).toHaveBeenCalledWith(done);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('6');
  });

  it('explains a failure with the error copy and keeps the toast up', async () => {
    const { watchers, show } = await setup();
    watchers[0]?.next(
      view({ status: 'failed', error: { code: 'PDF_ENCRYPTED', message: 'x', retryable: false, inputIndex: 0 } }),
    );
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'danger',
        title: 'Court book failed',
        duration: 0,
        description: expect.stringContaining('password-protected'),
      }),
    );
  });

  it('says so when the job cannot be watched', async () => {
    const { watchers, show } = await setup();
    watchers[0]?.error(new Error('permission-denied'));
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'danger', title: 'Court book progress is unavailable' }),
    );
  });

  it('does not watch without an active org', async () => {
    expect((await setup(null)).watchers).toHaveLength(0);
  });

  it('stops watching when destroyed', async () => {
    const { watchers, fixture } = await setup();
    fixture.destroy();
    expect(watchers[0]?.stopped).toBe(true);
  });
});

describe('jobStatusText', () => {
  it('covers every state', () => {
    expect(jobStatusText(null)).toBe('Waiting to start…');
    expect(jobStatusText(view({ progress: { done: 0, total: 1, stage: 'unknown' } }))).toBe('Working…');
    expect(jobStatusText(view({ status: 'succeeded' }))).toBe('Ready');
    expect(
      jobStatusText(view({ status: 'failed', error: { code: 'NOT_A_CODE', message: '', retryable: false } })),
    ).toMatch(/Something went wrong/);
    expect(jobStatusText(view({ status: 'failed' }))).toMatch(/Something went wrong/);
  });
});
