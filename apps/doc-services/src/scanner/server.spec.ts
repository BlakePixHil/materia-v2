import { request as httpRequest } from 'node:http';

import { ClamdError } from './clamd';
import { scannerServer, type ScannerDeps } from './server';
import { listen, memoryLog } from '../testing';

describe('scanner server', () => {
  async function start(overrides: Partial<ScannerDeps> = {}) {
    const { lines, log } = memoryLog();
    const scan = vi.fn<ScannerDeps['scan']>(async (data) =>
      Buffer.from(data).toString().includes('fictional-eicar')
        ? { verdict: 'infected', signature: 'Eicar-Test-Signature' }
        : { verdict: 'clean' },
    );
    const server = await listen(scannerServer({ scan, ping: async () => true, log, maxBytes: 1024, ...overrides }));
    return { ...server, scan, lines };
  }

  it('scans the posted bytes and answers the verdict', async () => {
    const s = await start();
    try {
      const clean = await fetch(`${s.url}/scan`, { method: 'POST', body: 'fictional clean bytes' });
      expect(clean.status).toBe(200);
      expect(await clean.json()).toEqual({ verdict: 'clean' });
      expect(Buffer.from(s.scan.mock.calls[0]?.[0] ?? []).toString()).toBe('fictional clean bytes');
      const infected = await fetch(`${s.url}/scan`, { method: 'POST', body: 'fictional-eicar' });
      expect(await infected.json()).toEqual({ verdict: 'infected', signature: 'Eicar-Test-Signature' });
      // Sizes and verdicts only: never the bytes.
      expect(JSON.stringify(s.lines)).not.toContain('fictional clean bytes');
      expect(s.lines).toContainEqual(
        expect.objectContaining({ message: 'scanned', verdict: 'infected', sizeBytes: 15 }),
      );
    } finally {
      await s.close();
    }
  });

  it('answers 503 when clamd fails, so the caller treats the scanner as unavailable', async () => {
    const s = await start({ scan: async () => Promise.reject(new ClamdError('clamd timed out')) });
    try {
      const response = await fetch(`${s.url}/scan`, { method: 'POST', body: 'x' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'scanner_unavailable' });
    } finally {
      await s.close();
    }
  });

  it('refuses bodies over the limit, declared or streamed', async () => {
    const s = await start();
    try {
      const declared = await fetch(`${s.url}/scan`, { method: 'POST', body: Buffer.alloc(2048) });
      expect(declared.status).toBe(413);
      // Chunked: no content-length, so the limit is checked as the bytes arrive.
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${s.url}/scan`, { method: 'POST' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.write(Buffer.alloc(800));
        req.write(Buffer.alloc(800));
        req.end();
      });
      expect(status).toBe(413);
      expect(s.scan).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it('reports health from clamd and refuses other routes and methods', async () => {
    const down = await start({ ping: async () => false });
    try {
      expect((await fetch(`${down.url}/healthz`)).status).toBe(503);
      expect((await fetch(`${down.url}/nope`)).status).toBe(404);
      expect((await fetch(`${down.url}/scan`)).status).toBe(405);
    } finally {
      await down.close();
    }
    const up = await start();
    try {
      expect(await (await fetch(`${up.url}/healthz`)).json()).toEqual({ ok: true });
    } finally {
      await up.close();
    }
  });
});
