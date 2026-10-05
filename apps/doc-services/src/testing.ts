import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLog } from './core/http';

/** Starts a server on a free port and returns its base URL and a close function. */
export async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A log that keeps its lines for assertions. */
export function memoryLog() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: createLog({ service: 'test' }, (line) => void lines.push(JSON.parse(line))) };
}
