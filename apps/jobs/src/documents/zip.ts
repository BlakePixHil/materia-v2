import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import { Zip, ZipPassThrough } from 'fflate';

import { DOCUMENTS_ZIP_MAX_BYTES, type JobRequest } from '@materia/domain';

import { JobError } from '../core/errors';
import type { JobHandler } from '../core/types';

type ZipRequest = Extract<JobRequest, { type: 'documents.zip' }>;

const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new JobError('JOB_TIMEOUT', 'The job was stopped', { retryable: true });

/**
 * `documents.zip` (CORE-12b): download each document version into scratch, one at a time, and
 * append it to a zip under its name (progress per file). Entries are stored, not compressed:
 * PDFs, Office files and images are compressed already, and storing keeps the job fast and its
 * memory flat. Each input is deleted once added, so scratch holds the zip and one input at most.
 * fflate writes no zip64, so the whole zip stays under `DOCUMENTS_ZIP_MAX_BYTES`.
 */
export const zipHandler: JobHandler<ZipRequest> = async ({ request, scratch, files, signal, progress }) => {
  const { inputs } = request.input;
  const outputPath = join(scratch, 'output.zip');
  const out = createWriteStream(outputPath);
  let failure: Error | undefined;
  // fflate calls back synchronously as entries are pushed; backpressure is handled after each push.
  const zip = new Zip((error, chunk, final) => {
    if (error) return void (failure ??= error);
    out.write(chunk);
    if (final) out.end();
  });

  let done = 0;
  let bytes = 0;
  await progress({ done, total: inputs.length, stage: 'zipping' });
  try {
    for (const [index, input] of inputs.entries()) {
      if (signal.aborted) throw abortReason(signal);
      const path = join(scratch, `in-${index}`);
      await files.download(input.storagePath, path, signal);
      const entry = new ZipPassThrough(input.fileName);
      zip.add(entry);
      for await (const chunk of createReadStream(path)) {
        if (signal.aborted) throw abortReason(signal);
        bytes += (chunk as Buffer).length;
        if (bytes > DOCUMENTS_ZIP_MAX_BYTES) {
          throw new JobError('FAILED_PRECONDITION', 'The documents are too large for one zip', { inputIndex: index });
        }
        entry.push(chunk as Buffer);
        if (failure) throw failure;
        if (out.writableNeedDrain) await once(out, 'drain', { signal });
      }
      entry.push(new Uint8Array(0), true);
      await rm(path, { force: true });
      await progress({ done: ++done, total: inputs.length, stage: 'zipping' });
    }
    zip.end();
    if (failure) throw failure;
    await finished(out);
  } catch (error) {
    out.destroy();
    throw error;
  }
  return { path: outputPath, pages: 0 };
};
