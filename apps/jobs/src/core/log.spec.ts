import { JobError, toProblem } from './errors';
import { createLog } from './log';

describe('createLog', () => {
  it('writes one JSON line per entry with a Cloud Logging severity', () => {
    const lines: string[] = [];
    const log = createLog({ jobId: 'job-1' }, (line) => lines.push(line));
    log.info('started', { pages: 3 });
    log.warn('slow');
    log.error('crashed');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { severity: 'INFO', message: 'started', jobId: 'job-1', pages: 3 },
      { severity: 'WARNING', message: 'slow', jobId: 'job-1' },
      { severity: 'ERROR', message: 'crashed', jobId: 'job-1' },
    ]);
  });
});

describe('toProblem', () => {
  it('keeps coded errors and hides anything else', () => {
    expect(toProblem(new JobError('JOB_TIMEOUT', 'late', { retryable: true }))).toEqual({
      code: 'JOB_TIMEOUT',
      message: 'late',
      retryable: true,
    });
    expect(toProblem(new Error('/tmp/private.pdf'))).toEqual({
      code: 'INTERNAL',
      message: 'Unexpected error',
      retryable: true,
    });
    expect(new JobError('PDF_INVALID', 'x'.repeat(600)).toProblem().message).toHaveLength(500);
  });
});
