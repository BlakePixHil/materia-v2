import type { AdminApi, LogEntry } from './admin-api.ts';

/**
 * `materia-scripts backup-status --project <id>` (SEC-03): what the backups have done lately, as
 * evidence and for diagnosis. Lists the managed backups, the nightly export folders in the exports
 * bucket (and any that never finished) and their off-region copies in the backups bucket, the files
 * copy, the export's Cloud Scheduler job and recent log lines, and the Storage Transfer jobs' latest
 * runs, and how fast Clerk's ingest worked through documents lately (the chunk rebuild after a restore
 * from an export runs at that pace, SEC-07h). Read-only. The `backup-drill` workflow runs it with source
 * `status`. Each section reports its own error, so one missing permission doesn't hide the rest.
 * `--run-export` (workflow source `run-export`) then starts the export job now.
 */

export interface StatusOptions {
  location: string;
  exportsBucket: string;
  backupsBucket: string;
  now: () => number;
}

const EXPORT_JOB = 'backups-exportFirestore';
const INGEST_SERVICE = 'documents-ingest';
/** The Logging API's largest page. */
const INGEST_PAGE = 1000;
/** Requests closer together than this belong to one run. */
const RUN_GAP_MS = 10 * 60 * 1000;

async function section(title: string, body: () => Promise<string[]>): Promise<string[]> {
  try {
    return [`#### ${title}`, '', ...(await body()), ''];
  } catch (error) {
    return [`#### ${title}`, '', `⚠️ ${error instanceof Error ? error.message : String(error)}`, ''];
  }
}

const table = (head: string[], rows: string[][]) =>
  rows.length
    ? [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.join(' | ')} |`),
      ]
    : ['None.'];

/** A log line's message: jsonPayload.message plus a few useful fields, or the text payload. */
function logMessage(entry: { textPayload?: string; jsonPayload?: Record<string, unknown> }): string {
  const json = entry.jsonPayload;
  if (!json) return (entry.textPayload ?? '').slice(0, 300);
  const fields = ['kind', 'snapshotTime', 'documents', 'operation', 'reason', 'errorType']
    .filter((key) => json[key] !== undefined)
    .map((key) => `${key}=${typeof json[key] === 'string' ? json[key] : JSON.stringify(json[key])}`);
  return [String(json['message'] ?? ''), ...fields].join(' ').slice(0, 300);
}

/** Seconds from a Logging duration such as `"3.140s"`. */
function seconds(latency: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(latency ?? '');
  return match ? Number(match[1]) : undefined;
}

const quantile = (sorted: number[], q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;

const secs = (value: number) => `${value.toFixed(1)} s`;

/**
 * Clerk ingest's pace from `documents-ingest` request logs (newest first): request count, failures,
 * latency, and the busiest run (requests less than 10 minutes apart) with its first-to-last span
 * and requests an hour. A long PDF is several requests, so this slightly understates documents.
 */
export function ingestSummary(entries: readonly LogEntry[], capped: boolean): string[] {
  const requests = entries
    .map((e) => ({
      start: Date.parse(e.timestamp),
      latency: seconds(e.httpRequest?.latency),
      status: e.httpRequest?.status,
    }))
    .filter(
      (r): r is { start: number; latency: number; status: number | undefined } =>
        !Number.isNaN(r.start) && r.latency !== undefined,
    )
    .sort((a, b) => a.start - b.start);
  if (!requests.length) return ['None.'];
  const latencies = requests.map((r) => r.latency).sort((a, b) => a - b);
  const failed = requests.filter((r) => r.status !== undefined && (r.status < 200 || r.status >= 300)).length;
  const runs: (typeof requests)[] = [];
  for (const r of requests) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run && last && r.start - last.start < RUN_GAP_MS) run.push(r);
    else runs.push([r]);
  }
  const busiest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  const first = busiest[0]?.start ?? 0;
  const end = Math.max(...busiest.map((r) => r.start + r.latency * 1000));
  const spanMs = Math.max(end - first, 60 * 1000);
  const perHour = Math.round((busiest.length * 60 * 60 * 1000) / spanMs);
  return [
    ...table(
      ['Requests', 'Failed', 'p50', 'p95', 'Longest'],
      [
        [
          `${requests.length}${capped ? ' (newest only)' : ''}`,
          String(failed),
          secs(quantile(latencies, 0.5)),
          secs(quantile(latencies, 0.95)),
          secs(latencies[latencies.length - 1] ?? 0),
        ],
      ],
    ),
    '',
    `Busiest run: ${busiest.length} requests from ${new Date(first).toISOString()} to ${new Date(end).toISOString()} (${Math.round(spanMs / 60000)} min), about ${perHour} an hour.`,
  ];
}

const cell = (value: string | undefined) => (value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export async function status(api: AdminApi, opts: StatusOptions): Promise<string> {
  const since = new Date(opts.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const lines = [`### Backup status: ${api.project}`, ''];

  lines.push(
    ...(await section('Firestore managed backups', async () =>
      table(
        ['Snapshot', 'State', 'Expires'],
        (await api.listBackups(opts.location, '(default)', { readyOnly: false })).map((b) => [
          b.snapshotTime ?? '',
          b.state,
          b.expireTime ?? '',
        ]),
      ),
    )),
  );

  lines.push(
    ...(await section(`Firestore exports (gs://${opts.exportsBucket})`, async () => {
      const finished = await api.listExports(opts.exportsBucket);
      const done = new Set(finished.map((f) => f.uri));
      const started = [];
      for (const kind of ['daily', 'monthly']) {
        const { prefixes } = await api.listObjects(opts.exportsBucket, `${kind}/`, { delimiter: '/' });
        started.push(...prefixes.map((p) => `gs://${opts.exportsBucket}/${p.replace(/\/$/, '')}`));
      }
      const unfinished = started.filter((uri) => !done.has(uri));
      return [
        ...table(
          ['Folder', 'Snapshot'],
          finished.map((f) => [f.uri, f.snapshotTime]),
        ),
        ...(unfinished.length ? ['', `Folders without a finished export: ${unfinished.join(', ')}`] : []),
      ];
    })),
  );

  lines.push(
    ...(await section(`Off-region export copies (gs://${opts.backupsBucket})`, async () =>
      table(
        ['Folder', 'Snapshot'],
        (await api.listExports(opts.backupsBucket)).map((f) => [f.uri, f.snapshotTime]),
      ),
    )),
  );

  lines.push(
    ...(await section('Files copy', async () => {
      const { names, more } = await api.listObjects(opts.backupsBucket, 'files/');
      return [`${names.length}${more ? '+' : ''} objects under gs://${opts.backupsBucket}/files/.`];
    })),
  );

  lines.push(
    ...(await section('Export schedule', async () =>
      table(
        ['Job', 'Schedule', 'State', 'Last attempt', 'Last status'],
        (await api.schedulerJobs(opts.location))
          .filter((job) => job.name.toLowerCase().includes(EXPORT_JOB.toLowerCase()))
          .map((job) => [
            job.name.split('/').pop() ?? '',
            job.schedule ?? '',
            job.state ?? '',
            job.lastAttemptTime ?? 'never',
            job.status?.code ? `${job.status.code} ${cell(job.status.message)}` : 'ok',
          ]),
      ),
    )),
  );

  lines.push(
    ...(await section('Export logs (last 8 days)', async () => {
      const service = EXPORT_JOB.toLowerCase();
      const filter = [
        `timestamp >= "${since}"`,
        `((resource.type="cloud_run_revision" AND resource.labels.service_name="${service}") OR (resource.type="cloud_function" AND resource.labels.function_name="${EXPORT_JOB}"))`,
        `(severity >= WARNING OR jsonPayload.message:*)`,
      ].join(' AND ');
      return table(
        ['Time', 'Severity', 'Message'],
        (await api.logEntries(filter, 30)).map((e) => [e.timestamp, e.severity ?? '', cell(logMessage(e))]),
      );
    })),
  );

  lines.push(
    ...(await section('Nightly copies (Storage Transfer)', async () => {
      const rows = [];
      for (const job of await api.transferJobs()) {
        const op = job.latestOperationName ? await api.transferOperation(job.latestOperationName) : undefined;
        const counters = op?.metadata?.counters ?? {};
        const errors = (op?.metadata?.errorBreakdowns ?? []).map((e) => `${e.errorCode} ×${e.errorCount}`).join(', ');
        rows.push([
          job.name,
          job.status ?? '',
          op?.metadata?.startTime ?? 'never run',
          op?.metadata?.status ?? '',
          `${counters['objectsCopiedToSink'] ?? 0} copied, ${counters['objectsDeletedFromSink'] ?? 0} deleted${errors ? `; errors ${errors}` : ''}`,
        ]);
      }
      return table(['Job', 'Job status', 'Latest run', 'Run status', 'Counts'], rows);
    })),
  );

  lines.push(
    ...(await section('Clerk ingest (last 30 days)', async () => {
      const from = new Date(opts.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const filter = [
        `timestamp >= "${from}"`,
        `resource.type="cloud_run_revision"`,
        `resource.labels.service_name="${INGEST_SERVICE}"`,
        `httpRequest.latency:*`,
      ].join(' AND ');
      const entries = await api.logEntries(filter, INGEST_PAGE);
      return ingestSummary(entries, entries.length >= INGEST_PAGE);
    })),
  );

  return lines.join('\n');
}

