import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

import { decideClaim } from './claim';
import type { JobFiles, JobRecord, JobStore } from './types';

/**
 * `--local <dir>` mode, for tests and for running the image by hand without Google Cloud:
 * - `job.json`: `{orgId, jobId, job}` (the job document, dates as ISO strings);
 * - `storage/<path>`: Cloud Storage objects;
 * - `firestore/<path>.json`: documents the job writes;
 * - `progress.jsonl`: every progress write, one per line.
 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const revive = (_key: string, value: unknown) =>
  typeof value === 'string' && ISO.test(value) ? new Date(value) : value;

/** Keeps a storage path inside the folder. */
function inside(root: string, path: string): string {
  const full = normalize(join(root, path));
  if (!full.startsWith(normalize(root) + '/')) throw new Error(`Path escapes the folder: ${path}`);
  return full;
}

export async function readLocalJob(dir: string): Promise<{ orgId: string; jobId: string; job: unknown }> {
  return JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'), revive) as {
    orgId: string;
    jobId: string;
    job: unknown;
  };
}

export function localJobStore(dir: string): JobStore {
  const update = async (patch: Partial<JobRecord>) => {
    const file = await readLocalJob(dir);
    await writeFile(
      join(dir, 'job.json'),
      JSON.stringify({ ...file, job: { ...(file.job as object), ...patch } }, null, 2),
    );
  };
  return {
    async claim(now) {
      const result = decideClaim((await readLocalJob(dir)).job, now);
      if (result.kind === 'claimed') await update(result.job);
      return result;
    },
    async progress(progress, now) {
      await appendFile(join(dir, 'progress.jsonl'), JSON.stringify({ ...progress, at: now.toISOString() }) + '\n');
      await update({ progress, heartbeatAt: now, updatedAt: now });
    },
    async succeed(output, warnings, now) {
      await update({ status: 'succeeded', output, warnings, finishedAt: now, heartbeatAt: now, updatedAt: now });
    },
    async fail(error, warnings, now) {
      await update({ status: 'failed', error, warnings, finishedAt: now, heartbeatAt: now, updatedAt: now });
    },
    async createDocument(path, data) {
      const file = inside(join(dir, 'firestore'), `${path}.json`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2));
    },
  };
}

export function localFiles(dir: string): JobFiles {
  const root = join(dir, 'storage');
  return {
    async download(storagePath, localPath) {
      await copyFile(inside(root, storagePath), localPath);
    },
    async upload(localPath, storagePath) {
      const target = inside(root, storagePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(localPath, target);
    },
  };
}
