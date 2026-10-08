import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prompts } from '@materia/clerk';
import {
  acceptBaselines,
  BaselinesSchema,
  EVALS_DIR,
  loadBaselines,
  loadEvalsConfig,
  loadSuite,
  renderMarkdown,
  REPORT_MARKER,
  runEvals,
  runPassed,
  suiteIds,
  type RunReport,
} from '@materia/clerk/evals';

import { createEvalExecutor } from './executor';
import type { ClerkModelPort, ClerkModelRequest } from '../../ports';
import { anthropicModel } from '../providers/anthropic';
import { FakeClerkModel, eventsStep, matterBriefStep, narrativeStep, type FakeStep } from '../providers/fake';

/**
 * `nx run clerk:eval --feature=<suite>[,<suite>]|all [--subset] [--model=…] [--runs=N]
 * [--provider=anthropic|fake] [--judge] [--accept-baseline]` (AI-12).
 *
 * Runs the eval suites on the real ClerkGateway and writes `dist/evals/<feature>/<timestamp>.json`
 * and `.md`. Exit code 0: passed (or nothing to gate), 1: the gate failed, 2: bad arguments or data.
 * The live provider reads the eval key from `CLERK_EVALS_API_KEY`; without one the run is skipped.
 */

export const WORKSPACE_ROOT = path.resolve(EVALS_DIR, '../../..');

export interface EvalArgs {
  feature: string;
  subset: boolean;
  model?: string;
  runs?: number;
  provider: 'anthropic' | 'fake';
  judge: boolean;
  acceptBaseline: boolean;
  out: string;
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = {
    feature: 'all',
    subset: false,
    provider: 'anthropic',
    judge: false,
    acceptBaseline: false,
    out: path.join(WORKSPACE_ROOT, 'dist/evals'),
  };
  for (const raw of argv) {
    const [flag, value] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw];
    switch (flag) {
      case '--feature':
        if (!value) throw new UsageError('--feature needs a suite id, a comma-separated list or "all"');
        args.feature = value;
        break;
      case '--subset':
        args.subset = value !== 'false';
        break;
      case '--model':
        if (!value) throw new UsageError('--model needs a model id');
        args.model = value;
        break;
      case '--runs': {
        const runs = Number(value);
        if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new UsageError('--runs must be 1 to 5');
        args.runs = runs;
        break;
      }
      case '--provider':
        if (value !== 'anthropic' && value !== 'fake') throw new UsageError('--provider must be anthropic or fake');
        args.provider = value;
        break;
      case '--judge':
        args.judge = value !== 'false';
        break;
      case '--accept-baseline':
        args.acceptBaseline = value !== 'false';
        break;
      case '--out':
        if (!value) throw new UsageError('--out needs a directory');
        args.out = path.resolve(value);
        break;
      default:
        throw new UsageError(`Unknown option ${raw}`);
    }
  }
  return args;
}

export function selectSuites(feature: string, available: readonly string[]): string[] {
  if (feature === 'all') return [...available];
  const wanted = feature.split(',').map((id) => id.trim());
  const unknown = wanted.filter((id) => !available.includes(id));
  if (unknown.length) throw new UsageError(`Unknown suite ${unknown.join(', ')} (have: ${available.join(', ')})`);
  return wanted;
}

/** Structured replies for the fake provider, so a plumbing run exercises validation and scoring. */
const FAKE_OUTPUT: Record<string, unknown> = {
  willExtraction: {
    testator: { name: 'Fake Testator', address: null, source: null },
    willDate: null,
    executors: [],
    beneficiaries: [],
    guardians: [],
    trusts: [],
    formalValidityFlags: [],
    suspiciousInstructions: [],
    notFound: ['everything (fake provider)'],
  },
  citationJudge: { verdicts: [] },
};

/**
 * The chat proposals step (AI-10b): a letter of the first type `<letter_types>` lists, to the first
 * executor, so production's `toChatProposals` checks run.
 */
function chatProposalsStep(request: ClerkModelRequest): FakeStep {
  const asked = JSON.stringify(request.messages);
  const typeId = /<letter_types>\\n- ([a-z][a-z0-9-]*):/.exec(asked)?.[1];
  const letters = typeId
    ? [
        {
          typeId,
          partyIds: ['p-executor-1'],
          instructions: 'A letter from the fake provider.',
          rationale: 'The fake provider proposes a letter.',
          citations: [],
        },
      ]
    : [];
  return { chunks: [JSON.stringify({ tasks: [], deadlines: [], events: [], notes: [], keyFacts: [], letters })] };
}

