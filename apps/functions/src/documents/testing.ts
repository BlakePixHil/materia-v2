import { createHash } from 'node:crypto';

import { PDFDocument, PDFName } from 'pdf-lib';

import type { FileStore, StoredObject, WriteOptions } from './files';

/** A fictional PDF with `pages` blank pages; `encrypted` adds a (dummy) password handler entry. */
export async function samplePdf({ pages = 1, encrypted = false } = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage();
  if (encrypted) {
    pdf.context.trailerInfo.Encrypt = pdf.context.register(
      pdf.context.obj({ Filter: PDFName.of('Standard'), V: 2, R: 3, Length: 128 }),
    );
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

export const sha256Of = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** An in-memory bucket for unit tests: generations count up, and writes never overwrite. */
export class MemoryFiles implements FileStore {
  readonly objects = new Map<string, { data: Buffer; object: StoredObject }>();
  private generation = 1000;
  constructor(readonly bucket = 'test-bucket') {}

  put(path: string, data: Uint8Array | string, extra: Partial<StoredObject> = {}): StoredObject {
    const bytes = Buffer.from(data);
    const object: StoredObject = {
      path,
      size: bytes.length,
      generation: String(++this.generation),
      metadata: {},
      timeCreated: new Date('2026-10-05T00:00:00Z'),
      ...extra,
    };
    this.objects.set(path, { data: bytes, object });
    return object;
  }

  async stat(path: string) {
    return this.objects.get(path)?.object ?? null;
  }
  async read(path: string, generation?: string) {
    const found = this.objects.get(path);
    if (!found || (generation && found.object.generation !== generation)) return null;
    return Buffer.from(found.data);
  }
  async write(path: string, data: Uint8Array, options: WriteOptions) {
    if (this.objects.has(path)) return 'exists' as const;
    this.put(path, data, {
      contentType: options.contentType,
      metadata: { ...options.metadata, ...(options.disposition ? { contentDisposition: options.disposition } : {}) },
    });
    return 'written' as const;
  }
  async remove(path: string, generation?: string) {
    const found = this.objects.get(path);
    if (found && (!generation || found.object.generation === generation)) this.objects.delete(path);
  }
  async list(prefix: string) {
    return [...this.objects.values()].map((entry) => entry.object).filter((object) => object.path.startsWith(prefix));
  }
}
