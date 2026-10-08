import {
  appCheckNote,
  type Lhr,
  medianRun,
  mostShiftedRun,
  pageMarks,
  parseLighthouseArgs,
  runRow,
  shiftProbeNote,
  siteOrigin,
  summary,
} from './demo-lighthouse.ts';
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
      appCheck: 'saved',
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
    expect(() => parseLighthouseArgs(['--app-check', 'debug'])).toThrow(/--app-check/);
    expect(parseLighthouseArgs(['--app-check', 'none']).appCheck).toBe('none');
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
        'layout-shifts': {
          details: {
            items: [
              {
                node: { snippet: '<div class="grid" data-today-loading>', selector: 'main > div.grid' },
                score: 0.2968,
                subItems: { items: [{ cause: 'Web font loaded', extra: { type: 'url', value: 'https://x/f.woff2' } }] },
              },
              { node: { selector: 'td | x' }, score: 0.0012 },
              { score: 0.0004 },
            ],
          },
        },
        'lcp-breakdown-insight': {
          details: {
            items: [
              {
                type: 'table',
                items: [
                  { label: 'Time to first byte', duration: 120.4 },
                  { label: 'Element render delay', duration: 1700 },
                ],
              },
              { type: 'node', snippet: '<h1 class="display">\n  Good morning, Ava</h1>' },
            ],
          },
        },
        'network-requests': {
          details: {
            items: [
              { url: 'https://materia-v2-dev.web.app/chunk-A.js', statusCode: 200, networkRequestTime: 40 },
              {
                url: 'https://www.google.com/recaptcha/enterprise.js?render=site-key',
                statusCode: 200,
                networkRequestTime: 900,
              },
              {
                url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?gsessionid=x',
                statusCode: 200,
                networkRequestTime: 700.4,
              },
              {
                url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?gsessionid=y',
                statusCode: -1,
                networkRequestTime: 1400,
              },
              { url: 'data:image/png;base64,AAAA', statusCode: 200, networkRequestTime: 10 },
            ],
          },
        },
      },
      finalDisplayedUrl: 'https://materia-v2-dev.web.app/today',
    });
    const note = 'App Check before the runs: a saved token.';
    const text = summary([runRow(1, median)], median, 'Mobile Lighthouse: /today', [note]);
    expect(text).toContain('| 1 | 82 | 980 ms | 2267 ms | 660 ms | 2302 ms | 0 | 2031 |  |');
    expect(text).toContain('**Median: 82** (run 1)');
    expect(text).toContain('| Script Evaluation | 1235 ms |');
    expect(text).toContain('| https://materia-v2-dev.web.app/main-ABC.js | 900 ms | 700 ms | 40 ms |');
    expect(text).toContain('| Google CDN | 210 ms | 120 ms | 293 kB |');
    expect(text).toContain('| Unattributable | 1500 ms | 180 ms |');
    expect(text).toContain(
      'LCP element: `<h1 class="display"> Good morning, Ava</h1>` (Time to first byte 120 ms, Element render delay 1700 ms)',
    );
    expect(text).toContain('| `<div class="grid" data-today-loading>` | 0.297 | Web font loaded: https://x/f.woff2 |');
    expect(text).toContain('| `td \\| x` | 0.001 |  |');
    expect(text).toContain('| `not attributed` | 0.000 |  |');
    expect(text.indexOf('### Layout shifts')).toBeLessThan(text.indexOf('### Main thread by category'));
    expect(text).toContain(note);
    const sites = text.slice(text.indexOf('### Requests to other sites'));
    expect(sites).not.toContain('chunk-A.js');
    expect(sites).not.toContain('data:');
    expect(sites).not.toContain('site-key');
    expect(sites.indexOf('Listen/channel')).toBeLessThan(sites.indexOf('enterprise.js'));
    expect(sites).toContain(
      '| https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel | 2 | 200, -1 | 700 ms |',
    );
    expect(sites).toContain('| https://www.google.com/recaptcha/enterprise.js | 1 | 200 | 900 ms |');
    expect(summary([], undefined, 'x', [note])).toContain(note);
    expect(summary([], undefined, 'x')).toContain('No run finished without an error.');
  });

  it('lists the layout shifts of the run that shifted most, when the median run didn’t shift', () => {
    const steady = lhr(80, 400);
    const shifting = (cls: number, snippet: string) =>
      lhr(60, 420, {
        audits: {
          ...lhr(60, 420).audits,
          'cumulative-layout-shift': { numericValue: cls },
          'layout-shifts': { details: { items: [{ node: { snippet }, score: cls }] } },
        },
      });
    const runs = [steady, shifting(0.117, '<p class="small">'), shifting(0.2968, '<section class="big">'), steady];
    const rows = runs.map((report, i) => runRow(i + 1, report));
    const worst = mostShiftedRun(rows);
    expect(worst?.run).toBe(3);
    const text = summary(rows, steady, 'x', [], worst ? runs[worst.run - 1] : undefined);
    expect(text).toContain('### Layout shifts in run 3 (CLS 0.297)');
    expect(text).toContain('| `<section class="big">` | 0.297 |  |');
    expect(text).not.toContain('<p class="small">');
    expect(mostShiftedRun([runRow(1, steady)])).toBeUndefined();
  });

  it('lists each run’s page marks, in the order they happened', () => {
    const marked = (cls: number, items: Record<string, unknown>[]) =>
      lhr(70, 500, {
        audits: {
          ...lhr(70, 500).audits,
          'cumulative-layout-shift': { numericValue: cls },
          'user-timings': { details: { items } },
        },
      });
    const late = marked(0.22, [
      { name: 'materia:today-drawn', timingType: 'Mark', startTime: 4301.6 },
      { name: 'materia:today-late:recents,matters', timingType: 'Mark', startTime: 2950.2 },
      { name: 'materia:today-drawn', timingType: 'Measure', startTime: 0, duration: 5 },
      { name: 'firebase-something', timingType: 'Mark', startTime: 10 },
    ]);
    expect(pageMarks(late)).toEqual(['today-late:recents,matters at 2950 ms', 'today-drawn at 4302 ms']);
    const runs = [
      marked(0, [{ name: 'materia:today-answered', timingType: 'Mark', startTime: 2230 }]),
      lhr(80, 400),
      late,
    ];
    const rows = runs.map((report, i) => runRow(i + 1, report));
    const text = summary(rows, runs[0], 'x', [], undefined, runs);
    expect(text).toContain('### Page marks in each run');
    expect(text).toContain('| 1 | 0 | today-answered at 2230 ms |');
    expect(text).toContain('| 3 | 0.22 | today-late:recents,matters at 2950 ms; today-drawn at 4302 ms |');
    expect(text).not.toContain('| 2 | 0 |');
    expect(summary(rows, runs[0], 'x')).not.toContain('### Page marks');
  });

  it('says what the probe visit’s layout shifts moved and which sections were drawn then', () => {
    expect(shiftProbeNote([])).toBe('One more visit before the runs, in a new tab: no layout shift.');
    const text = shiftProbeNote([
      {
        at: 2612,
        score: 0.2968,
        moved: [{ node: 'mt-today-tasks[tasks].mt-card', from: 300, to: 548 }],
        sections: ['attention', 'tasks'],
      },
      { at: 3100, score: 0.01, moved: [{ node: 'td | x', from: 1, to: 2 }], sections: [] },
    ]);
    expect(text).toContain('layout shifts adding up to 0.307.');
    expect(text).toContain('| 2612 ms | 0.297 | mt-today-tasks[tasks].mt-card 300 → 548 | attention, tasks |');
    expect(text).toContain('| td \\| x 1 → 2 |');
  });

  it('says whether App Check had a valid saved token when the runs began', () => {
    const now = Date.UTC(2026, 9, 7, 21, 0);
    const minute = 60_000;
    expect(appCheckNote(null, now)).toMatch(/not started in this build/);
    expect(appCheckNote([], now)).toMatch(/\*\*no valid saved token\*\*/);
    expect(appCheckNote([{ issuedAtTimeMillis: now - 70 * minute, expireTimeMillis: now - 10 * minute }], now)).toMatch(
      /no valid saved token/,
    );
    expect(
      appCheckNote(
        [
          { issuedAtTimeMillis: now - 70 * minute, expireTimeMillis: now - 10 * minute },
          { issuedAtTimeMillis: now - 5 * minute, expireTimeMillis: now + 715 * minute },
        ],
        now,
      ),
    ).toBe(
      'App Check before the runs: a saved token, valid for another 715 min (time to live 720 min, renewed after ' +
        "365 min), so the runs shouldn't need reCAPTCHA.",
    );
  });
});
