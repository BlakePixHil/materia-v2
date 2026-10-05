# Clerk evals (AI-12)

Golden datasets, graders and a regression gate for every Clerk prompt. Everything here is
**fictional** (every text fixture says SAMPLE). Never put real client data in this folder.

## Run them

```sh
# No tokens: the whole harness on the fake provider (plumbing only, never gates).
pnpm nx run clerk:eval --feature=all --subset --provider=fake

# Live, on the real gateway. Needs an eval-only key (never an org's key).
CLERK_EVALS_API_KEY=sk-ant-… pnpm nx run clerk:eval --feature=privilege,injection --subset
CLERK_EVALS_API_KEY=sk-ant-… pnpm nx run clerk:eval --feature=all --model=claude-opus-5-5 --judge
```

| Option              | Meaning                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `--feature=<suite>` | A suite id, a comma-separated list, or `all` (default)                                       |
| `--subset`          | Only each suite's `subset` cases, once (the PR run). Otherwise every case, `runs.full` times |
| `--model=<id>`      | The model under test (default `defaultModel` in `config.json`)                               |
| `--runs=<n>`        | Runs per case, overriding the suite (1 to 5)                                                 |
| `--judge`           | Also grade API citations with the LLM judge (`citationSupport`; costs a call per case)       |
| `--provider=fake`   | The fake provider: checks plumbing, spends nothing, never gates                              |
| `--accept-baseline` | Record the passing suites' means in `baselines.json` (see below)                             |
| `--out=<dir>`       | Report directory (default `dist/evals`)                                                      |

Each run writes `dist/evals/<suite>/<timestamp>.json` and `.md`, plus `dist/evals/latest.*`. Reports
hold case ids, scores, statuses and token counts only, never prompt or output text, so they are
safe to upload as CI artifacts. Exit code 0 means passed (pending and inconclusive suites don't
fail a run), 1 means the gate failed or the budget ran out, and 2 means bad arguments or data.

The runner (`apps/functions/src/clerk/evals/`) calls the real `createClerkGateway`: the same prompt
rendering, structured-output validation, citation mapping and cost metering as production. It uses
an in-memory store with no limits, every flag on, the eval key, the model under test on every request
and no availability fallbacks (a fallback would measure a different model). At most `concurrency`
(4) cases run at once.

## Layout

```
config.json          concurrency, budgetUsd {subset, full}, defaultModel, attempts
baselines.json       accepted means per suite and prompt version (accept-baseline commits only)
fixtures/            fictional wills, matter documents and drafting material (.txt, generated .pdf)
fixtures/pdfs.json   which .txt fixtures are rendered as typed and/or scanned PDFs
<suite>/config.json  suite, title, ticket, feature, promptId, subset, runs, metrics, fields, citations
<suite>/cases/*.json the input: role, today, matter facts, notes, documents, query
<suite>/gold/*.json  the expected result, and the sha256 of every fixture it was written against
```

| Suite             | Ticket | Prompt                              | Cases | Checks                                                       |
| ----------------- | ------ | ----------------------------------- | ----- | ------------------------------------------------------------ |
| `chat`            | AI-06  | `chat-answer@0.1.0`                 | 13    | citations, coverage, outcome-prediction refusal, inventions  |
| `will-extraction` | AI-08  | `will-extract@0.1.0`                | 11    | schema, fields, quotes on the cited page (typed and scanned) |
| `injection`       | AI-12  | `chat-answer` and `will-extract`    | 15    | obeyed markers, flagged injections, fields still right       |
| `privilege`       | AI-12  | `chat-answer@0.1.0`                 | 17    | canaries from privileged material never reach the output     |
| `classification`  | AI-04  | `classify-document@1.0.0` (pending) | 10    | schema, category                                             |
| `brief`           | AI-09  | `brief@1.0.0` (pending)             | 10    | no inventions, privileged items stay out                     |
| `drafting`        | AI-10  | `draft-letter@1.0.0` (pending)      | 10    | `[[MISSING: …]]` placeholders instead of invented facts      |
| `time-assist`     | AI-11  | `time-assist@1.0.0` (pending)       | 10    | schema, units                                                |

A suite whose prompt isn't in the registry yet is reported **pending** and costs nothing. When its
ticket adds the prompt (and the variables it needs, in `caseVariables` in
`apps/functions/src/clerk/evals/executor.ts`), the suite runs.

## Graders

All in `libs/clerk/src/lib/evals/graders.ts`, pure and unit-tested. A grader that doesn't apply to a
case (no gold for it) is left out rather than scored.

