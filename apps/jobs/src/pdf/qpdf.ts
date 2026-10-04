import { writeFile } from 'node:fs/promises';

import { displayedBox, type Box } from './layout';
import { JobError } from '../core/errors';
import { run } from '../core/exec';

/**
 * qpdf does the heavy lifting: it streams pages between files, so merges of thousands of pages
 * keep memory bounded (pdf-lib only ever builds the small overlay). qpdf exit codes: 0 success,
 * 2 errors, 3 warnings (the file was repaired).
 */
const QPDF = process.env['QPDF_PATH'] ?? 'qpdf';

async function qpdf(args: string[], signal?: AbortSignal) {
  const result = await run(QPDF, args, { signal });
  if (result.code === 2) throw new Error(`qpdf failed: ${result.stderr.split('\n')[0]?.slice(0, 200)}`);
  return result;
}

export interface InputCheck {
  pages: number;
  /** qpdf repaired the file while reading it. */
  repaired: boolean;
}

/** Checks an input can be read: PDF_ENCRYPTED when it needs a password, PDF_INVALID when unreadable. */
export async function checkInput(path: string, inputIndex: number, signal?: AbortSignal): Promise<InputCheck> {
  const password = await run(QPDF, ['--requires-password', path], { signal });
  if (password.code === 0) {
    throw new JobError('PDF_ENCRYPTED', `Input ${inputIndex} needs a password`, { inputIndex });
  }
  const count = await run(QPDF, ['--show-npages', path], { signal });
  const pages = Number(count.stdout.trim());
  if (count.code === 2 || !Number.isInteger(pages) || pages < 1) {
    throw new JobError('PDF_INVALID', `Input ${inputIndex} is not a readable PDF`, { inputIndex });
  }
  return { pages, repaired: count.code === 3 };
}

/** Concatenates page spans of several files (`qpdf --empty --pages a.pdf 1-3 b.pdf 2 --`). */
export async function mergePages(parts: { path: string; range: string }[], output: string, signal?: AbortSignal) {
  const args = ['--empty', '--warning-exit-0', '--deterministic-id', '--pages'];
  for (const part of parts) args.push(part.path, part.range);
  args.push('--', output);
  await qpdf(args, signal);
}

/** Lays each page of `overlay` over the same page of `input`. */
export async function overlay(input: string, overlayPath: string, output: string, signal?: AbortSignal) {
  await qpdf(['--warning-exit-0', '--deterministic-id', input, '--overlay', overlayPath, '--', output], signal);
}

/**
 * Final pass: linearised for fast web view, object streams for size, and a deterministic /ID so
 * the same input always gives the same bytes.
 */
export async function finalise(input: string, output: string, signal?: AbortSignal) {
  await qpdf(
    ['--warning-exit-0', '--linearize', '--deterministic-id', '--object-streams=generate', input, output],
    signal,
  );
}

type QpdfObjects = Record<string, { value?: Record<string, unknown> } | undefined>;

interface QpdfJson {
  pages: { object: string }[];
  qpdf: [{ maxobjectid: number }, QpdfObjects];
}

async function readJson(path: string, signal?: AbortSignal): Promise<QpdfJson> {
  const result = await qpdf(
    ['--json=2', '--json-key=pages', '--json-key=qpdf', '--json-stream-data=none', path, '-'],
    signal,
  );
  return JSON.parse(result.stdout) as QpdfJson;
}

function resolve(objects: QpdfObjects, value: unknown): unknown {
  return typeof value === 'string' && /^\d+ \d+ R$/.test(value) ? objects[`obj:${value}`]?.value : value;
}

/** A page attribute, following `/Parent` for inherited ones (MediaBox, CropBox, Rotate). */
function inherited(objects: QpdfObjects, ref: string, key: string): unknown {
  let node = objects[`obj:${ref}`]?.value;
  for (let depth = 0; node && depth < 64; depth++) {
    if (key in node) return resolve(objects, node[key]);
    node = typeof node['/Parent'] === 'string' ? objects[`obj:${node['/Parent']}`]?.value : undefined;
  }
  return undefined;
}

function toBox(value: unknown): [number, number, number, number] | undefined {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number')
    ? (value as [number, number, number, number])
    : undefined;
}

export interface PdfStructure {
  pageRefs: string[];
  pageBoxes: Box[];
  rootRef: string;
  root: Record<string, unknown>;
  maxObjectId: number;
}

/** Page objects, their displayed sizes and the catalog, without loading page content. */
export async function structure(path: string, signal?: AbortSignal): Promise<PdfStructure> {
  const json = await readJson(path, signal);
  const objects = json.qpdf[1];
  const trailer = (objects['trailer'] as { value: { '/Root': string } } | undefined)?.value;
  if (!trailer) throw new Error('qpdf JSON has no trailer');
  const rootRef = trailer['/Root'];
  const pageRefs = json.pages.map((page) => page.object);
  const pageBoxes = pageRefs.map((ref) => {
    const box = toBox(inherited(objects, ref, '/CropBox')) ??
      toBox(inherited(objects, ref, '/MediaBox')) ?? [0, 0, 595, 842];
    const rotate = inherited(objects, ref, '/Rotate');
    return displayedBox(box, typeof rotate === 'number' ? rotate : 0);
  });
  return {
    pageRefs,
    pageBoxes,
    rootRef,
    root: objects[`obj:${rootRef}`]?.value ?? {},
    maxObjectId: json.qpdf[0].maxobjectid,
  };
}

/** Adds a flat outline (bookmarks) through qpdf's JSON update, which streams the rest of the file. */
export async function addOutline(
  input: string,
  bookmarks: { title: string; pageIndex: number }[],
  output: string,
  scratch: string,
  signal?: AbortSignal,
) {
  if (bookmarks.length === 0) return false;
  const pdf = await structure(input, signal);
  const first = pdf.maxObjectId + 1;
  const outlinesRef = `${first} 0 R`;
  const itemRef = (i: number) => `${first + 1 + i} 0 R`;
  const updates: Record<string, unknown> = {
    [`obj:${pdf.rootRef}`]: { value: { ...pdf.root, '/Outlines': outlinesRef, '/PageMode': '/UseOutlines' } },
    [`obj:${outlinesRef}`]: {
      value: {
        '/Type': '/Outlines',
        '/First': itemRef(0),
        '/Last': itemRef(bookmarks.length - 1),
        '/Count': bookmarks.length,
      },
    },
  };
  bookmarks.forEach((bookmark, i) => {
    const page = pdf.pageRefs[Math.min(bookmark.pageIndex, pdf.pageRefs.length - 1)];
    updates[`obj:${itemRef(i)}`] = {
      value: {
        '/Title': `u:${bookmark.title}`,
        '/Parent': outlinesRef,
        ...(i > 0 ? { '/Prev': itemRef(i - 1) } : {}),
        ...(i < bookmarks.length - 1 ? { '/Next': itemRef(i + 1) } : {}),
        '/Dest': [page, '/Fit'],
      },
    };
  });
  const jsonPath = `${scratch}/outline.json`;
  await writeFile(
    jsonPath,
    JSON.stringify({ qpdf: [{ jsonversion: 2, maxobjectid: first + bookmarks.length }, updates] }),
  );
  await qpdf(['--warning-exit-0', '--deterministic-id', input, `--update-from-json=${jsonPath}`, output], signal);
  return true;
}
