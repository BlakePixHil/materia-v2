import { type Lhr, medianRun, parseLighthouseArgs, runRow, siteOrigin, summary } from './demo-lighthouse.ts';
import { resolveDemoTarget } from './demo-reset.ts';

const DEV = resolveDemoTarget('materia-v2-dev', {});
const EMULATOR = resolveDemoTarget('demo-materia', {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
});

function lhr(score: number, tbt: number, extra: Partial<Lhr> = {}): Lhr {
  return {
    categories: { performance: { score: score / 100 } },
    audits: {
      'first-contentful-paint': { numericValue: 980.4 },
      'largest-contentful-paint': { numericValue: 2266.6 },
      'total-blocking-time': { numericValue: tbt },
      'speed-index': { numericValue: 2302 },
      'cumulative-layout-shift': { numericValue: 0 },
    },
    environment: { benchmarkIndex: 2031.2 },
    ...extra,
  };
}

describe('demo-lighthouse', () => {
  it('measures Today five times as the demo owner unless told otherwise', () => {
    expect(parseLighthouseArgs(['--project', 'materia-v2-dev'])).toEqual({
      project: 'materia-v2-dev',
      path: '/today',
      runs: 5,
      account: 'owner',
      url: undefined,
      dryRun: false,
    });
    expect(
      parseLighthouseArgs(['--path', '/matters', '--runs', '3', '--account', 'lawyer', '--dry-run']),
    ).toMatchObject({ path: '/matters', runs: 3, account: 'lawyer', dryRun: true });
  });

  it('refuses a bad path, run count or account', () => {
    expect(() => parseLighthouseArgs(['--path', 'today'])).toThrow(/--path/);
    expect(() => parseLighthouseArgs(['--path', '/today?x=1'])).toThrow(/--path/);
    expect(() => parseLighthouseArgs(['--runs', '0'])).toThrow(/--runs/);
    expect(() => parseLighthouseArgs(['--runs', '2.5'])).toThrow(/--runs/);
    expect(() => parseLighthouseArgs(['--account', 'admin'])).toThrow(/--account/);
  });

  it('sends the demo password only to dev, its preview channels or the local Hosting emulator', () => {
    expect(siteOrigin(DEV, undefined)).toBe('https://materia-v2-dev.web.app');
    expect(siteOrigin(DEV, 'https://materia-v2-dev--pr-300-ts37kc60.web.app/health')).toBe(
      'https://materia-v2-dev--pr-300-ts37kc60.web.app',
    );
    expect(() => siteOrigin(DEV, 'https://materia-v2-prod.web.app')).toThrow(/--url/);
    expect(() => siteOrigin(DEV, 'https://materia-v2-dev.web.app.example.com')).toThrow(/--url/);
    expect(() => siteOrigin(DEV, 'http://materia-v2-dev.web.app')).toThrow(/--url/);
    expect(siteOrigin(EMULATOR, undefined)).toBe('http://127.0.0.1:5000');
    expect(siteOrigin(EMULATOR, 'http://localhost:5002/today')).toBe('http://localhost:5002');
    expect(() => siteOrigin(EMULATOR, 'https://materia-v2-dev.web.app')).toThrow(/emulator/);
  });

  it('reads a run and takes the median by score, then blocking time, leaving out failed runs', () => {
    expect(runRow(1, lhr(82, 660.4))).toEqual({
      run: 1,
      score: 82,
      fcp: 980,
      lcp: 2267,
      tbt: 660,
      si: 2302,
      cls: 0,
      benchmark: 2031,
      error: undefined,
    });
    const rows = [
      runRow(1, lhr(84, 580)),
      runRow(2, lhr(79, 770)),
      runRow(3, lhr(82, 700)),
      runRow(4, lhr(82, 640)),
      runRow(5, lhr(0, 0, { runtimeError: { code: 'NO_FCP' } })),
      runRow(6, lhr(81, 690)),
    ];
    expect(medianRun(rows)?.run).toBe(3);
    expect(medianRun(rows.slice(4, 5))).toBeUndefined();
  });

  it('summarises the runs and where the median run’s main thread went', () => {
    const median = lhr(82, 660, {
      audits: {
        ...lhr(82, 660).audits,
        'mainthread-work-breakdown': { details: { items: [{ groupLabel: 'Script Evaluation', duration: 1234.5 }] } },
        'bootup-time': {
          details: {
            items: [
              { url: 'https://materia-v2-dev.web.app/main-ABC.js', total: 900, scripting: 700, scriptParseCompile: 40 },
            ],
          },
        },
        'third-party-summary': {
          details: { items: [{ entity: 'Google CDN', mainThreadTime: 210, blockingTime: 120, transferSize: 300_000 }] },
        },
        'long-tasks': { details: { items: [{ url: 'Unattributable', startTime: 1500, duration: 180 }] } },
      },
    });
    const text = summary([runRow(1, median)], median, 'Mobile Lighthouse: /today');
    expect(text).toContain('| 1 | 82 | 980 ms | 2267 ms | 660 ms | 2302 ms | 0 | 2031 |  |');
    expect(text).toContain('**Median: 82** (run 1)');
    expect(text).toContain('| Script Evaluation | 1235 ms |');
    expect(text).toContain('| https://materia-v2-dev.web.app/main-ABC.js | 900 ms | 700 ms | 40 ms |');
    expect(text).toContain('| Google CDN | 210 ms | 120 ms | 293 kB |');
    expect(text).toContain('| Unattributable | 1500 ms | 180 ms |');
    expect(summary([], undefined, 'x')).toContain('No run finished without an error.');
  });
});
