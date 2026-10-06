import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { prompts } from '../prompts';
import {
  DatasetError,
  EVALS_DIR,
  fixtureHash,
  loadBaselines,
  loadEvalsConfig,
  loadSuite,
  readTextFixture,
  suiteIds,
} from './dataset';
import { insightsCase } from './insights';

const FEATURE_SUITES = [
  'brief',
  'chat',
  'classification',
  'drafting',
  'insights-narrative',
  'time-assist',
  'will-extraction',
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('the committed eval datasets', () => {
  const ids = suiteIds();

  it('has every seed suite the ticket asks for', () => {
    expect(ids).toEqual([...FEATURE_SUITES, 'injection', 'privilege'].sort());
  });

  it.each(ids)('%s loads, cross-checks and has enough cases', (id) => {
    const suite = loadSuite(id);
    const minimum = id === 'injection' || id === 'privilege' ? 15 : 10;
    expect(suite.cases.length).toBeGreaterThanOrEqual(minimum);
    // The PR subset is about 10 cases.
    expect(suite.config.subset.length).toBeGreaterThanOrEqual(8);
    expect(suite.config.subset.length).toBeLessThanOrEqual(12);
  });

  it('injection and privilege cases carry their checks', () => {
    for (const evalCase of loadSuite('injection').cases)
      expect(loadSuite('injection').gold.get(evalCase.id)?.injection?.forbidden.length).toBeGreaterThan(0);
    const privilege = loadSuite('privilege');
    const restricted = privilege.cases.filter((c) => c.role === 'paralegal' || c.role === 'readonly');
    expect(restricted.length).toBeGreaterThanOrEqual(15);
    for (const evalCase of restricted) {
      expect(privilege.gold.get(evalCase.id)?.canaries?.length).toBeGreaterThan(0);
      // The canaries must really be in the privileged material, or the check proves nothing.
      const privileged = [
        ...evalCase.documents
          .filter((doc) => doc.privileged)
          .map((doc) => readTextFixture(EVALS_DIR, doc.fixture).text),
        ...evalCase.notes.filter((note) => note.privileged).map((note) => note.text),
      ].join('\n');
      const open = [
        ...evalCase.documents
          .filter((doc) => !doc.privileged)
          .map((doc) => readTextFixture(EVALS_DIR, doc.fixture).text),
        ...evalCase.notes.filter((note) => !note.privileged).map((note) => note.text),
        JSON.stringify(evalCase.matter),
      ].join('\n');
      for (const canary of privilege.gold.get(evalCase.id)?.canaries ?? []) {
        expect(privileged).toContain(canary);
        expect(open).not.toContain(canary);
      }
    }
  });

  it('insights cases plant their canaries only in metric keys the narrative scope leaves out', () => {
    const suite = loadSuite('insights-narrative');
    const canaried = suite.cases.filter((c) => suite.gold.get(c.id)?.canaries?.length);
    expect(canaried.length).toBeGreaterThanOrEqual(2);
    for (const evalCase of suite.cases) {
      const figures = JSON.stringify(insightsCase(evalCase)?.figures);
      expect(insightsCase(evalCase)).not.toBeNull();
      for (const canary of suite.gold.get(evalCase.id)?.canaries ?? []) {
        expect(JSON.stringify(evalCase.metrics)).toContain(canary);
        expect(figures).not.toContain(canary);
      }
    }
  });

  it('injection markers never appear in the inputs, so only obeying produces them', () => {
    const suite = loadSuite('injection');
    // Will-extraction cases name the injected party on purpose: the grader ignores the
    // `suspiciousInstructions` field where the model reports it, so only obeying counts.
    for (const evalCase of suite.cases.filter((c) => c.feature !== 'willExtraction')) {
      const inputs = evalCase.documents
        .filter((doc) => doc.fixture.endsWith('.txt'))
        .map((doc) => readTextFixture(EVALS_DIR, doc.fixture).text.toLowerCase())
        .join('\n');
      for (const marker of suite.gold.get(evalCase.id)?.injection?.forbidden ?? [])
        expect(inputs).not.toContain(marker.toLowerCase());
    }
  });

  it('every suite runs a registered prompt or a pending one named for its ticket', () => {
    const registered = prompts();
    const pending = new Map([
      ['classify-document@1.0.0', 'AI-04'],
      ['brief@1.0.0', 'AI-09'],
      ['draft-letter@1.0.0', 'AI-10'],
      ['time-assist@1.0.0', 'AI-11'],
    ]);
    for (const id of ids) {
      const suite = loadSuite(id);
      for (const ref of new Set([
        suite.config.promptId,
        ...suite.cases.flatMap((c) => (c.promptId ? [c.promptId] : [])),
      ]))
        expect(registered.has(ref) || pending.has(ref)).toBe(true);
    }
    expect(registered.has('chat@1.0.0') && registered.has('will-extract@0.1.1')).toBe(true);
  });

  it('every text fixture is marked as a fictional sample', () => {
    const texts = files(path.join(EVALS_DIR, 'fixtures')).filter((file) => file.endsWith('.txt'));
    expect(texts.length).toBeGreaterThan(20);
    for (const file of texts) expect(readFileSync(file, 'utf8')).toMatch(/SAMPLE/);
  });

  it('loads the run config and baselines', () => {
    expect(loadEvalsConfig().concurrency).toBeLessThanOrEqual(4);
    expect(loadBaselines()).toBeTypeOf('object');
  });
});

describe('dataset validation', () => {
  function scratch(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'clerk-evals-'));
    mkdirSync(path.join(root, 'demo/cases'), { recursive: true });
    mkdirSync(path.join(root, 'demo/gold'), { recursive: true });
    mkdirSync(path.join(root, 'fixtures'), { recursive: true });
    writeFileSync(path.join(root, 'fixtures/a.txt'), 'SAMPLE page one\fpage two');
    writeFileSync(
      path.join(root, 'demo/config.json'),
      JSON.stringify({
        suite: 'demo',
        title: 'Demo',
        ticket: 'AI-99',
        feature: 'chat',
        promptId: 'demo@1.0.0',
        subset: ['c-1'],
        runs: { subset: 1, full: 2 },
        metrics: { privilegeLeak: { min: 1 } },
      }),
    );
    writeFileSync(
      path.join(root, 'demo/cases/c-1.json'),
      JSON.stringify({
        id: 'c-1',
        description: 'd',
        today: '2026-03-20',
        documents: [{ id: 'a', fixture: 'a.txt', title: 'A' }],
      }),
    );
    writeFileSync(
      path.join(root, 'demo/gold/c-1.json'),
      JSON.stringify({ id: 'c-1', fixtures: { 'a.txt': fixtureHash(root, 'a.txt') } }),
    );
    return root;
  }

  it('loads a consistent suite', () => {
    const root = scratch();
    expect(loadSuite('demo', root).cases).toHaveLength(1);
    expect(readTextFixture(root, 'a.txt')).toEqual({
      text: 'SAMPLE page onepage two',
      pages: ['SAMPLE page one', 'page two'],
      offsets: [0, 15],
    });
  });

  it('rejects gold written against a different version of a fixture', () => {
    const root = scratch();
    writeFileSync(path.join(root, 'fixtures/a.txt'), 'SAMPLE edited');
    expect(() => loadSuite('demo', root)).toThrow(/changed since the gold was written/);
  });

  it('rejects missing gold, unknown subset ids and malformed files', () => {
    const missingGold = scratch();
    writeFileSync(path.join(missingGold, 'demo/gold/c-1.json'), JSON.stringify({ id: 'c-2' }));
    expect(() => loadSuite('demo', missingGold)).toThrow(DatasetError);

    const badSubset = scratch();
    const config = JSON.parse(readFileSync(path.join(badSubset, 'demo/config.json'), 'utf8'));
    writeFileSync(path.join(badSubset, 'demo/config.json'), JSON.stringify({ ...config, subset: ['nope'] }));
    expect(() => loadSuite('demo', badSubset)).toThrow(/unknown case nope/);

    const malformed = scratch();
    writeFileSync(path.join(malformed, 'demo/cases/c-1.json'), '{ not json');
    expect(() => loadSuite('demo', malformed)).toThrow(DatasetError);

    const unpinned = scratch();
    writeFileSync(path.join(unpinned, 'demo/gold/c-1.json'), JSON.stringify({ id: 'c-1' }));
    expect(() => loadSuite('demo', unpinned)).toThrow(/does not pin/);
  });
});
