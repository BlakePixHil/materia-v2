import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as z from 'zod';

import { INSIGHTS_COMPARISONS, INSIGHTS_RANGES } from '@materia/domain';

/**
 * The eval datasets (AI-12): `libs/clerk/evals/<suite>/{config.json, cases/*.json, gold/*.json}`
 * plus the shared `fixtures/`, `config.json` (budgets, concurrency) and `baselines.json`. Every
 * file is validated here, so a malformed case fails the unit tests rather than a paid run.
 * Everything in these files is fictional. Never real client data.
 */

export const EVALS_DIR = path.resolve(import.meta.dirname, '../../../evals');

/** Every grader the harness knows. `latencyMs` and `costUsd` are lower-is-better; the rest higher. */
export const METRICS = [
  'schemaValid',
  'fieldAccuracy',
  'citationPrecision',
  'citationSupport',
  'citationCoverage',
  'privilegeLeak',
  'injectionResistance',
  'injectionFlagged',
  'outcomePredictionRefusal',
  'placeholderHonesty',
  'noInventions',
  'draftAccuracy',
  'draftHonesty',
  'numberAccuracy',
  'latencyMs',
  'costUsd',
] as const;
export type MetricName = (typeof METRICS)[number];
export const LOWER_IS_BETTER: ReadonlySet<MetricName> = new Set(['latencyMs', 'costUsd']);

const MetricRule = z
  .object({
    /** The mean must be at least this (higher-is-better metrics). */
    min: z.number().optional(),
    /** The mean must be at most this (lower-is-better metrics). */
    max: z.number().optional(),
    /**
     * The largest allowed drop from the baseline mean (absolute, for scores in 0..1), or the
     * largest allowed rise as a fraction of the baseline (latency and cost). Omitted: report only.
     */
    maxRegression: z.number().min(0).optional(),
  })
  .strict();
export type MetricRule = z.infer<typeof MetricRule>;

export const FieldMode = z.enum(['exact', 'normalised', 'setF1', 'date']);
export type FieldMode = z.infer<typeof FieldMode>;

const SuiteId = z.string().regex(/^[a-z][a-z0-9-]*$/);
const MonthId = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const CaseId = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const SuiteConfigSchema = z
  .object({
    suite: SuiteId,
    title: z.string().min(1),
    /** The Linear key of the feature this suite gates (AI-06, AI-08, …). */
    ticket: z.string().regex(/^[A-Z]+-\d+[a-z]?$/),
    /** The gateway feature the cases run as (its kill switch and timeout). */
    feature: z.enum([
      'chat',
      'suggestions',
      'classification',
      'brief',
      'willExtraction',
      'drafting',
      'timeAssist',
      'insightsNarrative',
    ]),
    /** `id@version` of the prompt under test. A case may name its own (injection, privilege). */
    promptId: z.string().regex(/^[a-z][a-zA-Z0-9-]*@\d+\.\d+\.\d+$/),
    /** The `--subset` cases run on pull requests (about 10). */
    subset: z.array(CaseId).min(1),
    /** Runs per case: nightly runs each case twice and reports the variance (thresholds use means). */
    runs: z.object({ subset: z.number().int().min(1).max(3), full: z.number().int().min(1).max(3) }).strict(),
    metrics: z.partialRecord(z.enum(METRICS), MetricRule),
    /** fieldAccuracy: how each gold field is compared (dot paths into the parsed output). */
    fields: z.record(z.string(), FieldMode).default({}),
    /** Where cited quotes come from: the API's citations (free text) or `quote`/`page` fields in structured output. */
    citations: z.enum(['api', 'parsed', 'none']).default('api'),
    /**
     * Top-level keys of structured output that report what a document says rather than act on it.
     * injectionResistance ignores them: naming an injection in a red flag isn't obeying it.
     */
    reportFields: z.array(z.string().min(1)).default(['suspiciousInstructions']),
  })
  .strict();
export type SuiteConfig = z.infer<typeof SuiteConfigSchema>;

export const CaseDocumentSchema = z
  .object({
    id: z.string().min(1),
    /** Path under `libs/clerk/evals/fixtures/`. Text fixtures separate pages with a form feed. */
    fixture: z.string().regex(/^[a-z0-9][a-z0-9/._-]*\.(txt|pdf)$/),
    title: z.string().min(1),
    version: z.number().int().min(1).default(1),
    privileged: z.boolean().default(false),
  })
  .strict();
export type CaseDocument = z.infer<typeof CaseDocumentSchema>;

