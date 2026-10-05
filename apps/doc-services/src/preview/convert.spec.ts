import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversionError, converter, isSupported } from './convert';

/**
 * The converter with stand-in tools (shell scripts): the real LibreOffice and heif-convert run in
 * the container test (`nx run doc-services:test-container`).
 */
describe('converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'convert-spec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function tool(name: string, script: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  }

  /** soffice: the last two arguments are `--outdir <out>` then the input. */
  const fakeSoffice = () =>
    tool(
      'soffice',
      'for a; do last="$a"; done; out=""; prev=""; for a; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; done; mkdir -p "$out"; { printf "%%PDF-fake "; cat "$last"; } > "$out/input.pdf"',
    );

  it('converts Office files to PDF with an isolated LibreOffice profile and cleans up', async () => {
    const argsFile = join(dir, 'args.txt');
    const soffice = await tool('soffice-args', `printf '%s\\n' "$@" > ${argsFile}; ${await fakeSoffice()} "$@"`);
    const convert = converter({ soffice });
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('preview-')).length;
    const pdf = await convert({ from: 'docx', to: 'pdf', data: Buffer.from('fictional docx') });
    expect(pdf.toString()).toBe('%PDF-fake fictional docx');
    const args = (await import('node:fs')).readFileSync(argsFile, 'utf8').split('\n');
    expect(args).toEqual(expect.arrayContaining(['--headless', '--convert-to', 'pdf']));
    expect(args[0]).toMatch(/^-env:UserInstallation=file:\/\/.*\/profile$/);
    expect(args.find((a) => a.endsWith('input.docx'))).toBeTruthy();
    expect((await readdir(tmpdir())).filter((n) => n.startsWith('preview-')).length).toBe(before);
  });

  it('fails when LibreOffice writes nothing (it exits 0 on unreadable files) or exits non-zero', async () => {
    const silent = converter({ soffice: await tool('soffice-silent', 'exit 0') });
    await expect(silent({ from: 'xlsx', to: 'pdf', data: Buffer.from('x') })).rejects.toMatchObject({
      reason: 'failed',
    });
    const broken = converter({ soffice: await tool('soffice-broken', 'exit 3') });
    await expect(broken({ from: 'pptx', to: 'pdf', data: Buffer.from('x') })).rejects.toMatchObject({
      reason: 'failed',
    });
  });

  it('kills a conversion that runs too long', async () => {
    const slow = converter({ soffice: await tool('soffice-slow', 'sleep 5'), timeoutMs: 200 });
    await expect(slow({ from: 'doc', to: 'pdf', data: Buffer.from('x') })).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('converts HEIC to JPEG, taking the first image of a multi-image file', async () => {
    const single = converter({
      heifConvert: await tool('heif-single', 'for a; do last="$a"; done; printf "jpeg-q-$2" > "$last"'),
    });
    expect((await single({ from: 'heic', to: 'jpeg', data: Buffer.from('heic') })).toString()).toBe('jpeg-q-85');
    const multi = converter({
      heifConvert: await tool(
        'heif-multi',
        'for a; do last="$a"; done; base="${last%.jpg}"; printf two > "$base-2.jpg"; printf one > "$base-1.jpg"',
      ),
    });
    expect((await multi({ from: 'heic', to: 'jpeg', data: Buffer.from('heic') })).toString()).toBe('one');
    const none = converter({ heifConvert: await tool('heif-none', 'exit 0') });
    await expect(none({ from: 'heic', to: 'jpeg', data: Buffer.from('heic') })).rejects.toBeInstanceOf(ConversionError);
  });

  it('accepts only the supported pairs', async () => {
    expect(isSupported('docx', 'pdf')).toBe(true);
    expect(isSupported('heic', 'jpeg')).toBe(true);
    expect(isSupported('heic', 'pdf')).toBe(false);
    expect(isSupported('pdf', 'pdf')).toBe(false);
    expect(isSupported('docx', 'jpeg')).toBe(false);
    await expect(converter()({ from: 'pdf' as never, to: 'pdf', data: Buffer.from('x') })).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });
});
