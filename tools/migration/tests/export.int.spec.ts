import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import { exportLine, withoutDownloadTokens } from '../src/export/jsonl.ts';
import { collectExport, SNAPSHOT_FILES } from '../src/export/scope.ts';
import { gcsSink } from '../src/export/sink.ts';
import { exportCommand, runExport, type ExportManifest } from '../src/export.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../src/legacy/fixtures.ts';
import { memoryReader } from '../src/legacy/reader.ts';
import { emulatorEndpoints, restReader, serverReadTime, type RestDeps } from '../src/legacy/rest.ts';
import { taggedKind, type LegacyData } from '../src/legacy/snapshot.ts';
import { loadProfile, type MappingProfile } from '../src/profile.ts';

/**
 * MIG-02 against the emulators: the synthetic legacy fixtures loaded into a `demo-legacy`
 * Firestore, Storage and Auth, exported with `materia-migrate export --env emulator` to the
 * migration bucket on the Storage emulator. The files must hold exactly the fixtures in scope
 * (the same bytes as an export of the fixtures in memory), with the manifest's counts and sha256s.
 */

const PROJECT = 'demo-legacy';
const SOURCE_BUCKET = `${PROJECT}.firebasestorage.app`;
const RUNS_BUCKET = 'materia-v2-dev-migration';
const UID = FIXTURE_UIDS.subject;
const PROFILE = `${FIXTURE_DIR}mapping-profile.json`;
const OWNER = { authorization: 'Bearer owner' };

const { docs, objects } = loadLegacyFixtures();
let endpoints: ReturnType<typeof emulatorEndpoints>;
let profile: MappingProfile;
let app: App;
const rest: RestDeps = { fetch, token: async () => 'owner' };
const root = `projects/${PROJECT}/databases/(default)/documents`;

/** A fixture value as a Firestore REST value (the inverse of rest.ts `decodeValue`). */
function encode(value: unknown): object {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number')
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  const data = value as LegacyData;
  switch (taggedKind(value)) {
    case 'timestamp':
      return { timestampValue: data['$timestamp'] };
    case 'reference':
      return { referenceValue: `${root}/${String(data['$reference'])}` };
    default:
      return { mapValue: { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) } };
  }
}

/** Fixed bytes of an object's size, so the manifest's MD5 can be checked. */
const contentOf = (name: string, size: number) => Buffer.alloc(size, name.length % 251);
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('base64');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function ok(res: Promise<Response>): Promise<Response> {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r;
}

async function runFile(runId: string, name: string): Promise<string | null> {
  const url = `${endpoints.storage}/b/${RUNS_BUCKET}/o/${encodeURIComponent(`runs/${runId}/${name}`)}?alt=media`;
  const res = await fetch(url, { headers: OWNER });
  return res.status === 404 ? null : (await ok(Promise.resolve(res))).text();
}

let lines: string[];
async function migrate(...argv: string[]): Promise<number> {
  const log = (line: string) => void lines.push(line);
  return exportCommand(
    ['--profile', PROFILE, '--source-project', PROJECT, '--source-bucket', SOURCE_BUCKET, ...argv],
    log,
    log,
  );
}