export const EvalCaseSchema = z
  .object({
    id: CaseId,
    description: z.string().min(1),
    /** The role the request runs as: privilege filtering depends on it. */
    role: z.enum(['owner', 'admin', 'lawyer', 'paralegal', 'readonly']).default('lawyer'),
    /** Overrides the suite's prompt (cross-feature suites such as injection and privilege). */
    promptId: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9-]*@\d+\.\d+\.\d+$/)
      .optional(),
    /** Overrides the suite's gateway feature, with `promptId`. */
    feature: SuiteConfigSchema.shape.feature.optional(),
    /** The fixed "today" the case runs on, so date reasoning is reproducible. */
    today: z.iso.date(),
    /** Compact matter facts (fictional). */
    matter: z.record(z.string(), z.unknown()).default({}),
    notes: z.array(z.object({ text: z.string().min(1), privileged: z.boolean().default(false) }).strict()).default([]),
    documents: z.array(CaseDocumentSchema).default([]),
    /** The user's request (the chat question, the drafting instruction, the time-capture notes, …). */
    query: z.string().default(''),
    /**
     * Drafting cases (AI-10): the letter as the person asks for it in the drafting screen. `query`
     * describes the case; the instructions are what the person typed. `rewrite` makes it a rewrite
     * of one passage (`drafting-rewrite@*`) rather than a whole letter.
     */
    draft: z
      .object({
        typeId: z.string().regex(/^[a-z][a-z0-9-]*$/),
        recipients: z
          .array(
            z.object({ name: z.string().min(1), role: z.string().optional(), address: z.string().optional() }).strict(),
          )
          .max(5)
          .default([]),
        instructions: z.string().default(''),
        /** A letter to a third party may draw on privileged material only when the person allowed it. */
        includePrivileged: z.boolean().default(false),
        /** The firm's house style (Settings → Clerk and AI); the default when omitted. */
        houseStyle: z.string().optional(),
        rewrite: z
          .object({
            before: z.string(),
            selection: z.string().min(1),
            after: z.string(),
            instruction: z.string().default(''),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Insights narratives (INS-04): the practice's org figures by month (`2026-05` → the
     * `metrics/month-2026-05` document's `values`), and the Insights selection the case explains.
     */
    metrics: z.record(MonthId, z.record(z.string(), z.number())).default({}),
    insights: z
      .object({
        range: z.enum(INSIGHTS_RANGES),
        from: MonthId.optional(),
        to: MonthId.optional(),
        compare: z.enum(INSIGHTS_COMPARISONS),
        fyStartMonth: z.number().int().min(1).max(12).default(7),
      })
      .strict()
      .optional(),
    tags: z.array(z.string()).default([]),
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const GoldSchema = z
  .object({
    id: CaseId,
    /** sha256 (first 16 hex) of each fixture the gold was written against: gold is versioned with the fixtures. */
    fixtures: z.record(z.string(), z.string().regex(/^[0-9a-f]{16}$/)).default({}),
    /** fieldAccuracy: expected values by dot path. */
    fields: z.record(z.string(), z.unknown()).optional(),
    /** citationCoverage applies (the answer states facts from the documents). */
    expectCitations: z.boolean().optional(),
    /** privilegeLeak: strings planted in privileged fixtures that must never reach this run's output. */
    canaries: z.array(z.string().min(6)).optional(),
    /** injectionResistance: markers that appear only if the model obeyed an embedded instruction. */
    injection: z
      .object({ forbidden: z.array(z.string().min(3)).min(1) })
      .strict()
      .optional(),
    /** outcomePredictionRefusal: a client-facing outcome prediction that must be declined or redirected. */
    expectRefusal: z.boolean().optional(),
    /** outcomePredictionRefusal: who the refusal must name as the person to advise (the responsible lawyer). */
    referTo: z.string().min(2).optional(),
    /** placeholderHonesty: facts the draft lacks (each needs a `[[TO CONFIRM: …]]` naming one keyword) and inventions it must not contain. */
    placeholders: z
      .object({
        missing: z.array(z.object({ fact: z.string(), keywords: z.array(z.string().min(2)).min(1) }).strict()),
        forbidden: z.array(z.string().min(2)).default([]),
      })
      .strict()
      .optional(),
    /** Strings the output must not contain (invented facts). */
    mustNotContain: z.array(z.string().min(2)).optional(),
    /**
     * draftAccuracy (AI-06b): exactly the notes and tasks the chat answer should draft, each with
     * keywords its text must contain. Empty: it must draft nothing.
     */
    drafts: z
      .array(z.object({ kind: z.enum(['note', 'task']), keywords: z.array(z.string().min(2)).min(1) }).strict())
      .optional(),
  })
  .strict();
export type Gold = z.infer<typeof GoldSchema>;

export const EvalsConfigSchema = z
  .object({
    /** Cases in flight at once (the ticket's cap is 4). */
    concurrency: z.number().int().min(1).max(4),
    /** Spend caps in US dollars: the runner stops starting cases once a run has spent this much. */
    budgetUsd: z.object({ subset: z.number().positive(), full: z.number().positive() }).strict(),
    /** The model under test when `--model` is not given (the BYOK default, ADR-011b). */
    defaultModel: z.string().min(1),
    /** Attempts per case when the provider fails; after that the case is inconclusive, not failed. */
    attempts: z.number().int().min(1).max(5),
  })
  .strict();
export type EvalsConfig = z.infer<typeof EvalsConfigSchema>;

const BaselineMetrics = z.partialRecord(z.enum(METRICS), z.number());
export const BaselinesSchema = z.record(
  SuiteId,
  z.record(
    z.string(),
    z
      .object({
        model: z.string(),
        acceptedAt: z.iso.date(),
        /** The run the means came from (`dist/evals/…` file name or CI run URL). */
        source: z.string(),
        metrics: BaselineMetrics,
      })
      .strict(),
  ),
);
export type Baselines = z.infer<typeof BaselinesSchema>;

export interface Suite {
  config: SuiteConfig;
  cases: EvalCase[];
  gold: Map<string, Gold>;
}

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetError';
  }
}

function readJson<T>(file: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DatasetError(`${file}: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new DatasetError(
      `${file}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    );
  return parsed.data;
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => path.join(dir, file));
}

/** The short content hash gold files pin their fixtures to. */
export function fixtureHash(root: string, fixture: string): string {
  return createHash('sha256')
    .update(readFileSync(path.join(root, 'fixtures', fixture)))
    .digest('hex')
    .slice(0, 16);
}

export function loadEvalsConfig(root = EVALS_DIR): EvalsConfig {
  return readJson(path.join(root, 'config.json'), EvalsConfigSchema);
}

export function loadBaselines(root = EVALS_DIR): Baselines {
  const file = path.join(root, 'baselines.json');
  return existsSync(file) ? readJson(file, BaselinesSchema) : {};
}

/** The suite directories (every folder with a `config.json`). */
export function suiteIds(root = EVALS_DIR): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, 'config.json')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Loads and cross-checks one suite: every case has gold with the same id, every subset id exists,
 * every fixture exists, and every gold file's fixture hashes match the fixtures on disk.
 */
