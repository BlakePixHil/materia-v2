import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { JobRequest } from '@materia/domain';

import { parsePageRange, qpdfRange, spanPages } from './layout';
import { buildOverlay } from './overlay';
import { addOutline, checkInput, finalise, mergePages, overlay, structure } from './qpdf';
import { JobError } from '../core/errors';
import type { JobHandler } from '../core/types';

type MergeRequest = Extract<JobRequest, { type: 'pdf.merge' }>;

/** Inputs are fetched and checked in parallel, a few at a time, to bound memory and disk. */
const CONCURRENCY = 4;

/**
 * `pdf.merge`: download and check each input (progress per input), merge the page ranges with qpdf,
 * overlay stamps and page numbers, add bookmarks, then linearise deterministically.
 */
export const mergeHandler: JobHandler<MergeRequest> = async ({ request, scratch, files, signal, progress, warn }) => {
  const { inputs, stamp, pageNumbers, bookmarks, onInputError } = request.input;
  const steps = inputs.length + 4;
  let done = 0;
  await progress({ done, total: steps, stage: 'checking inputs' });

  const parts: ({ path: string; range: string; pages: number } | null)[] = new Array(inputs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next++;
      const input = inputs[index];
      if (!input) continue;
      const path = join(scratch, `in-${index}.pdf`);
      try {
        await files.download(input.storagePath, path, signal);
        const check = await checkInput(path, index, signal);
        if (check.repaired)
          warn({
            code: 'PDF_INVALID',
            message: `Input ${index} was damaged and has been repaired`,
            retryable: false,
            inputIndex: index,
          });
        let spans;
        try {
          spans = parsePageRange(input.pageRange, check.pages);
        } catch {
          throw new JobError('INVALID_ARGUMENT', `Input ${index} has no pages ${input.pageRange ?? ''}`, {
            inputIndex: index,
          });
        }
        parts[index] = { path, range: qpdfRange(spans), pages: spanPages(spans) };
      } catch (error) {
        if (onInputError === 'skip' && error instanceof JobError && error.options.inputIndex === index) {
          warn(error.toProblem());
        } else {
          throw error;
        }
      }
      await progress({ done: ++done, total: steps, stage: 'checking inputs' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, inputs.length) }, worker));

  const kept = parts.filter((part): part is NonNullable<typeof part> => part !== null);
  if (kept.length === 0) throw new JobError('PDF_INVALID', 'None of the inputs could be read');

  let current = join(scratch, 'merged.pdf');
  await mergePages(kept, current, signal);
  await progress({ done: ++done, total: steps, stage: 'merging' });

  const pdf = await structure(current, signal);
  if (stamp || pageNumbers) {
    const overlayPath = join(scratch, 'overlay.pdf');
    await writeFile(overlayPath, await buildOverlay(pdf.pageBoxes, { stamp, pageNumbers }));
    const stamped = join(scratch, 'stamped.pdf');
    await overlay(current, overlayPath, stamped, signal);
    current = stamped;
  }
  await progress({ done: ++done, total: steps, stage: 'stamping' });

  const valid = (bookmarks ?? []).filter((bookmark) => bookmark.pageIndex < pdf.pageRefs.length);
  if (valid.length < (bookmarks?.length ?? 0)) {
    warn({
      code: 'INVALID_ARGUMENT',
      message: `${(bookmarks?.length ?? 0) - valid.length} bookmarks point past the last page`,
      retryable: false,
    });
  }
  const outlined = join(scratch, 'outlined.pdf');
  if (await addOutline(current, valid, outlined, scratch, signal)) current = outlined;
  await progress({ done: ++done, total: steps, stage: 'bookmarks' });

  const output = join(scratch, 'output.pdf');
  await finalise(current, output, signal);
  await progress({ done: ++done, total: steps, stage: 'finalising' });
  return { path: output, pages: pdf.pageRefs.length };
};