beforeAll(async () => {
  endpoints = emulatorEndpoints();
  profile = await loadProfile(PROFILE);
  await ok(
    fetch(`${endpoints.firestore.replace(/\/v1$/, '')}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
      method: 'DELETE',
    }),
  );
  await ok(
    fetch(`${endpoints.firestore}/${root}:commit`, {
      method: 'POST',
      headers: { ...OWNER, 'content-type': 'application/json' },
      body: JSON.stringify({
        writes: docs.map((doc) => ({
          update: {
            name: `${root}/${doc.path}`,
            fields: (encode(doc.data) as { mapValue: { fields: object } }).mapValue.fields,
          },
        })),
      }),
    }),
  );
  const upload = endpoints.storage.replace(/\/storage\/v1$/, '/upload/storage/v1');
  for (const object of objects) {
    const query = new URLSearchParams({ uploadType: 'media', name: object.name });
    await ok(
      fetch(`${upload}/b/${SOURCE_BUCKET}/o?${query}`, {
        method: 'POST',
        headers: { ...OWNER, 'content-type': object.contentType ?? 'application/octet-stream' },
        body: contentOf(object.name, object.size),
      }),
    );
  }
  app = initializeApp({ projectId: PROJECT }, `mig-02-int-${Date.now()}`);
  await getAuth(app).deleteUsers([UID]);
  const imported = await getAuth(app).importUsers([
    {
      uid: UID,
      email: 'alex.rivers@example.com',
      emailVerified: true,
      displayName: 'Alex Rivers',
      metadata: { creationTime: '2022-01-01T00:00:00.000Z', lastSignInTime: '2025-06-01T00:00:00.000Z' },
      providerData: [
        { uid: 'fixture-google-sub-alex-rivers', providerId: 'google.com', email: 'alex.rivers@example.com' },
      ],
    },
  ]);
  expect(imported.failureCount).toBe(0);
}, 120_000);

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(() => {
  lines = [];
});

describe('export on the emulators', () => {
  it('exports the fixtures in scope, byte for byte, with a manifest that checks out', async () => {
    expect(await migrate('--env', 'emulator', '--run-id', 'int-full')).toBe(0);
    const manifest = JSON.parse((await runFile('int-full', 'manifest.json')) ?? '') as ExportManifest;
    expect(manifest).toMatchObject({
      kind: 'full',
      sourceProject: PROJECT,
      sourceBucket: SOURCE_BUCKET,
      uid: UID,
      location: `gs://${RUNS_BUCKET}/runs/int-full/`,
      workflows: { exported: 3, excluded: 1 },
      counts: {
        profiles: 1,
        'dashboard-checklist-items': 2,
        integrations: 2,
        workspaces: 2,
        workflows: 3,
        cards: 10,
        attachments: 7,
        'checklist-templates': 2,
        referrers: 3,
        people: 2,
        auth: 1,
        'storage-objects': 9,
        notifications: 2,
      },
      downloadTokensStripped: 7,
      warnings: [],
    });
    expect(manifest.profileHash).toBe(sha256(await readFile(PROFILE, 'utf8')));

    // Every file is what the manifest says.
    const files: Record<string, string> = {};
    for (const [name, entry] of Object.entries(manifest.files)) {
      const text = (await runFile('int-full', name)) ?? '';
      files[name] = text;
      expect({
        name,
        count: text.split('\n').length - 1,
        bytes: Buffer.byteLength(text),
        sha256: sha256(text),
      }).toEqual({
        name,
        ...entry,
      });
    }

    // The Firestore files are byte for byte the export of the fixtures in memory, at the same readTime.
    const expected = await collectExport(memoryReader(docs, objects), { uid: UID, profile, readAuth: false });
    for (const file of SNAPSHOT_FILES) {
      const text = expected.files[file].map((record) => exportLine(record, manifest.readTime)).join('');
      expect({ file, sha256: manifest.files[`raw/${file}.jsonl`]?.sha256 }).toEqual({ file, sha256: sha256(text) });
    }

    // Each card is its fixture, values and all, less the download tokens.
    const fixture = new Map(docs.map((doc) => [doc.path, doc.data]));
    for (const line of (files['raw/cards.jsonl'] ?? '').trim().split('\n')) {
      const record = JSON.parse(line) as { path: string; data: LegacyData };
      expect(record.data).toEqual(withoutDownloadTokens(fixture.get(record.path), { stripped: 0 }));
    }

    // Storage objects carry the checksums of their content; nothing was copied.
    for (const line of (files['raw/storage-objects.jsonl'] ?? '').trim().split('\n')) {
      const { data } = JSON.parse(line) as {
        data: { name: string; size: number; md5Hash: string; generation: string };
      };
      expect(data.md5Hash).toBe(md5(contentOf(data.name, data.size)));
      expect(data.generation).toMatch(/^\d+$/);
    }

    // The Auth record has its sign-in facts and no secrets.
    expect(JSON.parse(files['raw/auth.jsonl'] ?? '')).toMatchObject({
      path: `auth/${UID}`,
      data: {
        email: 'alex.rivers@example.com',
        emailVerified: true,
        providers: ['google.com'],
        hasPassword: false,
        createdAt: '2022-01-01T00:00:00.000Z',
      },
    });
    expect(files['raw/auth.jsonl']).not.toContain('fixture-google-sub');

    expect(lines.join('\n')).not.toContain('@');
  });

  it('reads one snapshot: a change after its readTime is not in the export', async () => {
    const readTime = await serverReadTime(rest, PROJECT, UID, endpoints);
    const card = docs.find((doc) => doc.path.endsWith('/cards/WillsCardAuto0000001'));
    if (!card) throw new Error('fixture card missing');
    await ok(
      fetch(`${endpoints.firestore}/${root}/${card.path}?updateMask.fieldPaths=title`, {
        method: 'PATCH',
        headers: { ...OWNER, 'content-type': 'application/json' },
        body: JSON.stringify({ fields: { title: { stringValue: 'Changed after the snapshot' } } }),
      }),
    );
    try {
      const sink = gcsSink(rest, { bucket: RUNS_BUCKET, runId: 'int-snapshot', storage: endpoints.storage });
      const manifest = await runExport(
        {
          uid: UID,
          profile,
          profileHash: 'test',
          source: { project: PROJECT, bucket: SOURCE_BUCKET },
          runId: 'int-snapshot',
          resume: false,
          toolVersion: 'test',
        },
        {
          iam: null,
          serverReadTime: async () => readTime,
          reader: (at) =>
            restReader(rest, { project: PROJECT, bucket: SOURCE_BUCKET }, { endpoints, readTime: at, lossless: true }),
          sink,
          now: () => new Date(),
          log: () => undefined,
        },
      );
      expect(manifest.readTime).toBe(readTime);
      const cards = (await runFile('int-snapshot', 'raw/cards.jsonl')) ?? '';
      expect(cards).not.toContain('Changed after the snapshot');
      expect(cards).toContain(JSON.stringify(card.data['title']));
    } finally {
      await ok(
        fetch(`${endpoints.firestore}/${root}/${card.path}?updateMask.fieldPaths=title`, {
          method: 'PATCH',
          headers: { ...OWNER, 'content-type': 'application/json' },
          body: JSON.stringify({ fields: { title: encode(card.data['title']) } }),
        }),
      );
    }
  });

  it('exports a delta, and the run id stays taken', async () => {
    expect(await migrate('--env', 'emulator', '--run-id', 'int-delta', '--since', '2025-02-05T00:00:00Z')).toBe(0);
    const manifest = JSON.parse((await runFile('int-delta', 'manifest.json')) ?? '') as ExportManifest;
    expect(manifest).toMatchObject({
      kind: 'delta',
      since: '2025-02-05T00:00:00.000Z',
      counts: { cards: 9, attachments: 7, paths: 17, workflows: 3 },
    });
    expect(await migrate('--env', 'emulator', '--run-id', 'int-delta')).toBe(1);
    expect(lines.at(-1)).toMatch(/already exists/);
  });

  it('writes nothing in a dry run', async () => {
    expect(await migrate('--dry-run', '--run-id', 'int-dry')).toBe(0);
    expect(await runFile('int-dry', 'checkpoint.json')).toBeNull();
    expect(lines.join('\n')).toMatch(/Dry run: .* wrote nothing/);
  });

  it('stops for a person when the profile misses a workflow', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'mig-02-int-')), 'profile.json');
    await writeFile(
      path,
      JSON.stringify({ ...profile, workflows: profile.workflows.filter((w) => w.name !== 'Estates') }),
    );
    const code = await exportCommand(
      [
        '--profile',
        path,
        '--source-project',
        PROJECT,
        '--source-bucket',
        SOURCE_BUCKET,
        '--env',
        'emulator',
        '--run-id',
        'int-unmapped',
      ],
      (l) => void lines.push(l),
      (l) => void lines.push(l),
    );
    expect(code).toBe(4);
    expect(lines.at(-1)).toMatch(/doesn't map 1 of the user's workflows/);
    expect(await runFile('int-unmapped', 'raw/cards.jsonl')).toBeNull();
  });
});
