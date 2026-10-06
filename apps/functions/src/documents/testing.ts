import { createHash } from 'node:crypto';

import * as CFB from 'cfb';
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

export interface SampleAttachment {
  fileName: string;
  mime: string;
  content: string | Uint8Array;
}

const DEFAULT_ATTACHMENTS: SampleAttachment[] = [
  { fileName: 'Inventory of assets.txt', mime: 'text/plain', content: 'Fictional inventory: one bicycle.\n' },
];

/** A fictional .eml (MIME, base64 attachments). */
export function sampleEml({
  subject = 'Fictional valuation letter',
  text = 'Please find the fictional valuation attached.',
  attachments = DEFAULT_ATTACHMENTS,
} = {}): Buffer {
  const boundary = 'fictional-boundary-1';
  const parts = [
    'From: Rowan Example <rowan@example.test>',
    'To: Sam Sample <sam@example.test>',
    'Cc: Kit Placeholder <kit@example.test>',
    `Subject: ${subject}`,
    'Date: Mon, 05 Oct 2026 09:30:00 +1100',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    ...attachments.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: ${a.mime}; name="${a.fileName}"`,
      `Content-Disposition: attachment; filename="${a.fileName}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(a.content).toString('base64'),
    ]),
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(parts.join('\r\n'));
}

/**
 * A fictional Outlook .msg: a compound file with the MAPI property streams a reader needs
 * (subject, body, sender, one recipient, attachments). Built with `cfb`, test-only.
 */
export function sampleMsg({
  subject = 'Fictional settlement statement',
  body = 'The fictional settlement statement is attached.',
  attachments = DEFAULT_ATTACHMENTS,
} = {}): Buffer {
  const utf16 = (text: string) => Buffer.from(text, 'utf16le');
  /** A property stream: a header, then 16-byte fixed-length properties (tag, flags, value). */
  const properties = (headerBytes: number, entries: [tag: number, value: number][] = []) => {
    const out = Buffer.alloc(headerBytes + entries.length * 16);
    entries.forEach(([tag, value], i) => {
      out.writeUInt32LE(tag, headerBytes + i * 16);
      out.writeUInt32LE(6, headerBytes + i * 16 + 4);
      out.writeUInt32LE(value, headerBytes + i * 16 + 8);
    });
    return out;
  };
  const file = CFB.utils.cfb_new();
  const add = (name: string, data: Buffer) => CFB.utils.cfb_add(file, name, data);
  const top = properties(32);
  top.writeUInt32LE(1, 8); // next recipient id
  top.writeUInt32LE(attachments.length, 12); // next attachment id
  top.writeUInt32LE(1, 16); // recipients
  top.writeUInt32LE(attachments.length, 20); // attachments
  add('/__properties_version1.0', top);
  add('/__substg1.0_0037001F', utf16(subject));
  add('/__substg1.0_1000001F', utf16(body));
  add('/__substg1.0_0C1A001F', utf16('Rowan Example'));
  add('/__substg1.0_0C1F001F', utf16('rowan@example.test'));
  const recipient = '/__recip_version1.0_#00000000';
  add(`${recipient}/__properties_version1.0`, properties(8, [[0x0c150003, 1]]));
  add(`${recipient}/__substg1.0_3001001F`, utf16('Sam Sample'));
  add(`${recipient}/__substg1.0_39FE001F`, utf16('sam@example.test'));
  attachments.forEach((a, i) => {
    const folder = `/__attach_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`;
    add(`${folder}/__properties_version1.0`, properties(8));
    add(`${folder}/__substg1.0_3707001F`, utf16(a.fileName));
    add(`${folder}/__substg1.0_370E001F`, utf16(a.mime));
    add(`${folder}/__substg1.0_37010102`, Buffer.from(a.content));
  });
  // cfb adds a marker stream of its own; Outlook files don't have it.
  CFB.utils.cfb_del(file, '/\u0001Sh33tJ5');
  return Buffer.from(CFB.write(file, { type: 'buffer' }) as Uint8Array);
}

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
  async writeStream(path: string, chunks: AsyncIterable<Uint8Array>, options: WriteOptions) {
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) parts.push(chunk);
    return this.write(path, Buffer.concat(parts), options);
  }
  async remove(path: string, generation?: string) {
    const found = this.objects.get(path);
    if (found && (!generation || found.object.generation === generation)) this.objects.delete(path);
  }
  async list(prefix: string) {
    return [...this.objects.values()].map((entry) => entry.object).filter((object) => object.path.startsWith(prefix));
  }
  async purge(prefix: string) {
    const paths = [...this.objects.keys()].filter((path) => path.startsWith(prefix));
    for (const path of paths) this.objects.delete(path);
    return paths.length;
  }
}
