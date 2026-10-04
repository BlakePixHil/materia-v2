/**
 * `materia-scripts stamp --target <web|functions> --version <v> --sha <sha>`
 * Stamps a build with its release (FND-05):
 *   web:       writes apps/web/src/environments/version.ts (run before `nx build web`);
 *   functions: writes dist/apps/functions/.env with MATERIA_RELEASE_VERSION and MATERIA_RELEASE_SHA
 *              (run after `nx build functions`; Firebase loads the file as function env vars).
 * The /health page and the `system-ping` callable report these values.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../..');
export const WEB_VERSION_FILE = 'apps/web/src/environments/version.ts';
export const FUNCTIONS_ENV_FILE = 'dist/apps/functions/.env';

const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export function validate(version: string, sha: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid --version: ${version}`);
  if (!SHA_PATTERN.test(sha)) throw new Error(`Invalid --sha (a hex git SHA): ${sha}`);
}

export function renderWebVersion(version: string, sha: string): string {
  return [
    '// Release stamp, shown on /health. Deploy workflows rewrite this file before building',
    '// (`pnpm materia-scripts stamp --target web`); the committed values are for local builds.',
    `export const RELEASE = { version: '${version}', sha: '${sha}' } as const;`,
    '',
  ].join('\n');
}

export function renderFunctionsEnv(version: string, sha: string): string {
  return `MATERIA_RELEASE_VERSION=${version}\nMATERIA_RELEASE_SHA=${sha}\n`;
}

export async function main(argv: string[], root = WORKSPACE_ROOT): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { target: { type: 'string' }, version: { type: 'string' }, sha: { type: 'string' } },
  });
  const { target, version = '', sha = '' } = values;
  validate(version, sha);
  const [file, contents] =
    target === 'web'
      ? [WEB_VERSION_FILE, renderWebVersion(version, sha)]
      : target === 'functions'
        ? [FUNCTIONS_ENV_FILE, renderFunctionsEnv(version, sha)]
        : (() => {
            throw new Error('--target must be web or functions');
          })();
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
  console.log(`Stamped ${file}: ${version} (${sha})`);
}
