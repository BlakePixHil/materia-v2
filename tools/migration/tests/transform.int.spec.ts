import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256 } from '../src/export/jsonl.ts';
import { exportFixtureRun, FIXTURE_PROFILE, FIXTURE_RUN_ID } from '../src/transform/testing.ts';
import { transformCommand } from '../src/transform.ts';

/**
 * MIG-03 against the Storage emulator: the fixtures' export in a run of the dev migration bucket,
 * then `materia-migrate transform --env emulator`. Every file it writes back must be the golden
 * output byte for byte, and its report must list them with their sha256. Fictional data only.
 */

const RUNS = 'materia-v2-dev-migration';
const OWNER = { authorization: 'Bearer owner' };
const host = process.env['FIREBASE_STORAGE_EMULATOR_HOST'] ?? '';
const ROOT = host.includes('://') ? host : `http://${host}`;
const GOLDEN = join(import.meta.dirname, '../fixtures/golden');

async function ok(res: Promise<Response>): Promise<Response> {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r;
}

async function put(name: string, text: string): Promise<void> {
  const query = new URLSearchParams({ uploadType: 'media', name: `runs/${FIXTURE_RUN_ID}/${name}` });
  await ok(
    fetch(`${ROOT}/upload/storage/v1/b/${RUNS}/o?${query}`, {
      method: 'POST',
      headers: { ...OWNER, 'content-type': 'application/octet-stream' },
      body: text,
    }),
  );
}

async function get(name: string): Promise<string> {
  const url = `${ROOT}/b/${RUNS}/o/${encodeURIComponent(`runs/${FIXTURE_RUN_ID}/${name}`)}?alt=media`;
  return (await ok(fetch(url, { headers: OWNER }))).text();
}

describe('materia-migrate transform on the Storage emulator', () => {
  it('reads the run from the migration bucket and writes the golden output back to it', async () => {
    const profileHash = sha256(await readFile(FIXTURE_PROFILE, 'utf8'));
    const { files } = await exportFixtureRun({ profileHash });
    for (const [name, text] of files) await put(name, text);

    const logs: string[] = [];
    const log = (line: string) => void logs.push(line);
    const argv = ['--run', FIXTURE_RUN_ID, '--profile', FIXTURE_PROFILE, '--target-org', 'new', '--env', 'emulator'];
    expect(await transformCommand(argv, log, log)).toBe(0);

    const report = JSON.parse(await get('report.json')) as {
      rejects: unknown[];
      profileChanged: boolean;
      files: Record<string, { sha256: string }>;
    };
    expect(report.rejects).toEqual([]);
    expect(report.profileChanged).toBe(false);
    expect(Object.keys(report.files)).toHaveLength(15);
    for (const [name, entry] of Object.entries(report.files)) {
      const text = await get(name);
      expect(sha256(text)).toBe(entry.sha256);
      expect(text).toBe(await readFile(join(GOLDEN, name), 'utf8'));
    }
    expect(logs.join('\n')).not.toMatch(/Alex|Rivers|@example/);
  });
});
