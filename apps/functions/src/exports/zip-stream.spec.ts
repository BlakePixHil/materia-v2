import { createHash } from 'node:crypto';

import { unzipSync } from 'fflate';

import { assertSafeEntryName, measured, ZipWriter, type ZipEntryResult } from './zip-stream';

/** The streaming zip writer of the full export (SEC-05), read back with fflate. Everything is fictional. */

const MODIFIED = new Date('2026-10-07T01:02:04.000Z');
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

async function* lines(count: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < count; i++) yield Buffer.from(`{"id":"r${i}","name":"Fictional record ${i}"}\n`);
}

async function build(zip64From?: number) {
  const zip = new ZipWriter({ modified: MODIFIED, ...(zip64From === undefined ? {} : { zip64From }) });
  const results: ZipEntryResult[] = [];
  const pdf = Buffer.from('%PDF-1.7 fictional will\n%%EOF\n');
  async function* all(): AsyncGenerator<Uint8Array> {
    results.push(yield* zip.entry('data/matters.jsonl', lines(500), { compress: true }));
    results.push(yield* zip.entry('files/matters/m1/d1/v2/Will – signed.pdf', [pdf], { compress: false }));
    results.push(yield* zip.entry('data/empty.jsonl', [], { compress: true }));
    yield* zip.finish();
  }
  const bytes = await collect(all());
  return { zip, bytes, results, pdf };
}

describe('ZipWriter', () => {
  it('writes a zip that unzips to the same content, with each entry’s hash', async () => {
    const { zip, bytes, results, pdf } = await build();
    expect(zip.offset).toBe(bytes.length);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual([
      'data/matters.jsonl',
      'files/matters/m1/d1/v2/Will – signed.pdf',
      'data/empty.jsonl',
    ]);
    const jsonl = Buffer.from(files['data/matters.jsonl'] as Uint8Array).toString('utf8');
    expect(jsonl.split('\n')).toHaveLength(501);
    expect(Buffer.from(files['files/matters/m1/d1/v2/Will – signed.pdf'] as Uint8Array)).toEqual(pdf);
    expect(results.map((r) => [r.name, r.bytes, r.sha256])).toEqual([
      ['data/matters.jsonl', Buffer.byteLength(jsonl), sha(jsonl)],
      ['files/matters/m1/d1/v2/Will – signed.pdf', pdf.length, sha(pdf)],
      ['data/empty.jsonl', 0, sha('')],
    ]);
    // JSON is deflated; documents are stored as they are.
    expect(results[0]?.compressedBytes).toBeLessThan(results[0]?.bytes ?? 0);
    expect(results[1]?.compressedBytes).toBe(pdf.length);
    // The end of central directory record, without zip64.
    expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
    expect(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(-1);
  });

  it('switches to zip64 records past the limit', async () => {
    const plain = await build();
    const { bytes } = await build(0);
    expect(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBeGreaterThan(0);
    expect(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBeGreaterThan(0);
    // The 32-bit fields say "see zip64".
    expect(bytes.readUInt32LE(bytes.length - 6)).toBe(0xffffffff);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toHaveLength(3);
    expect(files['data/matters.jsonl']).toEqual(unzipSync(plain.bytes)['data/matters.jsonl']);
  });

  it('refuses unsafe names and entries after the end', async () => {
    for (const name of ['../evil', '/abs', 'a//b', 'a\\b', 'a/./b', 'tab\tname']) {
      expect(() => assertSafeEntryName(name)).toThrow('Unsafe');
    }
    expect(() => assertSafeEntryName('files/matters/m1/Will (2).pdf')).not.toThrow();
    const zip = new ZipWriter({ modified: MODIFIED });
    await collect(zip.finish());
    await expect(collect(zip.entry('late.txt', [Buffer.from('x')], { compress: false }))).rejects.toThrow('finished');
  });

  it('passes on a failure from the content', async () => {
    const zip = new ZipWriter({ modified: MODIFIED });
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('{"a":1}\n');
      throw new Error('Firestore unavailable');
    }
    await expect(collect(zip.entry('data/a.jsonl', broken(), { compress: true }))).rejects.toThrow(
      'Firestore unavailable',
    );
  });

  it('measures the whole zip as it streams', async () => {
    const zip = new ZipWriter({ modified: MODIFIED });
    async function* all(): AsyncGenerator<Uint8Array> {
      yield* zip.entry('README.md', [Buffer.from('# Fictional\n')], { compress: true });
      yield* zip.finish();
    }
    const counted = measured(all());
    expect(() => counted.result()).toThrow();
    const bytes = await collect(counted.chunks);
    expect(counted.result()).toEqual({ sizeBytes: bytes.length, sha256: sha(bytes) });
  });
});
