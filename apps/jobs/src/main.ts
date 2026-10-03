/**
 * Cloud Run jobs entry point (ADR-014). FND-24 adds the PDF render service; LIT-10 the court-book
 * builder. Each job runs as `node main.js <job>`.
 */
export const JOBS = ['pdf', 'court-book', 'ocr'] as const;
export type JobName = (typeof JOBS)[number];

export function resolveJob(name: string | undefined): JobName | null {
  return JOBS.find((job) => job === name) ?? null;
}

/** Runs a job by name and returns the process exit code. */
export function runJob(name: string | undefined): number {
  const job = resolveJob(name);
  if (!job) {
    console.error(`Usage: node main.js <${JOBS.join('|')}>`);
    return 1;
  }
  console.error(`Job "${job}" is not implemented yet.`);
  return 2;
}

/* v8 ignore next 3 -- process entry point */
if (require.main === module) {
  process.exitCode = runJob(process.argv[2]);
}
