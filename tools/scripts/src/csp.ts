/**
 * `materia-scripts csp <check|emulator-config>`: the Hosting Content Security Policy (FND-22). The
 * policy lives in firebase.json (the headers on every Hosting response).
 *
 *   pnpm materia-scripts csp check [--html dist/apps/web/browser/index.html]
 *     Fails when the built index.html has an inline script whose hash is not in script-src, or an
 *     inline event handler. Angular's critical-CSS inliner (Beasties) adds one such script; its
 *     hash is recorded in apps/web/csp-hashes.json and only changes with Angular.
 *
 *   pnpm materia-scripts csp emulator-config [--out firebase.e2e.json]
 *     Writes a copy of firebase.json whose policy also allows the emulators (http://127.0.0.1:*),
 *     so e2e runs against the Hosting emulator under the real policy.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../..');
const CSP_HEADER = 'Content-Security-Policy';
/** The emulator origin, and the directives the web app reaches it through. */
const EMULATOR_SOURCE = 'http://127.0.0.1:*';
const EMULATOR_DIRECTIVES = ['connect-src', 'img-src', 'frame-src'];

interface HostingHeaders {
  source: string;
  headers: { key: string; value: string }[];
}

export interface FirebaseConfig {
  hosting: { headers?: HostingHeaders[] } & Record<string, unknown>;
  [key: string]: unknown;
}

export type Policy = Map<string, string[]>;

export function readFirebaseConfig(file = path.join(WORKSPACE_ROOT, 'firebase.json')): FirebaseConfig {
  return JSON.parse(readFileSync(file, 'utf8')) as FirebaseConfig;
}

/** The policy firebase.json sends on every response (the `**` rule). */
export function hostingPolicy(config: FirebaseConfig): string {
  const value = config.hosting.headers
    ?.find((rule) => rule.source === '**')
    ?.headers.find((header) => header.key === CSP_HEADER)?.value;
  if (!value) throw new Error(`firebase.json has no ${CSP_HEADER} header on the "**" rule`);
  return value;
}

export function parsePolicy(policy: string): Policy {
  const directives: Policy = new Map();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

export function formatPolicy(policy: Policy): string {
  return [...policy].map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
}

export function scriptHash(body: string): string {
  return `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
}

/** What in this HTML the policy would block: unhashed inline scripts and inline event handlers. */
export function policyViolations(html: string, policy: Policy): string[] {
  const allowed = new Set(policy.get('script-src') ?? policy.get('default-src') ?? []);
  const violations: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1] ?? '';
    const hash = scriptHash(body);
    if (!allowed.has(hash)) violations.push(`inline script ${hash} is not in script-src: ${body.trim().slice(0, 80)}`);
  }
  for (const match of html.matchAll(/<[a-z][^>]*\s(on[a-z]+)=/gi)) {
    violations.push(`inline event handler ${match[1]} (CSP blocks it; use a listener in code)`);
  }
  return violations;
}

/** firebase.json with the emulator origin added to the policy, for e2e against the emulators. */
export function emulatorConfig(config: FirebaseConfig): FirebaseConfig {
  const policy = parsePolicy(hostingPolicy(config));
  for (const name of EMULATOR_DIRECTIVES) policy.set(name, [...(policy.get(name) ?? []), EMULATOR_SOURCE]);
  const headers = (config.hosting.headers ?? []).map((rule) =>
    rule.source === '**'
      ? {
          ...rule,
          headers: rule.headers.map((h) => (h.key === CSP_HEADER ? { ...h, value: formatPolicy(policy) } : h)),
        }
      : rule,
  );
  return { ...config, hosting: { ...config.hosting, headers } };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      html: { type: 'string', default: 'dist/apps/web/browser/index.html' },
      out: { type: 'string', default: 'firebase.e2e.json' },
      config: { type: 'string', default: path.join(WORKSPACE_ROOT, 'firebase.json') },
    },
  });
  const config = readFirebaseConfig(values.config);
  if (command === 'check') {
    const violations = policyViolations(readFileSync(values.html, 'utf8'), parsePolicy(hostingPolicy(config)));
    if (violations.length)
      throw new Error(`${values.html} breaks the Hosting CSP (firebase.json):\n- ${violations.join('\n- ')}`);
    console.log(`${values.html}: every inline script is allowed by the Hosting CSP.`);
  } else if (command === 'emulator-config') {
    writeFileSync(values.out, `${JSON.stringify(emulatorConfig(config), null, 2)}\n`);
    console.log(`Wrote ${values.out} (the Hosting CSP plus ${EMULATOR_SOURCE}).`);
  } else {
    throw new Error('Usage: materia-scripts csp <check [--html file] | emulator-config [--out file]>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