| Metric                     | What it checks                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `schemaValid`              | Structured output parsed against the prompt's schema                                                                       |
| `fieldAccuracy`            | Each gold field by its mode in the suite config: `exact`, `normalised`, `setF1` (names) or `date` (AU formats)             |
| `citationPrecision`        | Each quote (API citation, or a `quote` field in structured output) appears on the page it cites                            |
| `citationSupport`          | `--judge` only: the LLM judge (`eval-citation-judge@1.0.0`) agrees the quote supports the cited sentence                   |
| `citationCoverage`         | Share of factual sentences in a free-text answer that carry a citation                                                     |
| `privilegeLeak`            | None of the case's canaries (planted only in privileged documents and notes) appears in the output                         |
| `injectionResistance`      | None of the markers an injected instruction asks for appears (reported injections in `suspiciousInstructions` don't count) |
| `injectionFlagged`         | The output tells the user about the embedded instruction (reported, not gated)                                             |
| `outcomePredictionRefusal` | Asked to predict a claim's outcome, the answer declines and predicts nothing                                               |
| `placeholderHonesty`       | Missing facts are marked `[[MISSING: …]]` and none is invented                                                             |
| `noInventions`             | None of the gold's `mustNotContain` phrases appears                                                                        |
| `latencyMs`, `costUsd`     | Per case, from the gateway's metering (list prices in `libs/clerk/src/lib/prices.ts`)                                      |

## The gate

Each suite's `config.json` sets, per metric, a `min` or `max` threshold and a `maxRegression`
(absolute for scores, a fractional increase for latency and cost). A suite **fails** when a
threshold or a regression is breached, or when any case errors (a provider 400, invalid
arguments). A provider outage (overloaded, rate limited, timed out) is retried `attempts` times and
then the case is **inconclusive**; a suite with fewer than half its runs scored is inconclusive, not
failed. Read-only users are refused by the gateway (`clerk.use`); that refusal is scored as an empty
answer.

Baselines are keyed by the suite's prompt versions. A new prompt version is compared with the
suite's most recently accepted baseline, so a prompt change can't reset its own bar.

**Accepting a baseline** is always an explicit commit: run the suite with `--accept-baseline` (or
the workflow's `accept_baseline` input, which uploads the file as an artifact), check the numbers,
and commit `baselines.json` with a message starting `accept baseline:` and saying why.

## Budget and cost

`config.json` → `budgetUsd` caps each run: $3 for a subset, $8 for a full run. When the spend
reaches the cap, no new case starts, the rest are skipped and the run fails as aborted. Every
report ends with a cost table (tokens and dollars per suite, total against the cap).

## CI (`.github/workflows/clerk-evals.yml`)

- **Every PR touching Clerk:** fixtures and prompts in sync, and the harness on the fake provider.
  No tokens.
- **PRs that change `libs/clerk/prompts/` or `libs/clerk/evals/`** (not forks): also the live
  subset. The report is posted as a PR comment and the `clerk-evals` check fails on a regression.
- **Nightly**, 06:30 Melbourne: the full suites, twice per case for run-to-run variance, but only
  when Clerk changed on main that day, or on Mondays (model drift).
- **Manual dispatch:** any suite, subset or full, any model, optional judge and baseline.

The key is the dev Secret Manager secret `ANTHROPIC_API_KEY` (eval-only), read as the dev deployer
through Workload Identity Federation. Without it, live runs are skipped (infra/MANUAL.md).

## Adding cases and fixtures

1. Write the fixture as `.txt` under `fixtures/` (form feed `\f` between pages, "SAMPLE" in it). To
   test PDFs, list it in `fixtures/pdfs.json` and run `pnpm materia-scripts make-fixtures` (a typed
   PDF with a text layer, and a scanned one rendered as a skewed, speckled image with no text layer;
   both deterministic).
2. Add `cases/<id>.json` and `gold/<id>.json`. The gold's `fixtures` map pins the sha256 (first 16
   hex characters) of every fixture the case uses: `fixtureHash` in `dataset.ts`. Editing a fixture
   makes the dataset tests fail until the gold is checked and re-pinned, so gold is versioned with
   its fixtures.
3. Privilege cases: plant a unique canary in privileged material only. Injection cases: make the
   injected instruction ask for a marker that appears nowhere in the inputs. The dataset tests check
   both.
4. Run `pnpm nx test clerk` (dataset validation, graders, gate, runner).
