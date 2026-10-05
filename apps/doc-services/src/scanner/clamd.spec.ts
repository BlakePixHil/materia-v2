import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClamdError, ping, scanBytes } from './clamd';

/** A stand-in clamd on a Unix socket: PING → PONG; INSTREAM reassembles the chunks and judges them. */
function fakeClamd(socket: string, judge: (data: Buffer) => string): Promise<Server> {
  const server = createServer((conn) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const chunks: Buffer[] = [];
    conn.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        command = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        if (command === 'zPING') return void conn.end('PONG\0');
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) return void conn.end(`${judge(Buffer.concat(chunks))}\0`);
        if (buffer.length < 4 + length) return;
        chunks.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  return new Promise((resolve) => server.listen(socket, () => resolve(server)));
}

describe('clamd client', () => {
  let dir: string;
  let server: Server;
  let received: Buffer[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clamd-'));
    received = [];
    server = await fakeClamd(join(dir, 'clamd.sock'), (data) => {
      received.push(data);
      const text = data.toString();
      if (text.includes('fictional-eicar')) return 'stream: Eicar-Test-Signature FOUND';
      if (text.includes('too-big')) return 'INSTREAM size limit exceeded. ERROR';
      if (text.includes('odd')) return 'something else';
      return 'stream: OK';
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const address = () => ({ socket: join(dir, 'clamd.sock') });

  it('pings', async () => {
    expect(await ping(address())).toBe(true);
    expect(await ping({ socket: join(dir, 'missing.sock') })).toBe(false);
  });

  it('streams the bytes in chunks and reads a clean verdict', async () => {
    const data = Buffer.alloc(200 * 1024, 'a'); // several 64 KiB chunks
    await expect(scanBytes(address(), data)).resolves.toEqual({ verdict: 'clean' });
    expect(received[0]?.equals(data)).toBe(true);
  });

  it('reads an infected verdict with its signature', async () => {
    await expect(scanBytes(address(), Buffer.from('fictional-eicar'))).resolves.toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('turns clamd errors, odd replies and an unreachable clamd into ClamdError', async () => {
    await expect(scanBytes(address(), Buffer.from('too-big'))).rejects.toThrow('INSTREAM size limit exceeded. ERROR');
    await expect(scanBytes(address(), Buffer.from('odd'))).rejects.toThrow('unexpected clamd reply');
    await expect(scanBytes({ socket: join(dir, 'missing.sock') }, Buffer.from('x'))).rejects.toBeInstanceOf(ClamdError);
  });

  it('scans an empty file', async () => {
    await expect(scanBytes(address(), Buffer.alloc(0))).resolves.toEqual({ verdict: 'clean' });
  });
});
