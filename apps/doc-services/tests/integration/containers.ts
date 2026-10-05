import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Runs an image detached with a published port and waits for `/healthz`; returns its URL and a stop. */
export async function startContainer(
  image: string,
  { readyTimeoutMs = 240_000, args = [] as string[] } = {},
): Promise<{ url: string; stop: () => Promise<void>; logs: () => Promise<string> }> {
  const { stdout } = await exec('docker', ['run', '-d', '-p', '127.0.0.1::8080', '-e', 'PORT=8080', ...args, image]);
  const id = stdout.trim();
  const port = (await exec('docker', ['port', id, '8080/tcp'])).stdout.trim().split('\n')[0]?.split(':').pop();
  const url = `http://127.0.0.1:${port}`;
  const logs = async () => {
    const out = await exec('docker', ['logs', id]).catch(() => ({ stdout: '', stderr: '' }));
    return `${out.stdout}\n${out.stderr}`;
  };
  const stop = async () => void (await exec('docker', ['rm', '-f', id]).catch(() => undefined));
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    const ok = await fetch(`${url}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return { url, stop, logs };
    if (Date.now() > deadline) {
      const output = await logs();
      await stop();
      throw new Error(`${image} did not become healthy:\n${output.slice(-4000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
