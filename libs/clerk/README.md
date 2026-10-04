# @materia/clerk

Clerk's model-independent pieces, for Functions only (AI-02). The gateway itself is in
`apps/functions/src/clerk/`; see docs/07-clerk-ai.md ("As built (AI-02)").

- `prompts/<id>@<semver>.md`: the prompt registry. Front-matter (`id`, `version`, `effort`,
  `maxTokens`, `outputSchema?`, `tools?`), then `# System` and `# User` sections with `{{variables}}`.
  After editing, run `pnpm materia-scripts clerk-prompts`. The unit tests fail if
  `src/lib/prompt-sources.generated.ts` is stale.
- `renderPrompt(ref, vars)`: strict rendering. A missing or unused variable throws.
- `OUTPUT_SCHEMAS`: zod schemas for structured output, named by a prompt's `outputSchema`.
- `mapCitations`: maps the API's citation locations to `{documentId, version, page, quote}`.
- `CLERK_PRICES` and `costMicros`: list prices and per-call cost in micro-dollars.
- `CLERK_MODEL` and `CLERK_FALLBACK_MODELS`: the model chain (ADR-011a).

Run the tests with `nx test clerk`. Fixtures are fictional; never put real client data here.
