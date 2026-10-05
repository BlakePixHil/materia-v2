import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startContainer } from './containers';

/**
 * The preview image (CORE-12a): a fictional .docx becomes a PDF with LibreOffice and a fictional
 * HEIC photo becomes a JPEG with heif-convert. Runs only with PREVIEW_IMAGE set (CI builds it).
 */
const image = process.env['PREVIEW_IMAGE'];
const FIXTURES = join(__dirname, '../fixtures');

describe.skipIf(!image)('preview image', () => {
  let service: Awaited<ReturnType<typeof startContainer>>;

  beforeAll(async () => {
    service = await startContainer(image as string);
  });
  afterAll(async () => {
    await service?.stop();
  });

  const convert = async (from: string, to: string, body: Buffer) =>
    fetch(`${service.url}/convert?from=${from}&to=${to}`, { method: 'POST', body: new Uint8Array(body) });

  it('converts a .docx to PDF', async () => {
    const response = await convert('docx', 'pdf', await readFile(join(FIXTURES, 'sample.docx')));
    expect(response.status, await service.logs()).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const pdf = Buffer.from(await response.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('converts a HEIC photo to JPEG', async () => {
    const response = await convert('heic', 'jpeg', await readFile(join(FIXTURES, 'sample.heic')));
    expect(response.status, await service.logs()).toBe(200);
    const jpeg = Buffer.from(await response.arrayBuffer());
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });
});
