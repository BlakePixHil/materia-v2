/**
 * `materia-scripts sync-design [--check] [--skip-build]`
 * Syncs the design system (design/system/*.py, FND-01) into libs/ui (FND-07):
 *  1. runs `python3 design/system/build.py` (skip with --skip-build);
 *  2. copies the token CSS to libs/ui/src/generated/tokens.css, with font URLs pointing at /fonts/;
 *  3. splits components/bundle.css into libs/ui/src/generated/components/<name>.css by `mt-<name>` prefix;
 *  4. writes libs/ui/src/generated/tokens.ts (typed token map) from tokens.json;
 *  5. writes libs/ui/src/generated/icons.ts: the design system's Lucide icons (by Materia name) as
 *     Lucide icon data, plus the custom status glyph SVGs, read from design/system/icons.py;
 *  6. copies the Geist variable fonts to apps/web/public/fonts/.
 * `--check` writes nothing and exits 1 if any output would change (CI drift check). Python 3.11+ is
 * needed in every mode (the icons are read from icons.py).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const PATHS = {
  build: 'design/system/build.py',
  tokensCss: 'design/tokens/materia.tokens.css',
  bundleCss: 'design/system/project/components/bundle.css',
  tokensJson: 'design/system/project/tokens.json',
  fontsDir: 'design/system/project/fonts',
  outDir: 'libs/ui/src/generated',
  publicFonts: 'apps/web/public/fonts',
} as const;

export const FONT_FILES = ['Geist-Variable.woff2', 'GeistMono-Variable.woff2'] as const;

const HEADER = (source: string) =>
  `/* generated — do not edit. Source: ${source}. Regenerate with \`pnpm materia-scripts sync-design\`. */\n`;

const PYTHON_HELP = [
  'sync-design needs Python 3.11+ to run design/system/build.py.',
  '  macOS:   brew install python@3.12',
  '  Ubuntu:  sudo apt-get install python3',
  '  Windows: winget install Python.Python.3.12',
  'Or pass --skip-build to sync the already-built outputs in design/.',
].join('\n');

/** Sections of bundle.css that are global, not a component. */
const SECTION_FILES: Record<string, string> = {
  base: 'base',
  'layout helpers': 'layout',
  'preview scaffolding (design-system previews only)': 'preview',
  motion: 'base',
};

/** Token CSS for the lib: the design file with font URLs rewritten to the app's /fonts/ path. */
export function transformTokensCss(css: string): string {
  const body = css.replace(/^\/\*.*?\*\/\n/, '').replace(/url\("[^"]*\/fonts\/([^"/]+\.woff2)"\)/g, 'url("/fonts/$1")');
  return HEADER(PATHS.tokensCss) + body;
}

function sectionName(line: string): string | undefined {
  const match = /^\/\* (?:-+ )?(.+?)(?: -+)? \*\/$/.exec(line.trim());
  return match?.[1]?.toLowerCase();
}

/**
 * Splits bundle.css into files keyed by the first `mt-<name>` class on each line. Rules are one per
 * line in the generated bundle; the base, layout, preview and motion sections stay whole.
 */
export function splitBundle(css: string): Map<string, string> {
  const files = new Map<string, string[]>();
  const add = (name: string, line: string) => files.set(name, [...(files.get(name) ?? []), line]);
  let section: string | undefined;
  let inHeader = true;
  for (const line of css.split('\n')) {
    if (inHeader) {
      if (line.startsWith(' */')) inHeader = false;
      continue;
    }
    const heading = sectionName(line);
    if (heading !== undefined && line.startsWith('/*')) {
      section = heading;
      continue;
    }
    if (!line.trim()) continue;
    const fixed = section === undefined ? undefined : SECTION_FILES[section];
    const prefix = /\.mt-([a-z]+)/.exec(line)?.[1];
    add(fixed ?? prefix ?? 'base', line);
  }
  const out = new Map<string, string>();
  for (const name of [...files.keys()].sort()) {
    out.set(`${name}.css`, HEADER(`${PATHS.bundleCss} (mt-${name})`) + (files.get(name) ?? []).join('\n') + '\n');
  }
  return out;
}

interface TokenEntry {
  name: string;
  value: string | { light: string; dark: string };
  usage: string;
}

interface TokensJson {
  color: { tokens: TokenEntry[] };
  type: { families: Record<string, string>; groups: unknown[] };
  spacing: { tokens: TokenEntry[] };
  radius: { tokens: TokenEntry[] };
  shadow: { tokens: TokenEntry[] };
  size: { tokens: TokenEntry[] };
}

const pick = (tokens: TokenEntry[]) => tokens.map(({ name, value, usage }) => ({ name, value, usage }));

/** The typed token map: names, values (palette hex, or light/dark references) and usage notes. */
export function renderTokensTs(json: TokensJson): string {
  const data = {
    color: pick(json.color.tokens),
    spacing: pick(json.spacing.tokens),
    radius: pick(json.radius.tokens),
    shadow: pick(json.shadow.tokens),
    size: pick(json.size.tokens),
    type: { families: json.type.families, groups: json.type.groups },
  };
  const body = JSON.stringify(data, null, 2);
  return [
    HEADER(PATHS.tokensJson).trimEnd(),
    `export const MT_TOKENS = ${body} as const;`,
    '',
    'export type MtColorToken = (typeof MT_TOKENS.color)[number]["name"];',
    'export type MtSpacingToken = (typeof MT_TOKENS.spacing)[number]["name"];',
    'export type MtRadiusToken = (typeof MT_TOKENS.radius)[number]["name"];',
    'export type MtShadowToken = (typeof MT_TOKENS.shadow)[number]["name"];',
    'export type MtSizeToken = (typeof MT_TOKENS.size)[number]["name"];',
    'export type MtTokenName = MtColorToken | MtSpacingToken | MtRadiusToken | MtShadowToken | MtSizeToken;',
    '',
  ].join('\n');
}

export interface IconsDump {
  icons: Record<string, string>;
  status: Record<string, string>;
}

const STATUS_KINDS = ['draft', 'active', 'review', 'done', 'blocked'] as const;

/** Parses the self-closing SVG elements of an icon (`<path d="…"/>`) into Lucide icon nodes. */
export function svgToNodes(svg: string): [string, Record<string, string>][] {
  const nodes: [string, Record<string, string>][] = [];
  for (const element of svg.matchAll(/<([a-z]+)((?:\s+[a-z][a-z0-9-]*="[^"]*")*)\s*\/>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of (element[2] ?? '').matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/g))
      attrs[attr[1] ?? ''] = attr[2] ?? '';
    nodes.push([element[1] ?? '', attrs]);
  }
  const rebuilt = nodes
    .map(
      ([tag, attrs]) =>
        `<${tag}${Object.entries(attrs)
          .map(([k, v]) => ` ${k}="${v}"`)
          .join('')}/>`,
    )
    .join('');
  if (rebuilt !== svg) throw new Error(`Unsupported SVG markup in icon: ${svg}`);
  return nodes;
}

/** Lucide icon data keyed by Materia icon name, plus the custom status glyphs. */
export function renderIconsTs(dump: IconsDump): string {
  const icons = Object.fromEntries(
    Object.keys(dump.icons)
      .sort()
      .map((name) => [name, { name: `mt-${name}`, node: svgToNodes(dump.icons[name] ?? '') }]),
  );
  const status = Object.fromEntries(STATUS_KINDS.map((kind) => [kind, dump.status[kind] ?? '']));
  return [
    HEADER('design/system/icons.py').trimEnd(),
    "import type { LucideIconData } from '@lucide/angular';",
    '',
    '/** Lucide icons (ISC licence) under their Materia names, in the Lucide icon data format. */',
    `export const MT_ICONS = ${JSON.stringify(icons, null, 2)} satisfies Record<string, LucideIconData>;`,
    '',
    'export type MtIconName = keyof typeof MT_ICONS;',
    '',
    '/** Custom status glyphs (`.mt-status`), as rendered by the design system. */',
    `export const MT_STATUS_GLYPHS = ${JSON.stringify(status, null, 2)} as const;`,
    '',
    'export type MtStatusKind = keyof typeof MT_STATUS_GLYPHS;',
    '',
  ].join('\n');
}

const ICONS_DUMP = [
  'import json, sys',
  "sys.path.insert(0, 'design/system')",
  'import icons',
  `kinds = ${JSON.stringify(STATUS_KINDS)}`,
  "print(json.dumps({'icons': icons.ICONS, 'status': {k: icons.status(k) for k in kinds}}, sort_keys=True))",
].join('\n');

function python(root: string, args: string[]): string {
  const result = spawnSync('python3', ['-B', ...args], { cwd: root, encoding: 'utf8' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') throw new Error(PYTHON_HELP);
  if (result.status !== 0) throw new Error(`python3 failed:\n${result.stderr || result.stdout}\n\n${PYTHON_HELP}`);
  return result.stdout;
}

export interface SyncOutput {
  /** Repo-relative path → contents. */
  files: Map<string, string | Buffer>;
  /** Directories whose other files are stale and must not exist. */
  ownedDirs: string[];
}

export function computeOutputs(root: string, icons: IconsDump): SyncOutput {
  const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
  const files = new Map<string, string | Buffer>();
  files.set(`${PATHS.outDir}/tokens.css`, transformTokensCss(read(PATHS.tokensCss)));
  for (const [name, css] of splitBundle(read(PATHS.bundleCss))) files.set(`${PATHS.outDir}/components/${name}`, css);
  files.set(`${PATHS.outDir}/tokens.ts`, renderTokensTs(JSON.parse(read(PATHS.tokensJson)) as TokensJson));
  files.set(`${PATHS.outDir}/icons.ts`, renderIconsTs(icons));
  for (const font of FONT_FILES) {
    files.set(`${PATHS.publicFonts}/${font}`, readFileSync(path.join(root, PATHS.fontsDir, font)));
  }
  return { files, ownedDirs: [PATHS.outDir, `${PATHS.outDir}/components`] };
}

/** Paths that differ from disk, plus stale files in owned directories. */
export function diffOutputs(root: string, out: SyncOutput): string[] {
  const changed: string[] = [];
  for (const [file, contents] of out.files) {
    const abs = path.join(root, file);
    const expected = typeof contents === 'string' ? Buffer.from(contents) : contents;
    if (!existsSync(abs) || !readFileSync(abs).equals(expected)) changed.push(file);
  }
  for (const dir of out.ownedDirs) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isFile() && !out.files.has(rel)) changed.push(`${rel} (stale)`);
    }
  }
  return changed.sort();
}

export function writeOutputs(root: string, out: SyncOutput): void {
  for (const dir of out.ownedDirs) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && !out.files.has(`${dir}/${entry.name}`)) rmSync(path.join(abs, entry.name));
    }
  }
  for (const [file, contents] of out.files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { check: { type: 'boolean', default: false }, 'skip-build': { type: 'boolean', default: false } },
  });
  const root = process.cwd();
  if (!values['skip-build'] && !values.check) python(root, [PATHS.build]);
  const out = computeOutputs(root, JSON.parse(python(root, ['-c', ICONS_DUMP])) as IconsDump);
  const changed = diffOutputs(root, out);
  if (values.check) {
    if (changed.length) {
      throw new Error(
        `Design outputs are out of date. Run \`pnpm materia-scripts sync-design\`:\n  ${changed.join('\n  ')}`,
      );
    }
    console.log('Design outputs are in sync.');
    return;
  }
  writeOutputs(root, out);
  console.log(changed.length ? `Updated:\n  ${changed.join('\n  ')}` : 'Design outputs already in sync.');
}
