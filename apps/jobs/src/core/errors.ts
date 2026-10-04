import type { ErrorCode, JobProblem } from '@materia/domain';

/** An expected job failure with a stable code. Messages carry ids and counts, never document text. */
export class JobError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { retryable?: boolean; inputIndex?: number } = {},
  ) {
    super(message);
    this.name = 'JobError';
  }

  toProblem(): JobProblem {
    return {
      code: this.code,
      message: this.message.slice(0, 500),
      retryable: this.options.retryable ?? false,
      ...(this.options.inputIndex === undefined ? {} : { inputIndex: this.options.inputIndex }),
    };
  }
}

/** Any thrown value as a job problem: unexpected errors are INTERNAL and retryable. */
export function toProblem(error: unknown): JobProblem {
  if (error instanceof JobError) return error.toProblem();
  return { code: 'INTERNAL', message: 'Unexpected error', retryable: true };
}
