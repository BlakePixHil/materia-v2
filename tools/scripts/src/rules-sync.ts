/**
 * `materia-scripts rules-sync [--check] [--print]`
 * Keeps the security rules in sync with libs/domain (FND-14): the role lists come from PERMISSIONS
 * and the client-writable field whitelists from each entity's `update` schema keys. They are
 * written between the `<generated:rules-sync>` markers of firebase/firestore.rules (roles and
 * fields) and firebase/storage.rules (roles, and the upload types from UPLOAD_TYPES, CORE-12). `--check`
 * writes nothing and exits 1 on drift (a unit
 * test runs it); `--print` prints the generated Firestore block.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as domainModule from '@materia/domain';

export const RULES_FILE = 'firebase/firestore.rules';
export const STORAGE_RULES_FILE = 'firebase/storage.rules';
const START = '// <generated:rules-sync>';
const END = '// </generated:rules-sync>';

interface EntityLike {
  path: string;
  update: { shape?: Record<string, unknown> };
}

interface DomainLike {
  PERMISSIONS: Record<string, readonly string[]>;
  UPLOAD_TYPES?: Record<string, { mime: string }>;
  [name: string]: unknown;
}

/** tsx loads the domain lib as CommonJS (exports on `default`); Vitest loads it as ESM. */
function domain(): DomainLike {
  const ns = domainModule as unknown as DomainLike & { default?: DomainLike };
  return ns.default ?? ns;
}

function isEntity(value: unknown): value is EntityLike {
  return typeof value === 'object' && value !== null && 'path' in value && 'update' in value && 'schema' in value;
}

/** Entity name → its client-writable fields (the `update` schema keys), sorted by name. */
export function entityWhitelists(d: DomainLike = domain()): [string, string[]][] {
  return Object.entries(d)
    .filter((entry): entry is [string, EntityLike] => isEntity(entry[1]))
    .map(([name, entity]): [string, string[]] => [name, Object.keys(entity.update.shape ?? {})])
    .sort(([a], [b]) => a.localeCompare(b));
}

const list = (items: readonly string[]) => `[${items.map((item) => `'${item}'`).join(', ')}]`;

export function renderBlock(d: DomainLike = domain(), { fields = true, uploads = false } = {}): string {
  const perms = Object.entries(d.PERMISSIONS)
    .map(([action, roles]) => `        '${action}': ${list(roles)}`)
    .join(',\n');
  const whitelists = entityWhitelists(d).map(
    ([name, keys]) => `    function fields${name}() { return ${list(keys)}; }`,
  );
  const uploadTypes = Object.entries(d.UPLOAD_TYPES ?? {})
    .map(([ext, type]) => `        '${ext}': '${type.mime}'`)
    .join(',\n');
  return [
    `    ${START} do not edit: \`pnpm materia-scripts rules-sync\` writes this from libs/domain.`,
    '    // Roles allowed each action (PERMISSIONS).',
    '    function perm(action) {',
    '      return {',
    perms,
    '      }[action];',
    '    }',
    ...(fields ? ["    // Client-writable fields per entity (each entity's update schema keys).", ...whitelists] : []),
    ...(uploads
      ? [
          '    // Accepted uploads: extension → the content type they must be uploaded with (UPLOAD_TYPES).',
          '    function uploadTypes() {',
          '      return {',
          uploadTypes,
          '      };',
          '    }',
        ]
      : []),
    `    ${END}`,
  ].join('\n');
}

/** Replaces the generated block in the rules source. Throws if the markers are missing. */
export function applyBlock(rules: string, block: string): string {
  const start = rules.indexOf(START);
  const end = rules.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error(`Missing the ${START} … ${END} markers.`);
  const lineStart = rules.lastIndexOf('\n', start) + 1;
  const lineEnd = rules.indexOf('\n', end);
  return rules.slice(0, lineStart) + block + rules.slice(lineEnd < 0 ? rules.length : lineEnd);
}

export async function main(argv: string[], root = process.cwd()): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { check: { type: 'boolean', default: false }, print: { type: 'boolean', default: false } },
  });
  if (values.print) {
    console.log(renderBlock());
    return;
  }
  const targets = [
    { file: RULES_FILE, block: renderBlock() },
    { file: STORAGE_RULES_FILE, block: renderBlock(domain(), { fields: false, uploads: true }) },
  ];
  const changed: string[] = [];
  for (const { file, block } of targets) {
    const abs = path.join(root, file);
    const current = readFileSync(abs, 'utf8');
    const next = applyBlock(current, block);
    if (next === current) continue;
    changed.push(file);
    if (!values.check) writeFileSync(abs, next);
  }
  if (values.check) {
    if (changed.length) {
      throw new Error(`Out of sync with libs/domain: ${changed.join(', ')}. Run \`pnpm materia-scripts rules-sync\`.`);
    }
    console.log('Rules role lists and whitelists are in sync with libs/domain.');
    return;
  }
  console.log(changed.length ? `Updated ${changed.join(', ')}.` : 'Rules already in sync.');
}
