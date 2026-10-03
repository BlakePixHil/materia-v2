/**
 * Cloud Run jobs entry point (ADR-014). FND-24 adds the PDF render service; LIT-10 the court-book
 * builder. Each job runs as `node main.js <job>`.
 */
export const JOBS = ['pdf', 'court-book', 'ocr'] as const;
export type JobName = (typeof JOBS)[number];

export function resolveJob(name: string | undefined): JobName | null {
  return JOBS.find((job) => job === name) ?? null;
}

if (require.main === module) {
  const job = resolveJob(process.argv[2]);
  if (!job) {
    console.error(`Usage: node main.js <${JOBS.join('|')}>`);
    process.exitCode = 1;
  } else {
    console.error(`Job "${job}" is not implemented yet.`);
    process.exitCode = 2;
  }
}
