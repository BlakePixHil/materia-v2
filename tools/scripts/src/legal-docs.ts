/**
 * `materia-scripts legal-docs [--check]` (SEC-01): compiles the published legal documents in
 * docs/compliance/*.md into the registry in @materia/domain (metadata: key, title, version,
 * effective date, status), the terms' version (`TERMS_VERSION`, a module of its own) and the web
 * app's content module (the text the `/legal/*` pages render), so the docs and the app are one source. A file is published when it has front-matter; the rest
 * of docs/compliance (the PIA) stays internal.
 *
 * Each published file has front-matter (`key`, `title`, `summary`, `version`, `effective`,
 * `status`, `order`), then `# <title>`, then, while it's a draft, the draft notice
 * (`> **Draft — not yet reviewed.** …`). The app shows the title, version, date and its own draft
 * banner from the registry, so the compiler checks both and leaves them out of the content. Links
 * to another published file (`[terms](terms-of-service.md)`) become `/legal/<key>`; a published
 * document can't link to anything else in the repository. `--check` writes nothing and fails on
 * drift (the unit tests check the same).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const COMPLIANCE_DIR = 'docs/compliance';
export const REGISTRY_FILE = 'libs/domain/src/lib/legal-documents.generated.ts';
/** `TERMS_VERSION` on its own, so the app's terms check loads without the registry. */
export const TERMS_VERSION_FILE = 'libs/domain/src/lib/terms-version.generated.ts';
export const CONTENT_FILE = 'apps/web/src/app/features/legal/legal-content.generated.ts';
/** How every draft's notice starts. */
export const DRAFT_NOTICE = '> **Draft — not yet reviewed.**';
/** The terms of service and the DPA are one agreement: one version, accepted together. */
const AGREEMENT_KEYS = ['terms', 'dpa'] as const;

export interface LegalSource {
  /** The file name, `privacy-policy.md`. */
  file: string;
  content: string;
}

export interface LegalDocument {
  key: string;
  title: string;
  summary: string;
  version: string;
  effectiveDate: string;
  status: 'draft' | 'final';
  order: number;
  source: string;
  /** The Markdown the app renders: no front-matter, title or draft notice, links rewritten. */
  body: string;
}

export class LegalDocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalDocError';
  }
}

const FIELDS = ['key', 'title', 'summary', 'version', 'effective', 'status', 'order'] as const;
const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION = /^\d+\.\d+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Splits front-matter (`key: value` lines between `---` fences) from the body; null without it. */
function splitFrontMatter(file: string, source: string): { fields: Record<string, string>; body: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new LegalDocError(`${file}: bad front-matter line "${line}"`);
    const name = line.slice(0, colon).trim();
    if (!(FIELDS as readonly string[]).includes(name)) throw new LegalDocError(`${file}: unknown field "${name}"`);
    fields[name] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return { fields, body: match[2] ?? '' };
}

/** Parses one file; null when it has no front-matter (an internal document, such as the PIA). */
export function parseLegalDoc(file: string, source: string, dir = COMPLIANCE_DIR): LegalDocument | null {
  const split = splitFrontMatter(file, source);
  if (!split) return null;
  const { fields } = split;
  for (const name of FIELDS) if (!fields[name]) throw new LegalDocError(`${file}: missing "${name}"`);
  const { key, title, summary, version, effective, status, order } = fields as Record<(typeof FIELDS)[number], string>;
  if (!KEY.test(key)) throw new LegalDocError(`${file}: key "${key}" must be lower-case letters, digits and dashes`);
  if (!VERSION.test(version)) throw new LegalDocError(`${file}: version "${version}" must look like 1.0`);
  if (!validDate(effective)) throw new LegalDocError(`${file}: effective "${effective}" must be a YYYY-MM-DD date`);
  if (status !== 'draft' && status !== 'final') throw new LegalDocError(`${file}: status must be draft or final`);
  if (!/^\d+$/.test(order)) throw new LegalDocError(`${file}: order must be a whole number`);

  const lines = split.body.replace(/^\n+/, '').split('\n');
  if (lines[0] !== `# ${title}`) throw new LegalDocError(`${file}: must start with "# ${title}"`);
  let start = 1;
  while (start < lines.length && !lines[start]?.trim()) start++;
  const notice = lines[start]?.startsWith(DRAFT_NOTICE) ?? false;
  if (status === 'draft') {
    if (!notice) throw new LegalDocError(`${file}: a draft starts with the draft notice "${DRAFT_NOTICE} …"`);
    while (start < lines.length && lines[start]?.startsWith('>')) start++;
  } else if (notice || split.body.includes(DRAFT_NOTICE)) {
    throw new LegalDocError(`${file}: a final document has no draft notice`);
  }
  return {
    key,
    title,
    summary,
    version,
    effectiveDate: effective,
    status,
    order: Number(order),
    source: `${dir}/${file}`,
    body: lines.slice(start).join('\n').trim(),
  };
}

/** Rewrites links to other published files as `/legal/<key>`; anything else in the repo is refused. */
function rewriteLinks(doc: LegalDocument, published: ReadonlyMap<string, string>): string {
  return doc.body.replace(/\]\(([^)\s]*)\)/g, (whole, href: string) => {
    if (/^(https?:|mailto:)/i.test(href)) return whole;
    const target = published.get(href);
    if (target) return `](/legal/${target})`;
    throw new LegalDocError(
      `${doc.source}: links to "${href}", which isn't a published legal document (only those, https and mailto links are allowed)`,
    );
  });
}

