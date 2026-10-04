import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary without a shell and resolves with its exit code (never rejects on a non-zero exit;
 * callers decide what each code means). The signal kills the child, for job timeouts.
 */
export function run(
  file: string,
  args: string[],
  options: { signal?: AbortSignal | undefined; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { signal: options.signal, maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
  });
}
