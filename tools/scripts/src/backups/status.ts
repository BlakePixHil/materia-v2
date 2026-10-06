import type { AdminApi } from './admin-api.ts';

/**
 * `materia-scripts backup-status --project <id>` (SEC-03): what the backups have done lately, as
 * evidence and for diagnosis. Lists the managed backups, the nightly export folders (and any that
 * never finished), the files copy, the export's Cloud Scheduler job and recent log lines, and the
 * Storage Transfer job's latest run. Read-only. The `backup-drill` workflow runs it with source
 * `status`. Each section reports its own error, so one missing permission doesn't hide the rest.
 */

export interface StatusOptions {
  location: string;
  backupsBucket: string;
  now: () => number;
}

const EXPORT_JOB = 'backups-exportFirestore';

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
    ...(await section(`Firestore exports (gs://${opts.backupsBucket})`, async () => {
      const finished = await api.listExports(opts.backupsBucket);
      const done = new Set(finished.map((f) => f.uri));
      const started = [];
      for (const kind of ['daily', 'monthly']) {
        const { prefixes } = await api.listObjects(opts.backupsBucket, `${kind}/`, { delimiter: '/' });
        started.push(...prefixes.map((p) => `gs://${opts.backupsBucket}/${p.replace(/\/$/, '')}`));
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
    ...(await section('Files copy (Storage Transfer)', async () => {
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

  return lines.join('\n');
}

export function parseArgs(argv: string[]): { project: string } {
  const index = argv.indexOf('--project');
  const project = index >= 0 ? argv[index + 1] : undefined;
  if (!project) throw new Error('Usage: materia-scripts backup-status --project <id>');
  return { project };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project } = parseArgs(argv);
  const { AdminApi } = await import('./admin-api.ts');
  const { apiDeps } = await import('./firestore.ts');
  const { appendFile } = await import('node:fs/promises');
  const markdown = await status(new AdminApi(apiDeps(), project), {
    location: 'australia-southeast1',
    backupsBucket: `${project}-backups`,
    now: Date.now,
  });
  console.log(markdown);
  if (process.env['GITHUB_STEP_SUMMARY']) await appendFile(process.env['GITHUB_STEP_SUMMARY'], `${markdown}\n`);
}
