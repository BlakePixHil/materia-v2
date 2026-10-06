import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_ID } from './harness';

/**
 * Firestore rules coverage (FND-14), from the emulator's coverage report. Call it at the end of the
 * Firestore rules suite, before another suite reloads the rules.
 *
 * Coverage = the share of rule expressions (every `allow … if <expr>` and every helper `return
 * <expr>`) the tests evaluated. Literal `if false` blocks are not counted: the emulator never
 * evaluates a constant. Branches = the share of `allow` conditions seen both true and false.
 * Writes dist/rules-coverage/firestore.json and firestore.html (the emulator's interactive report).
 */
interface CoverageNode {
  sourcePosition: { currentOffset: number };
  values?: { value: unknown }[];
  children?: CoverageNode[];
}

export interface RulesCoverage {
  expressions: number;
  evaluated: number;
  coveragePct: number;
  allowConditions: number;
  allowBothWays: number;
  branchPct: number;
  missed: { line: number; text: string }[];
}

export async function writeRulesCoverage(): Promise<RulesCoverage> {
  const host = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
  const base = `http://${host}/emulator/v1/projects/${PROJECT_ID}:ruleCoverage`;
  const report = await fetchCoverageReport(base);
  const source = report.rules.files[0]?.content ?? '';

  // A child can start at its parent's offset, so branch values come from the top-level nodes only.
  const evaluated = new Set<number>();
  const walk = (node: CoverageNode) => {
    evaluated.add(node.sourcePosition.currentOffset);
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of report.report) walk(node);
  const topLevel = new Map(
    report.report.map((node) => [
      node.sourcePosition.currentOffset,
      new Set((node.values ?? []).map((v) => JSON.stringify(v.value))),
    ]),
  );

  const expressions = [
    ...[...source.matchAll(/allow [a-z, ]+: if (?!false;)/g)].map((m) => ({
      kind: 'allow',
      offset: m.index + m[0].length,
    })),
    ...[...source.matchAll(/return /g)].map((m) => ({ kind: 'return', offset: m.index + m[0].length })),
  ];
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const missed = expressions.filter((e) => !evaluated.has(e.offset));
  const allows = expressions.filter((e) => e.kind === 'allow');
  const bothWays = allows.filter((e) => {
    const values = topLevel.get(e.offset);
    return values?.has('{"boolValue":true}') && values.has('{"boolValue":false}');
  });
  const pct = (n: number, d: number) => Math.round((n / d) * 1000) / 10;

  const summary: RulesCoverage = {
    expressions: expressions.length,
    evaluated: expressions.length - missed.length,
    coveragePct: pct(expressions.length - missed.length, expressions.length),
    allowConditions: allows.length,
    allowBothWays: bothWays.length,
    branchPct: pct(bothWays.length, allows.length),
    missed: missed.map((e) => ({
      line: lineOf(e.offset),
      text: source.slice(e.offset, e.offset + 80).split('\n')[0] ?? '',
    })),
  };

  const outDir = path.resolve(import.meta.dirname, '../../../dist/rules-coverage');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'firestore.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'firestore.html'), await (await fetch(`${base}.html`)).text());
  console.log(
    `Firestore rules coverage: ${summary.coveragePct}% of ${summary.expressions} expressions evaluated; ` +
      `${summary.branchPct}% of ${summary.allowConditions} allow conditions seen both true and false.`,
  );
  return summary;
}

interface CoverageReport {
  rules: { files: { content: string }[] };
  report: CoverageNode[];
}

/**
 * The emulator can answer the coverage request before its report is ready (seen on CI runners as
 * a body with no `rules`), so retry a few times and fail with the body if it never arrives.
 */
async function fetchCoverageReport(url: string, attempts = 5): Promise<CoverageReport> {
  let body = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url);
    body = await res.text();
    try {
      const parsed = JSON.parse(body) as Partial<CoverageReport>;
      if (res.ok && parsed.rules?.files && parsed.report) return parsed as CoverageReport;
    } catch {
      // Not JSON yet: retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`The emulator returned no rules coverage report: ${body.slice(0, 500)}`);
}
