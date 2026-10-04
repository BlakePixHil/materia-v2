import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = resolve(__dirname, '../../../..');
export const FIXTURES = join(ROOT, 'libs/test-utils/fixtures/pdfs');
export const JOB_FIXTURES = join(ROOT, 'apps/jobs/tests/fixtures');

/**
 * Runs the PDF job in `--local` mode: inside the built image when JOBS_IMAGE is set (CI), otherwise
 * the built bundle with the host's qpdf and CHROMIUM_PATH.
 */
export async function runJob(dir: string): Promise<{ code: number; stdout: string; seconds: number }> {
  const image = process.env['JOBS_IMAGE'];
  const started = Date.now();
  const [file, args] = image
    ? ['docker', ['run', '--rm', '--network=none', '-v', `${dir}:/work`, image, 'pdf', '--local', '/work']]
    : ['node', [join(ROOT, 'dist/apps/jobs/main.js'), 'pdf', '--local', dir]];
  try {
    const { stdout } = await exec(file, args, { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    return { code: 0, stdout, seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failed.code !== 'number') throw error;
    return {
      code: failed.code,
      stdout: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
      seconds: (Date.now() - started) / 1000,
    };
  }
}

/** A job folder: job.json plus input files under storage/. Writable by the image's user. */
export async function jobFolder(job: Record<string, unknown>, inputs: Record<string, Uint8Array | string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pdf-job-'));
  const now = '2026-10-04T00:00:00.000Z';
  await writeFile(
    join(dir, 'job.json'),
    JSON.stringify({
      orgId: 'org-1',
      jobId: 'job-1',
      job: {
        status: 'queued',
        progress: { done: 0, total: 0 },
        warnings: [],
        attempts: 0,
        createdAt: now,
        createdBy: 'uid-1',
        updatedAt: now,
        updatedBy: 'uid-1',
        schemaVersion: 1,
        ...job,
      },
    }),
  );
  for (const [path, content] of Object.entries(inputs)) {
    const target = join(dir, 'storage', path);
    await mkdir(dirname(target), { recursive: true });
    if (typeof content === 'string') await copyFile(content, target);
    else await writeFile(target, content);
  }
  await exec('chmod', ['-R', 'a+rwX', dir]);
  await chmod(dir, 0o777);
  return dir;
}

/** The job document as the local store leaves it (dates are ISO strings). */
export interface LocalJob {
  status: string;
  attempts: number;
  output: { storagePath: string; sizeBytes: number; sha256: string; pages: number; documentId?: string };
  error?: { code: string; message: string; retryable: boolean; inputIndex?: number };
  warnings: { code: string; message: string; retryable: boolean; inputIndex?: number }[];
}

export async function readJob(dir: string): Promise<LocalJob> {
  return (JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')) as { job: LocalJob }).job;
}

export async function progressLines(dir: string): Promise<{ done: number; total: number; stage: string }[]> {
  const text = await readFile(join(dir, 'progress.jsonl'), 'utf8').catch(() => '');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The parts of `qpdf --json=2` the tests read. */
export interface QpdfJson {
  pages: { object: string }[];
  outlines: { title: string; destpageposfrom1: number }[];
  qpdf: [unknown, Record<string, { value: Record<string, string> }>];
}

export async function qpdfJson(path: string, keys: string[]): Promise<QpdfJson> {
  const { stdout } = await exec('qpdf', ['--json=2', ...keys.map((k) => `--json-key=${k}`), path, '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout) as QpdfJson;
}

/** Decompressed PDF text, to look for fonts and ToUnicode entries. */
export async function uncompressed(path: string): Promise<string> {
  const out = `${path}.qdf`;
  await exec('qpdf', ['--qdf', '--object-streams=disable', path, out]);
  return (await readFile(out)).toString('latin1');
}

export const docPath = (doc: string, version = 1) => `orgs/org-1/matters/m-1/documents/${doc}/v${version}`;
