import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import Handlebars from 'handlebars';
import { PDFDocument } from 'pdf-lib';

import type { JobRequest } from '@materia/domain';

import { normaliseMetadata } from './determinism';
import { finalise } from './qpdf';
import { JobError } from '../core/errors';
import type { JobHandler } from '../core/types';

type RenderRequest = Extract<JobRequest, { type: 'pdf.render' }>;

/** Templates and fonts ship next to main.js in the image (`apps/jobs/templates`, Geist). */
export const TEMPLATE_DIR = process.env['TEMPLATE_DIR'] ?? join(__dirname, 'templates');
export const FONT_DIR = process.env['FONT_DIR'] ?? join(__dirname, 'fonts');

/**
 * Fills a template. Values are HTML-escaped, missing optional fields render blank, and only the
 * built-in helpers exist (no prototype access, no custom code from data).
 */
export async function renderTemplate(templateId: string, data: Record<string, unknown>): Promise<string> {
  const hbs = Handlebars.create();
  let source: string;
  try {
    source = await readFile(join(TEMPLATE_DIR, `${templateId}.html`), 'utf8');
  } catch {
    throw new JobError('NOT_FOUND', `No template ${templateId}`);
  }
  hbs.registerPartial('styles', await readFile(join(TEMPLATE_DIR, '_styles.html'), 'utf8'));
  try {
    return hbs.compile(source, { knownHelpersOnly: true })({ ...data, fontDir: pathToFileURL(FONT_DIR).href });
  } catch (error) {
    throw new JobError(
      'INVALID_ARGUMENT',
      `Template ${templateId}: ${error instanceof Error ? error.message.split('\n')[0] : 'invalid data'}`,
    );
  }
}

/** Chromium prints the page; it may load local files (fonts) only, never the network. */
async function printPdf(htmlPath: string, signal: AbortSignal): Promise<Uint8Array> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
    // The container runs as a non-root user without user namespaces; pages are our own templates
    // with escaped data, and the network is blocked below.
    chromiumSandbox: false,
    args: ['--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text'],
  });
  const close = () => void browser.close();
  signal.addEventListener('abort', close);
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route('**/*', (route) =>
      route.request().url().startsWith('file://') ? route.continue() : route.abort(),
    );
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, tagged: true });
  } finally {
    signal.removeEventListener('abort', close);
    await browser.close();
  }
}

/** `pdf.render`: template + data → HTML → PDF (Chromium) → fixed metadata → linearised. */
export const renderHandler: JobHandler<RenderRequest> = async ({ request, scratch, signal, progress }) => {
  const total = 4;
  await progress({ done: 0, total, stage: 'rendering' });
  const html = await renderTemplate(request.input.templateId, request.input.data);
  const htmlPath = join(scratch, 'page.html');
  await writeFile(htmlPath, html);
  await progress({ done: 1, total, stage: 'rendering' });

  const printed = await printPdf(htmlPath, signal);
  await progress({ done: 2, total, stage: 'printing' });

  const normalised = await normaliseMetadata(printed, request.target.name);
  const pages = (await PDFDocument.load(normalised, { updateMetadata: false })).getPageCount();
  const draft = join(scratch, 'draft.pdf');
  await writeFile(draft, normalised);
  const output = join(scratch, 'output.pdf');
  await finalise(draft, output, signal);
  await progress({ done: 3, total, stage: 'finalising' });
  return { path: output, pages };
};
