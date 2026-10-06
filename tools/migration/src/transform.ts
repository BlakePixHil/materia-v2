import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { tokenSource } from './audit.ts';
import { sha256, type ExportRecord } from './export/jsonl.ts';
import { EXPORT_FILES, type ExportFile } from './export/scope.ts';
import { dirSink, gcsSink, type RunSink } from './export/sink.ts';
import { DESTINATIONS, toolVersion, type ExportManifest } from './export.ts';
import { emulatorEndpoints, GOOGLE_APIS, type RestDeps } from './legacy/rest.ts';
import { MappingProfileSchema, type MappingProfile } from './profile.ts';
import type { NumberBase } from './transform/numbers.ts';
import { untagDates } from './transform/output.ts';
import {
  IDMAP_FILE,
  OUTPUT_DIR,
  REPORT_FILE,
  runTransform,
  TransformRefusedError,
  type RawRun,
  type TransformReport,
} from './transform/run.ts';

/**
 * `materia-migrate transform` (MIG-03): reads an exported run (`raw/*.jsonl`, checked against its
 * manifest's sha256s), maps it to v2 with the pure mappers in `transform/`, validates every
 * record against the `libs/domain` schemas, and writes `transformed/{entity}.jsonl`,
 * `idmap.jsonl` and `report.json` beside it. It reads and writes only the run: nothing touches
 * the legacy project or a v2 database (the load is MIG-06). Logs counts only. Runbook:
 * docs/runbooks/migration-transform.md; decision D-19.
 */

const USAGE = `Usage: materia-migrate transform --run <runId> --profile <profile.json> --target-org <orgId|new> --env dev|prod
       materia-migrate transform --run <runId> --profile <profile.json> --target-org new --dir <runs dir>

Maps an exported run to v2 documents, validated against the v2 schemas, and writes
transformed/<entity>.jsonl, idmap.jsonl and report.json to the run. Reads and writes only the run.

  --run <runId>            The exported run (gs://materia-v2-<env>-migration/runs/<runId>/)
  --profile <path>         The mapping profile the run was exported under
  --target-org <id|new>    The v2 org the data loads into, or new to create it (its id is
                           derived from the user, so a re-run gives the same one)
  --env dev|prod           Where the run is. dev is for rehearsals (rolled back, D-15).
                           emulator: the Storage emulator's dev migration bucket
  --dir <path>             Runs in a local directory (<path>/<runId>/raw/…), for made-up data only
  --base-run <runId>       For a delta: the run it continues, whose matter numbers it keeps
  --allow-rejects          Write the output even when records fail validation (they are left out)
  --impersonate <email>    Account that reads and writes the run (default: migration-runner in
                           prod, your gcloud account in dev)
  --adc                    Use Application Default Credentials instead

MIGRATION_WRITER_TOKEN, when set, is used as the token. Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.

Exit codes: 0 transformed; 1 bad arguments, a refused run or an error; 5 records failed
validation: report.json lists them, and nothing else is written unless --allow-rejects.`;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The raw files and manifest of a run, each checked against the manifest's sha256. */
export async function readRawRun(sink: RunSink): Promise<RawRun> {
  const manifestText = await sink.read('manifest.json');
  if (manifestText === null) throw new TransformRefusedError(`${sink.location} has no manifest.json: export it first.`);
  const manifest = JSON.parse(manifestText) as ExportManifest;
  const files: RawRun['files'] = {};
  for (const [name, entry] of Object.entries(manifest.files)) {
    const file = /^raw\/(.+)\.jsonl$/.exec(name)?.[1] as ExportFile | 'paths' | undefined;
    if (!file || (file !== 'paths' && !(EXPORT_FILES as readonly string[]).includes(file))) continue;
    const text = await sink.read(name);
    if (text === null) throw new TransformRefusedError(`${sink.location}${name} is missing.`);
    if (sha256(text) !== entry.sha256) {
      throw new TransformRefusedError(`${name} doesn't match the manifest's sha256: the run changed since its export.`);
    }
    files[file] = text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const { path, data } = JSON.parse(line) as ExportRecord;
        return { path, data };
      });
  }
  return { manifest, files };
}

/** What a base run allocated: its matter number reservations and counters. */
export async function readNumberBase(sink: RunSink): Promise<NumberBase> {
  const lines = async (entity: string) => {
    const text = await sink.read(`${OUTPUT_DIR}/${entity}.jsonl`);
    if (text === null) throw new TransformRefusedError(`${sink.location} has no ${OUTPUT_DIR}/${entity}.jsonl.`);
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => untagDates(JSON.parse(line)) as { path: string; data: Record<string, unknown> });
  };
  const numbers = new Map<string, { number: string; year: number }>();
  for (const { data } of await lines('matter-numbers')) {
    numbers.set(String(data['matterId']), { number: String(data['number']), year: Number(data['year']) });
  }
  const counters = new Map<number, number>();
  for (const { path, data } of await lines('counters')) {
    const year = /\/counters\/matter-(\d{4})$/.exec(path)?.[1];
    if (year) counters.set(Number(year), Number(data['next']));
  }
  return { numbers, counters };
}

async function writeText(sink: RunSink, name: string, text: string): Promise<void> {
  const file = await sink.create(name, name.endsWith('.json') ? 'application/json' : 'application/x-ndjson');
  await file.write(text);
  await file.close();
}

