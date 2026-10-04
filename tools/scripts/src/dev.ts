/**
 * `materia-scripts dev` (`pnpm dev`): the whole local stack (FND-06).
 *
 * 1. Checks the emulator and dev-server ports are free, and says which process to stop if not.
 * 2. Builds functions, then starts the emulators (project demo-materia) with `--import ./.emulator-data
 *    --export-on-exit`, so local data survives restarts (`--fresh` starts empty instead).
 * 3. Seeds the fictional practice once the emulators are up, if they are empty.
 * 4. Serves the web app with HMR (environment.ts points at the emulators).
 *
 * Ctrl+C stops everything; the emulators export their data on the way out.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FIREBASE_CONFIG = path.join(ROOT, 'firebase.json');
const EXPORT_DIR = path.join(ROOT, '.emulator-data');
const PROJECT_ID = 'demo-materia';
const WEB_PORT = 4200;

interface EmulatorPorts {
  [emulator: string]: { port: number; host?: string };
}

/** The ports firebase.json assigns, plus the web dev server. */
export function devPorts(
  config = JSON.parse(readFileSync(FIREBASE_CONFIG, 'utf8')) as { emulators: EmulatorPorts },
): { name: string; port: number }[] {
  const ports = Object.entries(config.emulators)
    .filter(([, value]) => typeof value === 'object' && value !== null && 'port' in value)
    .map(([name, value]) => ({ name, port: (value as { port: number }).port }));
  return [...ports, { name: 'web', port: WEB_PORT }];
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

/** Names the ports in use, so the message can say what to stop. */
export async function busyPorts(
  ports: { name: string; port: number }[],
  check = isPortFree,
): Promise<{ name: string; port: number }[]> {
  const results = await Promise.all(ports.map(async (p) => ({ ...p, free: await check(p.port) })));
  return results.filter((p) => !p.free).map(({ name, port }) => ({ name, port }));
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(command, args, { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' });
}

function runToEnd(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    run(command, args, env).once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

async function waitFor(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { fresh: { type: 'boolean', default: false }, 'no-seed': { type: 'boolean', default: false } },
  });
  const ports = devPorts();
  const busy = await busyPorts(ports);
  if (busy.length) {
    throw new Error(
      `These ports are already in use: ${busy.map((p) => `${p.port} (${p.name})`).join(', ')}.\n` +
        'Stop the other emulator or dev server (for example `lsof -i :8080`), then run `pnpm dev` again.',
    );
  }

  await runToEnd('pnpm', ['nx', 'run', 'functions:build']);

  const emulatorArgs = [
    'exec',
    'firebase',
    'emulators:start',
    '--project',
    PROJECT_ID,
    '--config',
    FIREBASE_CONFIG,
    '--export-on-exit',
    EXPORT_DIR,
  ];
  if (!values.fresh && existsSync(EXPORT_DIR)) emulatorArgs.push('--import', EXPORT_DIR);
  const children: ChildProcess[] = [run('pnpm', emulatorArgs)];

  const stop = () => {
    for (const child of children) child.kill('SIGINT');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const port = (name: string) => ports.find((p) => p.name === name)?.port;
  await waitFor(`http://127.0.0.1:${port('firestore')}/`);
  await waitFor(`http://127.0.0.1:${port('auth')}/`);

  if (!values['no-seed']) {
    await runToEnd('pnpm', ['materia-scripts', 'seed', '--if-empty'], {
      ...process.env,
      GCLOUD_PROJECT: PROJECT_ID,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${port('firestore')}`,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${port('auth')}`,
      FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${port('storage')}`,
    });
  }

  children.push(run('pnpm', ['nx', 'serve', 'web', `--port=${WEB_PORT}`]));
  console.log(
    `\nMateria: http://localhost:${WEB_PORT}  ·  Emulator UI: http://127.0.0.1:${port('ui')}  ·  accounts in AGENTS.md (Run locally)\n`,
  );

  await new Promise<void>((resolve) => {
    let remaining = children.length;
    for (const child of children)
      child.once('exit', () => {
        stop();
        if (--remaining === 0) resolve();
      });
  });
}
