import { z } from 'zod';

import { PROMPT_SOURCES } from './prompt-sources.generated';
import { OUTPUT_SCHEMAS } from './schemas';

/**
 * The Clerk prompt registry (AI-02, Clerk doc "Prompt management"). Prompts live in
 * `libs/clerk/prompts/<id>@<semver>.md`: YAML-style front-matter, then a `# System` and a `# User`
 * section with `{{variable}}` placeholders. `pnpm materia-scripts clerk-prompts` compiles them into
 * `prompt-sources.generated.ts` so Functions can bundle them; a unit test keeps the two in sync.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;

export const PromptMetaSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-zA-Z0-9-]*$/),
    version: z.string().regex(SEMVER, { message: 'Expected a semantic version such as 1.0.0' }),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    maxTokens: z.number().int().min(1).max(128_000),
    /** A key of `OUTPUT_SCHEMAS`: the reply is structured output validated with that schema. */
    outputSchema: z.string().optional(),
    /** Read-only retrieval tools the model may choose (never forced; Opus 5.5 rejects forced tool use). */
    tools: z.array(z.string()).default([]),
  })
  .strict();
export type PromptMeta = z.infer<typeof PromptMetaSchema>;

export interface PromptTemplate {
  /** `id@version`, recorded on every message and suggestion. */
  ref: string;
  meta: PromptMeta;
  system: string;
  user: string;
}

export interface RenderedPrompt extends PromptTemplate {
  /** The variables that were substituted (for tests; never logged). */
  variables: string[];
}

export type PromptVariables = Record<string, string | number>;

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptError';
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => item.trim()) : [];
  }
  return value.replace(/^["']|["']$/g, '');
}

/** Parses one prompt file. `name` is the file name without `.md` and must equal `id@version`. */
export function parsePrompt(name: string, source: string): PromptTemplate {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  if (!match) throw new PromptError(`${name}: missing front-matter`);
  const [, head = '', body = ''] = match;
  const fields: Record<string, unknown> = {};
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new PromptError(`${name}: bad front-matter line "${line}"`);
    fields[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1));
  }
  const parsed = PromptMetaSchema.safeParse(fields);
  if (!parsed.success)
    throw new PromptError(`${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  const meta = parsed.data;
  const ref = `${meta.id}@${meta.version}`;
  if (ref !== name) throw new PromptError(`${name}: the file name must be ${ref}.md`);
  if (meta.outputSchema && !Object.hasOwn(OUTPUT_SCHEMAS, meta.outputSchema)) {
    throw new PromptError(`${name}: unknown outputSchema "${meta.outputSchema}"`);
  }
  const sections = /^\s*# System\n([\s\S]*?)\n# User\n([\s\S]*)$/.exec(body);
  if (!sections) throw new PromptError(`${name}: needs a "# System" section followed by a "# User" section`);
  return { ref, meta, system: (sections[1] ?? '').trim(), user: (sections[2] ?? '').trim() };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

let registry: Map<string, PromptTemplate> | undefined;

/** Parses a set of prompt sources, keyed by `id@version`. */
export function promptsFrom(sources: Record<string, string>): Map<string, PromptTemplate> {
  return new Map(Object.entries(sources).map(([name, source]) => [name, parsePrompt(name, source)]));
}

/** Every bundled prompt, keyed by `id@version` (parsed once). */
export function prompts(): Map<string, PromptTemplate> {
  registry ??= promptsFrom(PROMPT_SOURCES);
  return registry;
}

/** A prompt by `id@version`, or by bare `id` for its latest version. */
export function getPrompt(ref: string, all: Map<string, PromptTemplate> = prompts()): PromptTemplate {
  if (ref.includes('@')) {
    const found = all.get(ref);
    if (!found) throw new PromptError(`Unknown prompt ${ref}`);
    return found;
  }
  const versions = [...all.values()].filter((p) => p.meta.id === ref);
  const latest = versions.sort((a, b) => compareVersions(b.meta.version, a.meta.version))[0];
  if (!latest) throw new PromptError(`Unknown prompt ${ref}`);
  return latest;
}

function substitute(template: string, vars: PromptVariables, used: Set<string>, ref: string): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new PromptError(`${ref}: missing variable "${name}"`);
    used.add(name);
    return String(vars[name]);
  });
}

/**
 * Renders a prompt with strict variable checking: every placeholder needs a value, every value
 * must be used, and values are plain strings or numbers (documents go in as content blocks, never
 * through variables).
 */
export function renderPrompt(ref: string, vars: PromptVariables, all?: Map<string, PromptTemplate>): RenderedPrompt {
  const template = getPrompt(ref, all);
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new PromptError(`${template.ref}: variable "${name}" must be a string or number`);
    }
  }
  const used = new Set<string>();
  const system = substitute(template.system, vars, used, template.ref);
  const user = substitute(template.user, vars, used, template.ref);
  const unused = Object.keys(vars).filter((name) => !used.has(name));
  if (unused.length) throw new PromptError(`${template.ref}: unused variable(s) ${unused.join(', ')}`);
  return { ...template, system, user, variables: [...used] };
}

/** The generated module for a set of prompt files (sorted, so the output is stable). */
export function generatePromptModule(files: { name: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sorted) parsePrompt(file.name, file.content);
  const entries = sorted.map((file) => `  ${JSON.stringify(file.name)}: ${JSON.stringify(file.content)},`).join('\n');
  return [
    '// Generated by `pnpm materia-scripts clerk-prompts` from libs/clerk/prompts/*.md. Do not edit.',
    'export const PROMPT_SOURCES: Record<string, string> = {',
    entries,
    '};',
    '',
  ].join('\n');
}
