import { ConversionError } from './convert';
import { previewServer, type PreviewDeps } from './server';
import { listen, memoryLog } from '../testing';

describe('preview server', () => {
  async function start(convert: PreviewDeps['convert']) {
    const { lines, log } = memoryLog();
    return { ...(await listen(previewServer({ convert, log, maxBytes: 1024 }))), lines };
  }

  it('returns the converted bytes with the target content type', async () => {
    const convert = vi.fn<PreviewDeps['convert']>(async ({ to, data }) =>
      Buffer.from(`${to}:${Buffer.from(data).toString()}`),
    );
    const s = await start(convert);
    try {
      const pdf = await fetch(`${s.url}/convert?from=docx&to=pdf`, { method: 'POST', body: 'fictional' });
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      expect(await pdf.text()).toBe('pdf:fictional');
      const jpeg = await fetch(`${s.url}/convert?from=heic&to=jpeg`, { method: 'POST', body: 'photo' });
      expect(jpeg.headers.get('content-type')).toBe('image/jpeg');
      expect(s.lines).toContainEqual(expect.objectContaining({ message: 'converted', from: 'heic', to: 'jpeg' }));
      expect(JSON.stringify(s.lines)).not.toContain('fictional');
    } finally {
      await s.close();
    }
  });

  it('answers 415 for unsupported pairs, 422 for failed conversions, 413 for big files', async () => {
    const s = await start(async () => Promise.reject(new ConversionError('failed')));
    try {
      expect((await fetch(`${s.url}/convert?from=pdf&to=pdf`, { method: 'POST', body: 'x' })).status).toBe(415);
      const failed = await fetch(`${s.url}/convert?from=xls&to=pdf`, { method: 'POST', body: 'x' });
      expect(failed.status).toBe(422);
      expect(await failed.json()).toEqual({ error: 'failed' });
      const big = await fetch(`${s.url}/convert?from=xls&to=pdf`, { method: 'POST', body: Buffer.alloc(2048) });
      expect(big.status).toBe(413);
    } finally {
      await s.close();
    }
  });

  it('answers 503 for a conversion that timed out, so the caller retries', async () => {
    const s = await start(async () => Promise.reject(new ConversionError('timeout')));
    try {
      const response = await fetch(`${s.url}/convert?from=docx&to=pdf`, { method: 'POST', body: 'x' });
      expect(response.status).toBe(503);
    } finally {
      await s.close();
    }
  });

  it('serves health and refuses other routes and methods', async () => {
    const s = await start(async () => Buffer.alloc(0));
    try {
      expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
      expect((await fetch(`${s.url}/other`)).status).toBe(404);
      expect((await fetch(`${s.url}/convert?from=docx&to=pdf`)).status).toBe(405);
    } finally {
      await s.close();
    }
  });
});