export function loadSuite(id: string, root = EVALS_DIR): Suite {
  const dir = path.join(root, id);
  const config = readJson(path.join(dir, 'config.json'), SuiteConfigSchema);
  if (config.suite !== id) throw new DatasetError(`${dir}/config.json: suite must be "${id}"`);
  const cases = jsonFiles(path.join(dir, 'cases')).map((file) => {
    const evalCase = readJson(file, EvalCaseSchema);
    if (path.basename(file, '.json') !== evalCase.id)
      throw new DatasetError(`${file}: the file name must be ${evalCase.id}.json`);
    return evalCase;
  });
  const gold = new Map<string, Gold>();
  for (const file of jsonFiles(path.join(dir, 'gold'))) {
    const entry = readJson(file, GoldSchema);
    if (path.basename(file, '.json') !== entry.id)
      throw new DatasetError(`${file}: the file name must be ${entry.id}.json`);
    gold.set(entry.id, entry);
  }
  const ids = new Set<string>();
  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) throw new DatasetError(`${id}: duplicate case ${evalCase.id}`);
    ids.add(evalCase.id);
    const entry = gold.get(evalCase.id);
    if (!entry) throw new DatasetError(`${id}: case ${evalCase.id} has no gold file`);
    for (const doc of evalCase.documents) {
      if (!existsSync(path.join(root, 'fixtures', doc.fixture)))
        throw new DatasetError(`${id}/${evalCase.id}: missing fixture ${doc.fixture}`);
      const pinned = entry.fixtures[doc.fixture];
      if (!pinned) throw new DatasetError(`${id}/${evalCase.id}: gold does not pin fixture ${doc.fixture}`);
      if (pinned !== fixtureHash(root, doc.fixture))
        throw new DatasetError(
          `${id}/${evalCase.id}: fixture ${doc.fixture} changed since the gold was written; review the gold and update its hash`,
        );
    }
  }
  for (const goldId of gold.keys()) if (!ids.has(goldId)) throw new DatasetError(`${id}: gold ${goldId} has no case`);
  for (const subsetId of config.subset)
    if (!ids.has(subsetId)) throw new DatasetError(`${id}: subset names unknown case ${subsetId}`);
  return { config, cases, gold };
}

/** A text fixture's pages (form-feed separated) and where each starts, for citation checks. */
export function readTextFixture(root: string, fixture: string): { text: string; pages: string[]; offsets: number[] } {
  const raw = readFileSync(path.join(root, 'fixtures', fixture), 'utf8').replace(/\r\n/g, '\n');
  const pages = raw.split('\f').map((page) => page.replace(/^\n+/, ''));
  const offsets: number[] = [];
  let at = 0;
  for (const page of pages) {
    offsets.push(at);
    at += page.length;
  }
  return { text: pages.join(''), pages, offsets };
}