export function fakeModel(): ClerkModelPort {
  return new FakeClerkModel([], (request: ClerkModelRequest): FakeStep => {
    // An Insights narrative (INS-04) built from the figures it was given, so the number check runs.
    if (request.output?.name === 'insightsNarrative') return narrativeStep(request);
    // Key dates (MIG-09) from the notes and excerpts it was given, so production's checks run.
    if (request.output?.name === 'eventsFromFile') return eventsStep(request);
    // A matter brief (AI-06c) from the facts it was given, so the ref and date checks run.
    if (request.output?.name === 'matterBrief') return matterBriefStep(request);
    if (request.output?.name === 'chatProposals') return chatProposalsStep(request);
    const sample = request.output ? FAKE_OUTPUT[request.output.name] : undefined;
    return { chunks: [sample ? JSON.stringify(sample) : 'I don’t have that information in this conversation.'] };
  });
}

/** Writes the report as JSON and Markdown; returns the Markdown path. */
export function writeReport(report: RunReport, out: string, feature: string): { json: string; markdown: string } {
  const dir = path.join(out, feature === 'all' ? 'all' : feature.replace(/,/g, '+'));
  mkdirSync(dir, { recursive: true });
  const json = path.join(dir, `${report.runId}.json`);
  const markdown = path.join(dir, `${report.runId}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  // Stable names for CI (the PR comment and the job summary).
  writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(out, 'latest.md'), renderMarkdown(report));
  return { json, markdown };
}

export interface MainIo {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  model?: ClerkModelPort;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  root?: string;
}

export async function main(argv: readonly string[], io: MainIo): Promise<number> {
  let args: EvalArgs;
  let ids: string[];
  try {
    args = parseArgs(argv);
    ids = selectSuites(args.feature, suiteIds(io.root));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(error.message);
    return 2;
  }
  const root = io.root ?? EVALS_DIR;
  const config = loadEvalsConfig(root);
  const baselines = loadBaselines(root);
  const suites = ids.map((id) => loadSuite(id, root));
  const modelId = args.model ?? config.defaultModel;

  const apiKey = args.provider === 'fake' ? 'sk-ant-fake-evals' : (io.env['CLERK_EVALS_API_KEY'] ?? '').trim();
  if (!apiKey || apiKey === 'unset') {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(
      path.join(args.out, 'latest.md'),
      `${REPORT_MARKER}\n\n## Clerk evals: skipped\n\nNo eval key (\`CLERK_EVALS_API_KEY\`), so the live suites did not run.\n`,
    );
    io.stdout('Clerk evals skipped: CLERK_EVALS_API_KEY is not set.');
    return 0;
  }

  const registered = prompts();
  const report = await runEvals({
    suites,
    mode: args.subset ? 'subset' : 'full',
    ...(args.runs ? { runs: args.runs } : {}),
    config,
    baselines,
    execute: createEvalExecutor({
      model: io.model ?? (args.provider === 'fake' ? fakeModel() : anthropicModel()),
      apiKey,
      modelId,
      judge: args.judge,
      root,
    }),
    isRegistered: (ref) => registered.has(ref),
    provider: args.provider,
    model: modelId,
    root,
    ...(io.now ? { now: io.now } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}),
    onProgress: io.stderr,
  });
  const written = writeReport(report, args.out, args.feature);
  const passed = runPassed(report);
  for (const suite of report.suites)
    io.stdout(`${suite.suite}: ${suite.status}${suite.reason ? ` (${suite.reason})` : ''}`);
  io.stdout(`Spent $${report.spentUsd.toFixed(4)} of $${report.budgetUsd.toFixed(2)}. Report: ${written.markdown}`);

  if (args.acceptBaseline) {
    if (args.provider === 'fake') {
      io.stderr('--accept-baseline needs a live run (the fake provider measures nothing).');
      return 2;
    }
    const next = BaselinesSchema.parse(acceptBaselines(baselines, report, report.runId));
    writeFileSync(path.join(root, 'baselines.json'), `${JSON.stringify(next, null, 2)}\n`);
    io.stdout('Baselines updated for the suites that passed. Commit them as "accept baseline: <why>".');
  }
  // The fake provider checks the plumbing only: its scores mean nothing, so it never gates.
  return passed || args.provider === 'fake' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