/** Parses and checks every published document, in index order, with their links rewritten. */
export function legalDocuments(sources: readonly LegalSource[], dir = COMPLIANCE_DIR): LegalDocument[] {
  const docs = sources
    .map((source) => ({ file: source.file, doc: parseLegalDoc(source.file, source.content, dir) }))
    .filter((entry): entry is { file: string; doc: LegalDocument } => entry.doc !== null);
  const published = new Map(docs.map(({ file, doc }) => [file, doc.key]));
  for (const field of ['key', 'order'] as const) {
    const seen = new Set<string | number>();
    for (const { doc } of docs) {
      if (seen.has(doc[field])) throw new LegalDocError(`Two legal documents share the ${field} "${doc[field]}"`);
      seen.add(doc[field]);
    }
  }
  const agreement = AGREEMENT_KEYS.map((key) => docs.find(({ doc }) => doc.key === key)?.doc);
  const [terms, dpa] = agreement;
  if (!terms || !dpa)
    throw new LegalDocError(`The terms of service and the DPA (keys ${AGREEMENT_KEYS.join(', ')}) are required`);
  if (terms.version !== dpa.version)
    throw new LegalDocError(
      `The terms (${terms.version}) and the DPA (${dpa.version}) are one agreement: give them one version`,
    );
  return docs.map(({ doc }) => ({ ...doc, body: rewriteLinks(doc, published) })).sort((a, b) => a.order - b.order);
}

/** The registry module in @materia/domain. */
export function registryModule(docs: readonly LegalDocument[]): string {
  const entries = docs.map((doc) =>
    [
      '  {',
      `    key: ${JSON.stringify(doc.key)},`,
      `    title: ${JSON.stringify(doc.title)},`,
      `    summary: ${JSON.stringify(doc.summary)},`,
      `    version: ${JSON.stringify(doc.version)},`,
      `    effectiveDate: ${JSON.stringify(doc.effectiveDate)},`,
      `    status: ${JSON.stringify(doc.status)},`,
      `    source: ${JSON.stringify(doc.source)},`,
      '  },',
    ].join('\n'),
  );
  return [
    `// Generated by \`pnpm materia-scripts legal-docs\` from ${COMPLIANCE_DIR}/*.md. Do not edit.`,
    '/** The published legal documents (SEC-01), in the order the `/legal` index lists them. */',
    'export const LEGAL_DOCUMENT_LIST = [',
    ...entries,
    '] as const;',
    '',
  ].join('\n');
}

/** The terms' version, in a module of its own (the app's terms check is in its initial bundle). */
export function termsVersionModule(docs: readonly LegalDocument[]): string {
  const terms = docs.find((doc) => doc.key === 'terms') as LegalDocument;
  return [
    `// Generated by \`pnpm materia-scripts legal-docs\` from ${terms.source}. Do not edit.`,
    '/** The terms of service and DPA version an org’s owner accepts (SEC-01). */',
    `export const TERMS_VERSION = ${JSON.stringify(terms.version)};`,
    '',
  ].join('\n');
}

/** The content module the web app's `/legal/*` pages render (lazily loaded with them). */
export function contentModule(docs: readonly LegalDocument[]): string {
  const entries = docs.map((doc) => `  ${JSON.stringify(doc.key)}: ${JSON.stringify(doc.body)},`);
  return [
    `// Generated by \`pnpm materia-scripts legal-docs\` from ${COMPLIANCE_DIR}/*.md. Do not edit.`,
    "import type { LegalDocumentKey } from '@materia/domain';",
    '',
    '/** Each published legal document’s text (SEC-01), as Markdown, by key. */',
    'export const LEGAL_CONTENT: Readonly<Record<LegalDocumentKey, string>> = {',
    ...entries,
    '};',
    '',
  ].join('\n');
}

export function readLegalSources(root: string, dir = COMPLIANCE_DIR): LegalSource[] {
  const full = path.join(root, dir);
  return readdirSync(full)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => ({ file, content: readFileSync(path.join(full, file), 'utf8') }));
}

/** The generated files for the documents under `root`. */
export function compileLegalDocs(root: string): { file: string; next: string }[] {
  const docs = legalDocuments(readLegalSources(root));
  return [
    { file: REGISTRY_FILE, next: registryModule(docs) },
    { file: TERMS_VERSION_FILE, next: termsVersionModule(docs) },
    { file: CONTENT_FILE, next: contentModule(docs) },
  ];
}

export async function main(argv: string[], root = process.cwd()): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { check: { type: 'boolean', default: false } } });
  const outputs = compileLegalDocs(root).map((output) => {
    let current = '';
    try {
      current = readFileSync(path.join(root, output.file), 'utf8');
    } catch {
      // Not generated yet.
    }
    return { ...output, current };
  });
  const stale = outputs.filter((output) => output.current !== output.next);
  if (values.check) {
    if (stale.length)
      throw new Error(`${stale.map((o) => o.file).join(', ')} out of date. Run \`pnpm materia-scripts legal-docs\`.`);
    console.log('The legal documents are compiled and in sync.');
    return;
  }
  for (const output of stale) writeFileSync(path.join(root, output.file), output.next);
  console.log(stale.length ? 'Compiled the legal documents.' : 'The legal documents were already compiled.');
}
