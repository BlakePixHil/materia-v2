import { AdminApi } from './admin-api.ts';
import { scripted } from './fake.ts';
import { parseArgs, runExport, status } from './status.ts';

/** The backup status report (SEC-03) against scripted Google APIs. Everything here is fictional. */

const NOW = Date.parse('2026-10-07T21:00:00Z');

describe('status', () => {
  it('reports backups, exports, the files copy, the export job and its logs, and the transfer run', async () => {
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
    ]);
    const markdown = await status(new AdminApi(deps, 'p'), {
      location: 'australia-southeast1',
      backupsBucket: 'p-backups',
      now: () => NOW,
    });
    expect(markdown).toContain('| 2026-10-06T11:14:35Z | READY | 2026-10-13T11:14:35Z |');
    expect(markdown).not.toContain('backups/b2');
    expect(markdown).toContain('| gs://p-backups/daily/2026-10-06T14-59-00Z | 2026-10-06T14:59:00Z |');
    expect(markdown).toContain('Folders without a finished export: gs://p-backups/daily/2026-10-07T14-59-00Z');
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
