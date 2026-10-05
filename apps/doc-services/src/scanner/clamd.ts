import { connect } from 'node:net';

/**
 * A minimal clamd client (the `z`-prefixed, NUL-terminated commands of clamd's socket protocol):
 * `PING` for health and `INSTREAM` for a scan, sending the bytes in length-prefixed chunks.
 */
export interface ClamdAddress {
  /** A Unix socket path (the image's `LocalSocket`). */
  socket: string;
}

export type ClamdVerdict = { verdict: 'clean' } | { verdict: 'infected'; signature: string };

/** clamd answered with an error, or couldn't be reached. Never a verdict. */
export class ClamdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClamdError';
  }
}

/** clamd's INSTREAM chunk size (StreamMaxLength is the limit on the total, not this). */
const CHUNK_BYTES = 64 * 1024;

/** Sends one command (and optional chunked body) and resolves with the NUL-terminated reply. */
function exchange(address: ClamdAddress, command: string, body?: Uint8Array, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(address.socket);
    const replies: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null, reply?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(reply ?? '');
    };
    socket.setTimeout(timeoutMs, () => finish(new ClamdError('clamd timed out')));
    socket.on('error', (error) => finish(new ClamdError(`clamd unreachable: ${error.message}`)));
    socket.on('data', (chunk: Buffer) => {
      replies.push(chunk);
      const all = Buffer.concat(replies);
      const end = all.indexOf(0);
      if (end >= 0) finish(null, all.subarray(0, end).toString('utf8'));
    });
    socket.on('end', () => finish(null, Buffer.concat(replies).toString('utf8').replace(/\0+$/, '')));
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (!body) return;
      for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
        const chunk = body.subarray(offset, offset + CHUNK_BYTES);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
    });
  });
}

export async function ping(address: ClamdAddress, timeoutMs = 5_000): Promise<boolean> {
  try {
    return (await exchange(address, 'PING', undefined, timeoutMs)).trim() === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Scans bytes with INSTREAM. clamd answers `stream: OK`, `stream: <signature> FOUND` or
 * `<message> ERROR` (for example `INSTREAM size limit exceeded. ERROR`).
 */
export async function scanBytes(address: ClamdAddress, data: Uint8Array): Promise<ClamdVerdict> {
  const reply = (await exchange(address, 'INSTREAM', data)).trim();
  if (reply === 'stream: OK') return { verdict: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found?.[1]) return { verdict: 'infected', signature: found[1].slice(0, 200) };
  throw new ClamdError(reply.endsWith('ERROR') ? reply : 'unexpected clamd reply');
}
