import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every scheduled function is watched by the monitoring module's "Scheduled job … not running"
 * alert (FND-21): it's listed in `scheduled_jobs` with its period, and it logs "ok" under its own
 * `fn` when a run finishes (the alert counts those). reminders-dispatch has its own heartbeat alert.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const OWN_ALERT = new Set(['reminders-dispatch']);

interface Job {
  file: string;
  fn: string;
  schedule: string;
  logsOk: boolean;
}

function jobs(): Job[] {
  const files = execFileSync('git', ['ls-files', 'apps/functions/src/**/*.ts'], { cwd: root })
    .toString()
    .trim()
    .split('\n')
    .filter((file) => !file.endsWith('.spec.ts'));
  const found: Job[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/= onSchedule\(([\s\S]*?)\n\);/g)) {
      const body = match[1] ?? '';
      found.push({
        file,
        fn: /createLog\(\{ fn: '([\w-]+)'/.exec(body)?.[1] ?? '',
        schedule: /schedule: '([^']+)'/.exec(body)?.[1] ?? '',
        logsOk: /log\.info\('ok'/.test(body),
      });
    }
  }
  return found;
}

/** Seconds between runs: `every N minutes`, or a cron that runs daily or monthly. */
function period(schedule: string): number {
  const every = /^every (\d+) minutes$/.exec(schedule);
  if (every) return Number(every[1]) * 60;
  const [minute, hour, day, month, weekday] = schedule.split(' ');
  if ([minute, hour].every((f) => /^\d+$/.test(f ?? '')) && month === '*' && weekday === '*') {
    if (day === '*') return 86400;
    if (/^\d+$/.test(day ?? '')) return 31 * 86400;
  }
  throw new Error(`Unrecognised schedule "${schedule}"`);
}

function watched(): Map<string, number> {
  const tf = readFileSync(path.join(root, 'infra/terraform/modules/monitoring/variables.tf'), 'utf8');
  const block = /variable "scheduled_jobs" \{[\s\S]*?default = \{([\s\S]*?)\n {2}\}/.exec(tf)?.[1] ?? '';
  return new Map([...block.matchAll(/"([\w-]+)"\s*=\s*(\d+)/g)].map((m) => [m[1] ?? '', Number(m[2])]));
}

describe('scheduled jobs', () => {
  const all = jobs();

  it('finds the scheduled functions', () => {
    expect(all.length).toBeGreaterThan(8);
    expect(all.filter((job) => !job.fn || !job.schedule).map((job) => job.file)).toEqual([]);
  });

  it('logs "ok" when each run finishes', () => {
    expect(all.filter((job) => !job.logsOk).map((job) => job.fn)).toEqual([]);
  });

  it('lists every job in the monitoring scheduled_jobs alert with its period', () => {
    const listed = watched();
    const expected = Object.fromEntries(
      all.filter((job) => !OWN_ALERT.has(job.fn)).map((job) => [job.fn, period(job.schedule)]),
    );
    expect(Object.fromEntries(listed)).toEqual(expected);
  });
});
