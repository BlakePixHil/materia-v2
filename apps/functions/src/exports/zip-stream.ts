import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

/**
 * A streaming zip writer for the practice's full export (SEC-05, ADR-058). Each entry's bytes are
 * yielded as they are made, so a 10 GB part goes to Storage without ever sitting in memory or on
 * disk: an entry is a local header, its data (stored, or deflated for JSON and text) and a data
 * descriptor with the CRC-32 and sizes, which are only known at the end. Zip64 records are added
 * where an offset, a size or the entry count needs them, so parts over 4 GiB open everywhere zip64
 * is read (Windows, macOS, `unzip`, Python). A single entry stays under 4 GiB: the export rolls a
 * JSONL file over at 1 GiB, and documents are at most 50 MB.
 *
 * Every entry is also hashed (SHA-256 of its content, as unzipped) for `manifest.json`.
 */

/** Where 32-bit zip fields stop and zip64 takes over. */
export const ZIP32_MAX = 0xffffffff;
const ZIP16_MAX = 0xffff;

/** General purpose flags: sizes and CRC in a data descriptor (bit 3), UTF-8 names (bit 11). */
const FLAGS = 0x0808;
const STORED = 0;
/**
 * "Made by" Unix, zip 6.3 (UTF-8 names), with each file's mode (0644, a regular file) in the
 * external attributes: Info-ZIP then reads the names as UTF-8 and unzips readable files.
 */
const MADE_BY = 0x033f;
const FILE_MODE = (0o100644 << 16) >>> 0;
const DEFLATED = 8;

/** One entry as the central directory records it. */
interface CentralEntry {
  name: Buffer;
  method: number;
  crc: number;
  compressedBytes: number;
  bytes: number;
  offset: number;
}

/** What one entry came to. */
export interface ZipEntryResult {
  name: string;
  /** Its content, as unzipped. */
  bytes: number;
  sha256: string;
  /** Its size inside the zip. */
  compressedBytes: number;
}

export interface ZipWriterOptions {
  /** The entries' modification time (the export's). */
  modified: Date;
  /** Tests: where zip64 starts, to exercise it without writing 4 GiB. */
  zip64From?: number;
}

/** A name safe to unzip anywhere: forward slashes, no `..`, no absolute paths or control characters. */
export function assertSafeEntryName(name: string): void {
  // eslint-disable-next-line no-control-regex
  const bad = /[\\\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || name.length > 1024;
  if (bad || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Unsafe zip entry name');
  }
}

/** DOS date and time (two-second resolution, from 1980), in UTC. */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getUTCFullYear(), 1980);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

async function* bytesOf(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) if (chunk.length) yield chunk;
}

export class ZipWriter {
  /** Bytes yielded so far: the next entry's offset, and the zip's size once finished. */
  offset = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly when: { time: number; date: number };
  private readonly zip64From: number;
  private finished = false;

  constructor(options: ZipWriterOptions) {
    this.when = dosDateTime(options.modified);
    this.zip64From = options.zip64From ?? ZIP32_MAX;
  }

  /** How many entries so far. */
  get count(): number {
    return this.entries.length;
  }

  private emit(chunk: Uint8Array): Uint8Array {
    this.offset += chunk.length;
    return chunk;
  }

  /**
   * One file: yields its local header, its data and its data descriptor, and returns its size and
   * hash. `compress` deflates it (JSON and text); documents are stored as they are.
   */
  async *entry(
    name: string,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: { compress: boolean },
  ): AsyncGenerator<Uint8Array, ZipEntryResult> {
    if (this.finished) throw new Error('The zip is finished');
    assertSafeEntryName(name);
    const encoded = Buffer.from(name, 'utf8');
    const offset = this.offset;
    const method = options.compress ? DEFLATED : STORED;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.when.time, 10);
    header.writeUInt16LE(this.when.date, 12);
    // CRC-32 and sizes (14-25) are zero: the data descriptor carries them.
    header.writeUInt16LE(encoded.length, 26);
    header.writeUInt16LE(0, 28);
    yield this.emit(header);
    yield this.emit(encoded);

    const hash = createHash('sha256');
    let crc = 0;
    let bytes = 0;
    async function* tapped(): AsyncGenerator<Uint8Array> {
      for await (const chunk of bytesOf(source)) {
        hash.update(chunk);
        crc = crc32(chunk, crc);
        bytes += chunk.length;
        yield chunk;
      }
    }

    let compressedBytes = 0;
    if (options.compress) {
      const input = Readable.from(tapped());
      const deflate = createDeflateRaw({ level: 6 });
      input.on('error', (error) => deflate.destroy(error));
      input.pipe(deflate);
      try {
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          compressedBytes += chunk.length;
          yield this.emit(chunk);
        }
      } finally {
        input.destroy();
      }
    } else {
      for await (const chunk of tapped()) {
        compressedBytes += chunk.length;
        yield this.emit(chunk);
      }
    }
    if (bytes >= ZIP32_MAX || compressedBytes >= ZIP32_MAX) throw new Error('A zip entry must stay under 4 GiB');

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressedBytes, 8);
    descriptor.writeUInt32LE(bytes, 12);
    yield this.emit(descriptor);

    this.entries.push({ name: encoded, method, crc: crc >>> 0, compressedBytes, bytes, offset });
    return { name, bytes, sha256: hash.digest('hex'), compressedBytes };
  }

  /** The central directory and end records (zip64 ones when needed). Returns the zip's size. */
  async *finish(): AsyncGenerator<Uint8Array, number> {
    if (this.finished) throw new Error('The zip is finished');
    this.finished = true;
    const start = this.offset;
    for (const entry of this.entries) {
      const zip64 = entry.offset >= this.zip64From;
      const extra = zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
      if (zip64) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(entry.offset), 4);
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(MADE_BY, 4);
      header.writeUInt16LE(zip64 ? 45 : 20, 6);
      header.writeUInt16LE(FLAGS, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(this.when.time, 12);
      header.writeUInt16LE(this.when.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedBytes, 20);
      header.writeUInt32LE(entry.bytes, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      // Comment length, disk number and internal attributes (32-37) are zero.
      header.writeUInt32LE(FILE_MODE, 38);
      header.writeUInt32LE(zip64 ? ZIP32_MAX : entry.offset, 42);
      yield this.emit(Buffer.concat([header, entry.name, extra]));
    }
    const directoryBytes = this.offset - start;
    const count = this.entries.length;
    const zip64 = start >= this.zip64From || directoryBytes >= this.zip64From || count >= ZIP16_MAX;
    if (zip64) {
      const recordOffset = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      // This disk, and the disk the directory starts on (16-23), are zero.
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directoryBytes), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      yield this.emit(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? ZIP16_MAX : count, 8);
    end.writeUInt16LE(zip64 ? ZIP16_MAX : count, 10);
    end.writeUInt32LE(zip64 ? ZIP32_MAX : directoryBytes, 12);
    end.writeUInt32LE(zip64 ? ZIP32_MAX : start, 16);
    yield this.emit(end);
    return this.offset;
  }
}

/** Hashes and counts bytes as they pass (a whole part, for the job's output). */
export function measured(chunks: AsyncIterable<Uint8Array>): {
  chunks: AsyncGenerator<Uint8Array>;
  result: () => { sizeBytes: number; sha256: string };
} {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let digest: string | undefined;
  async function* pass(): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunks) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      yield chunk;
    }
    digest = hash.digest('hex');
  }
  return {
    chunks: pass(),
    result: () => {
      if (digest === undefined) throw new Error('The zip was not written to the end');
      return { sizeBytes, sha256: digest };
    },
  };
}
