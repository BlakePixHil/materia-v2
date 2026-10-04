import { firebaseDeps } from './core/firebase';
import { localFiles, localJobStore, readLocalJob } from './core/local';
import { createLog } from './core/log';
import { executeJob, type RunOutcome } from './core/runner';
import type { JobFiles, JobStore } from './core/types';
import { PDF_HANDLERS } from './pdf/index';

/**
 * Cloud Run jobs entry point (ADR-014). Each image runs `node main.js <job>`; LIT-10 adds the court
 * book. A job execution gets its job document from `JOB_ORG_ID` and `JOB_ID`, set by the function
 * that dispatched it (container overrides). `--local <dir>` runs against a folder instead of Google
 * Cloud (tests, and trying the image by hand).
 */
export const JOBS = ['pdf', 'court-book', 'ocr'] as const;
export type JobName = (typeof JOBS)[number];

/** Cloud Run stops a task at 30 minutes; we stop first so the failure is recorded as retryable. */
export const DEFAULT_TIMEOUT_MS = 28 * 60_000;

export function resolveJob(name: string | undefined): JobName | null {
  return JOBS.find((job) => job === name) ?? null;
}

/** Process exit codes: 0 succeeded or skipped, 1 usage or setup error, 2 the job failed. */
export function exitCode(outcome: RunOutcome): number {
  return outcome === 'failed' ? 2 : 0;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const job = resolveJob(argv[0]);
  if (!job) {
    console.error(`Usage: node main.js <${JOBS.join('|')}> [--local <dir>]`);
    return 1;
  }
  if (job !== 'pdf') {
    console.error(`Job "${job}" is not implemented yet.`);
    return 1;
  }

  const localIndex = argv.indexOf('--local');
  const localDir = localIndex >= 0 ? argv[localIndex + 1] : undefined;
  let orgId: string | undefined;
  let jobId: string | undefined;
  let store: JobStore;
  let files: JobFiles;
  if (localDir) {
    ({ orgId, jobId } = await readLocalJob(localDir));
    store = localJobStore(localDir);
    files = localFiles(localDir);
  } else {
    orgId = env['JOB_ORG_ID'];
    jobId = env['JOB_ID'];
    if (!orgId || !jobId) {
      console.error('Set JOB_ORG_ID and JOB_ID');
      return 1;
    }
    ({ store, files } = firebaseDeps(orgId, jobId));
  }

  const log = createLog({ job, orgId, jobId, execution: env['CLOUD_RUN_EXECUTION'] });
  const outcome = await executeJob({
    orgId,
    jobId,
    store,
    files,
    log,
    handlers: PDF_HANDLERS,
    timeoutMs: Number(env['JOB_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS),
  });
  return exitCode(outcome);
}

/* v8 ignore next 6 -- process entry point */
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      console.error('Job setup failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
