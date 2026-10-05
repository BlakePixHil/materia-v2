import { spawn, type ChildProcess } from 'node:child_process';

import { createLog } from './core/http';
import { ping, scanBytes, type ClamdAddress } from './scanner/clamd';
import { scannerServer } from './scanner/server';

/**
 * The ClamAV scan service (CORE-12a, ADR-028), the container's entry point. It starts clamd with the
 * signatures baked into the image, waits until clamd answers, starts freshclam as a daemon (it
 * checks for new signatures on start and every hour and tells clamd to reload), then serves the
 * scan contract on $PORT. Cloud Run sends no traffic until the port listens, so a cold start waits
 * for the signatures to load. If clamd dies, the process exits and Cloud Run replaces the instance.
 */

const log = createLog({ service: 'clamav' });
const address: ClamdAddress = { socket: process.env['CLAMD_SOCKET'] ?? '/tmp/clamd.sock' };
const port = Number(process.env['PORT'] ?? 8080);
const MAX_BYTES = 55 * 1024 * 1024;
const CLAMD_READY_TIMEOUT_MS = 5 * 60 * 1000;

function start(command: string, args: string[], name: string, fatal: boolean): ChildProcess {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => {
    log[fatal ? 'error' : 'warn'](`${name} exited`, { code, signal });
    if (fatal) process.exit(1);
  });
  return child;
}

async function main(): Promise<void> {
  const managed = process.env['CLAMD_MANAGED'] !== '0';
  if (managed) start('clamd', ['--foreground', '--config-file=/etc/clamav/clamd.conf'], 'clamd', true);
  const startedAt = Date.now();
  while (!(await ping(address))) {
    if (Date.now() - startedAt > CLAMD_READY_TIMEOUT_MS) {
      log.error('clamd did not start');
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log.info('clamd ready', { ms: Date.now() - startedAt });
  // Not fatal: if the mirror can't be reached, the image's signatures (at most a day old) still scan.
  if (managed)
    start('freshclam', ['--foreground', '--daemon', '--config-file=/etc/clamav/freshclam.conf'], 'freshclam', false);
  scannerServer({
    scan: (data) => scanBytes(address, data),
    ping: () => ping(address),
    log,
    maxBytes: MAX_BYTES,
  }).listen(port, () => log.info('listening', { port }));
}

void main();