/**
 * Runs the export's scheduler job now (`--run-export`), as after fixing a failed night: the export
 * starts in the background, and the next status run shows its folder and log lines.
 */
export async function runExport(api: AdminApi, location: string): Promise<string> {
  const job = (await api.schedulerJobs(location)).find((j) => j.name.toLowerCase().includes(EXPORT_JOB.toLowerCase()));
  if (!job) throw new Error(`No Cloud Scheduler job for ${EXPORT_JOB} in ${location}`);
  await api.runSchedulerJob(job.name);
  return `Started ${job.name.split('/').pop()}; run backup-status again in a few minutes for the result.`;
}

export function parseArgs(argv: string[]): { project: string; runExport: boolean } {
  const index = argv.indexOf('--project');
  const project = index >= 0 ? argv[index + 1] : undefined;
  if (!project) throw new Error('Usage: materia-scripts backup-status --project <id> [--run-export]');
  return { project, runExport: argv.includes('--run-export') };
}

export async function main(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv);
  const { project } = args;
  const { AdminApi } = await import('./admin-api.ts');
  const { apiDeps } = await import('./firestore.ts');
  const { appendFile } = await import('node:fs/promises');
  const api = new AdminApi(apiDeps(), project);
  const location = 'australia-southeast1';
  const markdown = await status(api, {
    location,
    exportsBucket: `${project}-exports`,
    backupsBucket: `${project}-backups`,
    now: Date.now,
  });
  if (args.runExport) {
    const line = await runExport(api, location);
    console.log(line);
    if (process.env['GITHUB_STEP_SUMMARY']) await appendFile(process.env['GITHUB_STEP_SUMMARY'], `\n${line}\n`);
  }
  console.log(markdown);
  if (process.env['GITHUB_STEP_SUMMARY']) await appendFile(process.env['GITHUB_STEP_SUMMARY'], `${markdown}\n`);
}