export interface TransformCommandDeps {
  /** The run's place: overridden by tests. */
  sink?: (runId: string) => RunSink;
  toolVersion?: () => Promise<string>;
}

export async function transformCommand(
  argv: string[],
  log = console.log,
  error = console.error,
  env: NodeJS.ProcessEnv = process.env,
  deps: TransformCommandDeps = {},
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        run: { type: 'string' },
        profile: { type: 'string' },
        'target-org': { type: 'string' },
        env: { type: 'string' },
        dir: { type: 'string' },
        'base-run': { type: 'string' },
        'allow-rejects': { type: 'boolean', default: false },
        impersonate: { type: 'string' },
        adc: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    log(USAGE);
    return 0;
  }
  const fail = (message: string) => {
    error(message);
    return 1;
  };
  const { run: runId, profile: profilePath, env: target, dir } = values;
  const targetOrg = values['target-org'];
  const baseRun = values['base-run'];
  if (!runId || !profilePath || !targetOrg) return fail(USAGE);
  for (const id of [runId, baseRun]) {
    if (id !== undefined && !RUN_ID.test(id))
      return fail(`Run "${id}" may hold only letters, digits, ".", "_" and "-".`);
  }
  if (baseRun === runId) return fail('--base-run is the run being transformed.');
  if (targetOrg !== 'new' && !/^[A-Za-z0-9_-]{1,128}$/.test(targetOrg)) {
    return fail(`--target-org takes an org id or new, not "${targetOrg}".`);
  }

  let sinkFor = deps.sink;
  if (!sinkFor) {
    if (dir !== undefined) {
      if (target !== undefined) return fail('Pass --env or --dir, not both.');
      sinkFor = (id) => dirSink(join(dir, id));
    } else {
      if (target !== 'dev' && target !== 'prod' && target !== 'emulator') {
        return fail('Pass --env dev, --env prod or --env emulator (or --dir for made-up data).');
      }
      let storage = GOOGLE_APIS.storage;
      try {
        if (target === 'emulator') storage = emulatorEndpoints(env).storage;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const destination = target === 'prod' ? 'prod' : 'dev';
      const impersonate = values.impersonate ?? DESTINATIONS[destination].writer;
      const rest: RestDeps = {
        fetch,
        token:
          target === 'emulator'
            ? async () => 'owner'
            : tokenSource(
                { adc: values.adc, ...(impersonate ? { impersonate } : {}), envVar: 'MIGRATION_WRITER_TOKEN' },
                env,
              ),
      };
      sinkFor = (id) => gcsSink(rest, { bucket: DESTINATIONS[destination].bucket, runId: id, storage });
    }
  }

  const profileText = await readFile(profilePath, 'utf8').catch(() => null);
  if (profileText === null) return fail(`Can't read ${profilePath}.`);
  let profile: MappingProfile;
  try {
    profile = MappingProfileSchema.parse(JSON.parse(profileText));
  } catch (err) {
    return fail(`${profilePath} is not a valid mapping profile: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const sink = sinkFor(runId);
    const raw = await readRawRun(sink);
    if (raw.manifest.runId !== runId) {
      throw new TransformRefusedError(`${sink.location}manifest.json is run ${raw.manifest.runId}, not ${runId}.`);
    }
    const base = baseRun ? await readNumberBase(sinkFor(baseRun)) : undefined;
    const profileHash = sha256(profileText);
    if (profileHash !== raw.manifest.profileHash) {
      log(`Warning: ${profilePath} differs from the profile run ${runId} was exported under.`);
    }
    const output = runTransform(raw, {
      runId,
      profile,
      profileHash,
      targetOrg,
      toolVersion: await (deps.toolVersion ?? toolVersion)(),
      ...(base ? { base } : {}),
    });
    summarise(output.report, log);
    if (output.rejected && !values['allow-rejects']) {
      await writeText(sink, REPORT_FILE, output.files.get(REPORT_FILE) as string);
      error(
        `${output.report.rejects.length} records failed validation (listed in ${sink.location}${REPORT_FILE}). ` +
          'Nothing else was written: fix the data or the mapping, or pass --allow-rejects to leave them out.',
      );
      return 5;
    }
    // The report goes last: a run with a report.json is complete.
    const names = [...output.files.keys()].filter((name) => name !== REPORT_FILE).sort();
    for (const name of [...names, REPORT_FILE]) await writeText(sink, name, output.files.get(name) as string);
    log(`Wrote ${names.length - 1} entity files, ${IDMAP_FILE} and ${REPORT_FILE} to ${sink.location}.`);
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** Counts and codes only: never a name, a title or a value. */
function summarise(report: TransformReport, log: (line: string) => void): void {
  log(
    `Transformed run ${report.runId} (${report.kind}) for org ${report.orgId} (${report.targetOrg}), as of ${report.asOf}.`,
  );
  const out = Object.entries(report.counts.out)
    .filter(([, n]) => n)
    .map(([entity, n]) => `${n} ${entity}`);
  log(`Out: ${out.join(', ')}.`);
  const warned = Object.entries(report.warnings).filter(([, w]) => w.count);
  for (const [code, { count }] of warned) log(`  ${code}: ${count}`);
  log(`Needs review: ${report.needsReview.records} records.`);
  log(
    `Files to copy: ${report.storage.copies} (${report.storage.copyBytes} bytes); orphans: ${report.storage.orphans.length}.`,
  );
  if (report.rejects.length) log(`Rejected: ${report.rejects.length} records.`);
}
