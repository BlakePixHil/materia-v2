import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exitCode, main, resolveJob } from './main';
import { jobDoc } from './testing';

describe('resolveJob', () => {
  it('accepts known jobs and rejects anything else', () => {
    expect(resolveJob('pdf')).toBe('pdf');
    expect(resolveJob('court-book')).toBe('court-book');
    expect(resolveJob('nope')).toBeNull();
    expect(resolveJob(undefined)).toBeNull();
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns 1 for an unknown or unimplemented job, or missing job ids', async () => {
    expect(await main(['nope'])).toBe(1);
    expect(await main(['ocr'])).toBe(1);
    expect(await main(['pdf'], {})).toBe(1);
  });

  it('runs the job Cloud Run names when it passes no arguments', async () => {
    // Cloud Run starts the deployed job `pdf` as `node main.js`: without the fallback every
    // execution stopped at the usage line and no job document was ever claimed.
    expect(await main([], { CLOUD_RUN_JOB: 'pdf' })).toBe(1);
    expect(console.error).toHaveBeenLastCalledWith('Set JOB_ORG_ID and JOB_ID');
    expect(await main([], {})).toBe(1);
    expect(console.error).toHaveBeenLastCalledWith(expect.stringMatching(/^Usage: node main.js/));
    expect(await main([], { CLOUD_RUN_JOB: 'ocr' })).toBe(1);
  });

  it('runs a job from a local folder and returns 2 when it fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'main-'));
    // The input does not exist in storage/, so the download fails and the job records a failure.
    await writeFile(join(dir, 'job.json'), JSON.stringify({ orgId: 'org-1', jobId: 'job-1', job: jobDoc() }));
    expect(await main(['pdf', '--local', dir])).toBe(2);
  });

  it('maps outcomes to exit codes', () => {
    expect(exitCode('succeeded')).toBe(0);
    expect(exitCode('skipped')).toBe(0);
    expect(exitCode('failed')).toBe(2);
  });
});
