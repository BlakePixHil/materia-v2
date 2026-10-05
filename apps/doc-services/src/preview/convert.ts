import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Preview conversions (CORE-12a, ADR-028): Office documents to PDF with LibreOffice headless, HEIC
 * photos to JPEG with libheif's `heif-convert`. Each conversion runs in its own temporary folder
 * (and LibreOffice with its own profile, so conversions never share state) that is deleted after.
 */
export const OFFICE_EXTENSIONS = ['docx', 'doc', 'xlsx', 'xls', 'pptx'] as const;
export type OfficeExtension = (typeof OFFICE_EXTENSIONS)[number];
export type PreviewTarget = 'pdf' | 'jpeg';

export interface ConvertRequest {
  /** The source's allow-listed extension (the functions checked the type by magic bytes). */
  from: OfficeExtension | 'heic';
  to: PreviewTarget;
  data: Uint8Array;
}

/** The source couldn't be converted (damaged, password-protected, or a format the tool refused). */
export class ConversionError extends Error {
  constructor(readonly reason: 'unsupported' | 'failed' | 'timeout') {
    super(`Conversion ${reason}`);
    this.name = 'ConversionError';
  }
}

export interface ConverterOptions {
  soffice?: string;
  heifConvert?: string;
  timeoutMs?: number;
  /** JPEG quality for HEIC previews. */
  jpegQuality?: number;
}

export function isSupported(from: string, to: string): from is ConvertRequest['from'] {
  if (to === 'pdf') return (OFFICE_EXTENSIONS as readonly string[]).includes(from);
  return to === 'jpeg' && from === 'heic';
}

function run(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error) => {
      if (!error) return resolve();
      reject(new ConversionError((error as { killed?: boolean }).killed ? 'timeout' : 'failed'));
    });
  });
}

export function converter(options: ConverterOptions = {}) {
  const soffice = options.soffice ?? 'soffice';
  const heifConvert = options.heifConvert ?? 'heif-convert';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const quality = options.jpegQuality ?? 85;

  return async function convert(request: ConvertRequest): Promise<Buffer> {
    if (!isSupported(request.from, request.to)) throw new ConversionError('unsupported');
    const dir = await mkdtemp(join(tmpdir(), 'preview-'));
    try {
      const input = join(dir, `input.${request.from}`);
      await writeFile(input, request.data);
      if (request.to === 'pdf') {
        const out = join(dir, 'out');
        await run(
          soffice,
          [
            `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`,
            '--headless',
            '--norestore',
            '--nologo',
            '--nolockcheck',
            '--convert-to',
            'pdf',
            '--outdir',
            out,
            input,
          ],
          timeoutMs,
        );
        // LibreOffice exits 0 even when it couldn't load the file; the missing output says so.
        return await readFile(join(out, 'input.pdf')).catch(() => {
          throw new ConversionError('failed');
        });
      }
      const output = join(dir, 'preview.jpg');
      await run(heifConvert, ['-q', String(quality), input, output], timeoutMs);
      // A HEIC holding several top-level images is written as preview-1.jpg, preview-2.jpg, …
      const written = (await readdir(dir)).filter((name) => /^preview(-\d+)?\.jpg$/.test(name)).sort();
      const first = written.includes('preview.jpg') ? 'preview.jpg' : written[0];
      if (!first) throw new ConversionError('failed');
      return await readFile(join(dir, first));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
