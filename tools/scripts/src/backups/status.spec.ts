import { AdminApi } from './admin-api.ts';
import { scripted } from './fake.ts';
import { ingestSummary, parseArgs, runExport, status } from './status.ts';

/** The backup status report (SEC-03) against scripted Google APIs. Everything here is fictional. */

const NOW = Date.parse('2026-10-07T21:00:00Z');

describe('status', () => {
  it('reports backups, exports and their off-region copies, the files copy, the export job and its logs, and the transfer run', async () => {
    const { deps, calls, headers } = scripted([
      {
        backups: [
          {
            name: 'projects/p/locations/l/backups/b1',
            database: 'projects/p/databases/(default)',
            snapshotTime: '2026-10-06T11:14:35Z',
            state: 'READY',
            expireTime: '2026-10-13T11:14:35Z',
          },
          {
            name: 'projects/p/locations/l/backups/b2',
            database: 'projects/p/databases/other',
            snapshotTime: 'x',
            state: 'READY',
          },
        ],
      },
      { items: [{ name: 'daily/2026-10-06T14-59-00Z/2026-10-06T14-59-00Z.overall_export_metadata' }] },
      { items: [] },
      { prefixes: ['daily/2026-10-06T14-59-00Z/', 'daily/2026-10-07T14-59-00Z/'] },
      { prefixes: [] },
      { items: [{ name: 'daily/2026-10-05T14-59-00Z/2026-10-05T14-59-00Z.overall_export_metadata' }] },
      { items: [] },
      { items: [{ name: 'files/a' }, { name: 'files/b' }], nextPageToken: 't' },
      {
        jobs: [
          {
            name: 'projects/p/locations/l/jobs/firebase-schedule-backups-exportFirestore-australia-southeast1',
            schedule: '0 2 * * *',
            state: 'ENABLED',
            lastAttemptTime: '2026-10-07T15:00:00Z',
            status: { code: 13, message: 'INTERNAL' },
          },
          { name: 'projects/p/locations/l/jobs/firebase-schedule-other', state: 'ENABLED' },
        ],
      },
      {
        entries: [
          {
            timestamp: '2026-10-07T15:00:05Z',
            severity: 'ERROR',
            jsonPayload: { message: 'export failed', reason: 'PERMISSION_DENIED | bucket' },
          },
          {
            timestamp: '2026-10-06T15:01:00Z',
            severity: 'INFO',
            jsonPayload: { message: 'ok', kind: 'daily', documents: 120 },
          },
        ],
      },
      { status: 403, error: { message: 'storagetransfer.jobs.list denied' } },
      { entries: [{ timestamp: '2026-10-07T02:00:00Z', httpRequest: { latency: '4.2s', status: 200 } }] },
    ]);
    const markdown = await status(new AdminApi(deps, 'p'), {
      location: 'australia-southeast1',
      exportsBucket: 'p-exports',
      backupsBucket: 'p-backups',
      now: () => NOW,
    });
    expect(markdown).toContain('| 2026-10-06T11:14:35Z | READY | 2026-10-13T11:14:35Z |');
    expect(markdown).not.toContain('backups/b2');
    expect(markdown).toContain('| gs://p-exports/daily/2026-10-06T14-59-00Z | 2026-10-06T14:59:00Z |');
    expect(markdown).toContain('Folders without a finished export: gs://p-exports/daily/2026-10-07T14-59-00Z');
    expect(markdown).toContain('#### Off-region export copies (gs://p-backups)');
    expect(markdown).toContain('| gs://p-backups/daily/2026-10-05T14-59-00Z | 2026-10-05T14:59:00Z |');
    expect(markdown).toContain('2+ objects under gs://p-backups/files/.');
    expect(markdown).toContain(
      '| firebase-schedule-backups-exportFirestore-australia-southeast1 | 0 2 * * * | ENABLED | 2026-10-07T15:00:00Z | 13 INTERNAL |',
    );
    expect(markdown).not.toContain('firebase-schedule-other');
    expect(markdown).toContain('| 2026-10-07T15:00:05Z | ERROR | export failed reason=PERMISSION_DENIED \\| bucket |');
    expect(markdown).toContain('| 2026-10-06T15:01:00Z | INFO | ok kind=daily documents=120 |');
    expect(markdown).toContain('⚠️ GET https://storagetransfer.googleapis.com/v1/transferJobs: 403');
    const logs = calls.find((c) => c.url.endsWith('entries:list'));
    expect(headers[calls.indexOf(logs as (typeof calls)[number])]?.['x-goog-user-project']).toBe('p');
    expect(headers[0]?.['x-goog-user-project']).toBeUndefined();
    expect(logs?.body).toMatchObject({ resourceNames: ['projects/p'], orderBy: 'timestamp desc' });
    expect(JSON.stringify(logs?.body)).toContain('timestamp >= \\"2026-09-29T21:00:00.000Z\\"');
    expect(markdown).toContain('#### Clerk ingest (last 30 days)');
    expect(markdown).toContain('| 1 | 0 | 4.2 s | 4.2 s | 4.2 s |');
    const ingest = calls[calls.length - 1];
    expect(ingest?.body).toMatchObject({ pageSize: 1000 });
    expect(JSON.stringify(ingest?.body)).toContain('resource.labels.service_name=\\"documents-ingest\\"');
    expect(JSON.stringify(ingest?.body)).toContain('timestamp >= \\"2026-09-07T21:00:00.000Z\\"');
  });

  it('times Clerk ingest from its request logs: latency and the busiest run', () => {
    const at = (time: string, latency: string, status = 200) => ({
      timestamp: `2026-10-07T${time}Z`,
      httpRequest: { latency, status },
    });
    const lines = ingestSummary(
      [
        // A run of 4 requests between 02:00 and 02:20 (each within 10 minutes of the last).
        at('02:00:00', '2.0s'),
        at('02:06:00', '3.0s'),
        at('02:12:00', '4.0s', 500),
        at('02:19:50', '10.0s'),
        // A lone request later, and a log line without a latency.
        at('05:00:00', '1.0s'),
        { timestamp: '2026-10-07T06:00:00Z' },
      ].reverse(),
      false,
    );
    expect(lines).toContain('| 5 | 1 | 3.0 s | 10.0 s | 10.0 s |');
    expect(lines).toContain(
      'Busiest run: 4 requests from 2026-10-07T02:00:00.000Z to 2026-10-07T02:20:00.000Z (20 min), about 12 an hour.',
    );
    expect(ingestSummary([at('02:00:00', '2.0s')], true)[2]).toBe('| 1 (newest only) | 0 | 2.0 s | 2.0 s | 2.0 s |');
    expect(ingestSummary([], false)).toEqual(['None.']);
  });

  it('runs the export job now', async () => {
    const job = 'projects/p/locations/l/jobs/firebase-schedule-backups-exportFirestore-australia-southeast1';
    const { deps, calls } = scripted([
      { jobs: [{ name: 'projects/p/locations/l/jobs/other' }, { name: job }] },
      { name: job },
    ]);
    expect(await runExport(new AdminApi(deps, 'p'), 'l')).toContain(
      'Started firebase-schedule-backups-exportFirestore',
    );
    expect(calls[1]).toMatchObject({ method: 'POST', url: `https://cloudscheduler.googleapis.com/v1/${job}:run` });

    const none = scripted([{ jobs: [] }]);
    await expect(runExport(new AdminApi(none.deps, 'p'), 'l')).rejects.toThrow('No Cloud Scheduler job');
  });

  it('needs a project', () => {
    expect(parseArgs(['--project', 'materia-v2-dev'])).toEqual({ project: 'materia-v2-dev', runExport: false });
    expect(parseArgs(['--project', 'p', '--run-export']).runExport).toBe(true);
    expect(() => parseArgs([])).toThrow('Usage');
  });
});
