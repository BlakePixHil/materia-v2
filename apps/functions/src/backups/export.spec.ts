import { backupsBucket, exportFirestore, exportFolder, exportPlan, type ExportDeps } from './export';
import { createLog, type LogSink } from '../core/log';

const silent: LogSink = () => undefined;

function fakeDeps(responses: object[], clock = { t: 0 }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const deps: ExportDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      const body = responses.shift();
      if (!body) throw new Error('no more responses');
      return new Response(JSON.stringify(body), { status: 'status' in body ? Number(body.status) : 200 });
    }) as typeof fetch,
    token: async () => 'token',
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { deps, calls };
}

describe('exportPlan', () => {
  it('exports the last whole minute at least a minute ago, under daily/', () => {
    const plan = exportPlan('materia-v2-dev', new Date('2026-10-05T15:00:42.123Z'));
    expect(plan).toEqual({
      kind: 'daily',
      snapshotTime: '2026-10-05T14:59:00Z',
      outputUriPrefix: 'gs://materia-v2-dev-backups/daily/2026-10-05T14-59-00Z',
    });
  });

  it('uses monthly/ on the 1st in Melbourne, which is still the 30th in UTC', () => {
    // 2026-10-31T15:00Z is 02:00 on 1 November in Melbourne (AEDT).
    expect(exportPlan('p', new Date('2026-10-31T15:01:00Z')).kind).toBe('monthly');
    expect(exportPlan('p', new Date('2026-11-01T15:01:00Z')).kind).toBe('daily');
  });

  it('names the bucket and folder', () => {
    expect(backupsBucket('materia-v2-prod')).toBe('materia-v2-prod-backups');
    expect(exportFolder('2026-10-05T14:59:00.000Z')).toBe('2026-10-05T14-59-00Z');
  });
});

describe('exportFirestore', () => {
  const plan = exportPlan('materia-v2-dev', new Date('2026-10-05T15:00:00Z'));
  const log = createLog({ fn: 'backups-exportFirestore' }, silent);

  it('starts the export with the snapshot time and waits for the operation', async () => {
    const { deps, calls } = fakeDeps([
      { name: 'projects/materia-v2-dev/databases/(default)/operations/op1' },
      { name: 'projects/materia-v2-dev/databases/(default)/operations/op1', done: false },
      {
        name: 'projects/materia-v2-dev/databases/(default)/operations/op1',
        done: true,
        metadata: { progressDocuments: { completedWork: '1234' } },
      },
    ]);
    await expect(exportFirestore(deps, 'materia-v2-dev', plan, log)).resolves.toEqual({ documents: 1234 });
    expect(calls[0]?.url).toBe(
      'https://firestore.googleapis.com/v1/projects/materia-v2-dev/databases/(default):exportDocuments',
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      outputUriPrefix: 'gs://materia-v2-dev-backups/daily/2026-10-05T14-59-00Z',
      snapshotTime: '2026-10-05T14:59:00Z',
    });
    expect((calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer token');
    expect(calls[1]?.url).toBe(
      'https://firestore.googleapis.com/v1/projects/materia-v2-dev/databases/(default)/operations/op1',
    );
    expect(calls).toHaveLength(3);
  });

  it('throws when the operation fails', async () => {
    const { deps } = fakeDeps([
      { name: 'ops/op2' },
      { name: 'ops/op2', done: true, error: { code: 7, message: 'PERMISSION_DENIED' } },
    ]);
    await expect(exportFirestore(deps, 'p', plan, log)).rejects.toThrow('Export ops/op2 failed: 7 PERMISSION_DENIED');
  });

  it('throws when the API refuses the request', async () => {
    const { deps } = fakeDeps([{ status: 403, error: { message: 'denied' } }]);
    await expect(exportFirestore(deps, 'p', plan, log)).rejects.toThrow('Firestore admin API 403');
  });

  it('gives up after 25 minutes', async () => {
    const pending = Array.from({ length: 200 }, () => ({ name: 'ops/op3', done: false }));
    const { deps } = fakeDeps(pending);
    await expect(exportFirestore(deps, 'p', plan, log)).rejects.toThrow('still running after 25 minutes');
  });
});
