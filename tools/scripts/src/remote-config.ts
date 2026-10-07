import * as domainModule from '@materia/domain';
import type { FlagDefinition, FlagValue } from '@materia/domain';

import { unwrap } from './seed/interop.ts';

/**
 * `materia-scripts remote-config --project <id> [--apply <file>] [--dry-run]` (FND-23a): what
 * Remote Config holds for every registry flag, and (dev only) publishing flags from a checked-in
 * file. The `remote-config` workflow runs it as terraform-agent, because agent sessions can't hold
 * Google credentials.
 *
 * The report reads the client template (`firebase`, what the web app gets) and the server template
 * (`firebase-server`, what `requireFlag` in Functions gets) and prints each flag's value in both,
 * the registry default, and what the app ends up with. It warns when a server-enforced flag is on
 * in the client but not on the server (the screen shows, the callable refuses), when a parameter
 * has conditional values (they can win over the default value set here), and when a template holds
 * parameters the registry doesn't know. Org overrides (`orgs/{orgId}.flags`) win over both, so it
 * lists them too, by org id only.
 *
 * `--apply` sets the flags listed in the file on BOTH templates (a client-only flag on the server
 * does nothing, and the file stays simpler): read, change, publish with the ETag, so a console edit
 * in between fails the publish instead of being lost. `null` removes a parameter, so the registry
 * default applies. Flags the file doesn't list are left as they are. `--dry-run` validates the
 * change with Remote Config without publishing it. Only {@link WRITABLE_PROJECT} can be written:
 * prod flags wait for practitioner sign-offs and stay a person's change.
 */

const API = 'https://firebaseremoteconfig.googleapis.com/v1';

/** The Remote Config namespaces: `firebase` is the client template, `firebase-server` the server one. */
export const NAMESPACES = { client: 'firebase', server: 'firebase-server' } as const;
export type Side = keyof typeof NAMESPACES;
const SIDES = Object.keys(NAMESPACES) as Side[];

/** The only project `--apply` publishes to. */
export const WRITABLE_PROJECT = 'materia-v2-dev';

/** Remote Config caps parameter descriptions at 256 characters. */
const MAX_DESCRIPTION = 256;

export interface RcValue {
  value?: string;
  useInAppDefault?: boolean;
  [other: string]: unknown;
}

export interface RcParameter {
  defaultValue?: RcValue;
  conditionalValues?: Record<string, RcValue>;
  description?: string;
  valueType?: string;
  [other: string]: unknown;
}

export interface RcTemplate {
  conditions?: unknown[];
  parameters?: Record<string, RcParameter>;
  parameterGroups?: Record<string, { description?: string; parameters?: Record<string, RcParameter> }>;
  version?: Record<string, unknown>;
  /** From the response's ETag header; `*` when the template doesn't exist yet. */
  etag: string;
}

export interface RcDeps {
  fetch: typeof fetch;
  token: () => Promise<string>;
}

async function call(deps: RcDeps, url: string, init: RequestInit = {}): Promise<Response> {
  return deps.fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await deps.token()}`, ...(init.headers as Record<string, string>) },
  });
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(`${what}: HTTP ${response.status} ${body.slice(0, 500)}`);
}

export async function getTemplate(deps: RcDeps, project: string, side: Side): Promise<RcTemplate> {
  const url = `${API}/projects/${project}/namespaces/${NAMESPACES[side]}/remoteConfig`;
  const response = await call(deps, url);
  // A server template nobody has published yet.
  if (response.status === 404) return { etag: '*' };
  if (!response.ok) throw await failure(response, `Reading the ${side} template`);
  const body = (await response.json()) as Omit<RcTemplate, 'etag'>;
  return { ...body, etag: response.headers.get('etag') ?? '*' };
}

export async function publishTemplate(
  deps: RcDeps,
  project: string,
  side: Side,
  template: RcTemplate,
  opts: { validateOnly: boolean },
): Promise<RcTemplate> {
  const url = `${API}/projects/${project}/namespaces/${NAMESPACES[side]}/remoteConfig${opts.validateOnly ? '?validateOnly=true' : ''}`;
  // The version is output only; the ETag goes in If-Match.
  const body: Record<string, unknown> = { ...template };
  delete body['etag'];
  delete body['version'];
  const response = await call(deps, url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json; charset=utf-8', 'if-match': template.etag },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, `Publishing the ${side} template`);
  const published = (await response.json()) as Omit<RcTemplate, 'etag'>;
  return { ...published, etag: response.headers.get('etag') ?? template.etag };
}

/** Every parameter name in a template, top level and grouped. */
function parameterNames(template: RcTemplate): string[] {
  return [
    ...Object.keys(template.parameters ?? {}),
    ...Object.values(template.parameterGroups ?? {}).flatMap((group) => Object.keys(group.parameters ?? {})),
  ];
}

function findParameter(template: RcTemplate, name: string): RcParameter | undefined {
  if (template.parameters?.[name]) return template.parameters[name];
  for (const group of Object.values(template.parameterGroups ?? {})) {
    if (group.parameters?.[name]) return group.parameters[name];
  }
  return undefined;
}

/** The parameter's default value as the SDKs see it: undefined when unset or "use in-app default". */
function rawValue(parameter: RcParameter | undefined): string | undefined {
  const value = parameter?.defaultValue;
  if (!value || value.useInAppDefault || value.value === undefined) return undefined;
  return value.value;
}

/** How the Remote Config SDKs read a value (asBoolean, asNumber, asString). */
export function parseValue(type: 'boolean' | 'number' | 'string', raw: string): FlagValue {
  if (type === 'boolean') return ['1', 'true', 't', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  if (type === 'number') return Number(raw) || 0;
  return raw;
}

export interface FlagRow {
  key: string;
  owner: string;
  serverEnforced: boolean;
  default: FlagValue;
  /** Raw default values in each template; undefined when not set there. */
  client: string | undefined;
  server: string | undefined;
  /** What the web app gets (client template, else the default). */
  web: FlagValue;
  /** What server enforcement gets (server template, else the default); undefined for client-only flags. */
  callable: FlagValue | undefined;
  notes: string[];
}

export interface Report {
  rows: FlagRow[];
  unknown: { side: Side; name: string }[];
  /** Orgs with a non-empty `flags` map; undefined when they couldn't be read. */
  orgOverrides: OrgOverride[] | undefined;
}

export interface OrgOverride {
  orgId: string;
  flags: Record<string, unknown>;
}

export function buildReport(
  templates: Record<Side, RcTemplate>,
  orgOverrides: OrgOverride[] | undefined,
  domain = unwrap(domainModule),
): Report {
  const rows = domain.FLAG_KEYS.map((key): FlagRow => {
    const flag: FlagDefinition = domain.FLAGS[key];
    const name = domain.remoteConfigKey(key);
    const parameters = { client: findParameter(templates.client, name), server: findParameter(templates.server, name) };
    const client = rawValue(parameters.client);
    const server = rawValue(parameters.server);
    const web = client === undefined ? flag.default : parseValue(flag.type, client);
    const serverValue = server === undefined ? flag.default : parseValue(flag.type, server);
    const notes: string[] = [];
    if (flag.serverEnforced && web !== serverValue) {
      notes.push(`⚠️ client ${String(web)} but server ${String(serverValue)}`);
    }
    for (const side of SIDES) {
      const conditions = Object.keys(parameters[side]?.conditionalValues ?? {});
      if (conditions.length) notes.push(`${side} has conditional values (${conditions.join(', ')})`);
    }
    return {
      key: flag.key,
      owner: flag.owner,
      serverEnforced: flag.serverEnforced,
      default: flag.default,
      client,
      server,
      web,
      callable: flag.serverEnforced ? serverValue : undefined,
      notes,
    };
  });
  const known = new Set(domain.FLAG_KEYS.map((key) => domain.remoteConfigKey(key)));
  const unknown = SIDES.flatMap((side) =>
    parameterNames(templates[side])
      .filter((name) => !known.has(name))
      .map((name) => ({ side, name })),
  );
  return { rows, unknown, orgOverrides };
}

const cell = (value: unknown) => (value === undefined ? '—' : String(value).replace(/\|/g, '\\|'));

export function renderReport(project: string, templates: Record<Side, RcTemplate>, report: Report): string {
  const versions = SIDES.map((side) => {
    const version = templates[side].version as { versionNumber?: string; updateTime?: string } | undefined;
    return `${side} template ${version?.versionNumber ? `v${version.versionNumber} (${version.updateTime ?? '?'})` : 'not published yet'}`;
  });
  const on = report.rows.filter((row) => row.web === true && row.callable !== false);
  const booleans = report.rows.filter((row) => typeof row.default === 'boolean');
  const lines = [
    `### Remote Config: ${project}`,
    '',
    `${versions.join('; ')}. ${on.length} of ${booleans.length} on/off flags are on.`,
    '',
    '`—` means not set there, so the registry default applies. **App** is what the web app shows; **Server** is what the callables enforce (server-enforced flags only). Org overrides below win over both.',
    '',
    '| Flag | Owner | Default | Client | Server | App | Server enforced | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map(
      (row) =>
        `| ${[
          `\`${row.key}\``,
          row.owner,
          cell(row.default),
          cell(row.client),
          cell(row.server),
          `**${cell(row.web)}**`,
          row.callable === undefined ? 'client only' : `**${cell(row.callable)}**`,
          row.notes.join('; '),
        ].join(' | ')} |`,
    ),
    '',
  ];
  if (report.unknown.length) {
    lines.push(
      '#### Parameters the registry doesn’t know',
      '',
      ...report.unknown.map((p) => `- ${p.side}: \`${p.name}\` (a typo, or a removed flag to delete)`),
      '',
    );
  }
  lines.push('#### Org overrides (`orgs/{orgId}.flags`)', '');
  if (!report.orgOverrides) {
    lines.push('Not read (see the warning in the log).');
  } else if (report.orgOverrides.length) {
    lines.push(
      ...report.orgOverrides.map(
        (org) =>
          `- \`${org.orgId}\`: ${Object.entries(org.flags)
            .map(([key, value]) => `\`${key}\`=${JSON.stringify(value)}`)
            .join(', ')}`,
      ),
    );
  } else {
    lines.push('None.');
  }
  return [...lines, ''].join('\n');
}

export type DesiredFlags = Record<string, FlagValue | null>;

/** The checked-in file: `{ "flags": { "<flag key>": value | null } }`, registry keys and types only. */
export function parseDesired(json: unknown, domain = unwrap(domainModule)): DesiredFlags {
  const flags = (json as { flags?: unknown } | null)?.flags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new Error('The flags file must be { "flags": { "<flag key>": value or null } }');
  }
  const problems: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (!domain.isFlagKey(key)) problems.push(`${key}: not a flag in the registry (libs/domain flags.ts)`);
    else if (value !== null && !domain.isValidFlagValue(key, value))
      problems.push(`${key}: must be a ${domain.FLAGS[key].type} or null`);
  }
  if (problems.length) throw new Error(`Flags file problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return flags as DesiredFlags;
}

const VALUE_TYPES = { boolean: 'BOOLEAN', number: 'NUMBER', string: 'STRING' } as const;

/**
 * The template with the desired flags set as default values (a grouped parameter stays in its
 * group; conditional values are kept) and the changes made. Pure: the input isn't modified.
 */
export function applyFlags(
  template: RcTemplate,
  desired: DesiredFlags,
  domain = unwrap(domainModule),
): { template: RcTemplate; changes: string[] } {
  const next = structuredClone(template);
  const changes: string[] = [];
  for (const [key, value] of Object.entries(desired)) {
    if (!domain.isFlagKey(key)) continue;
    const flag = domain.FLAGS[key];
    const name = domain.remoteConfigKey(key);
    const group = Object.values(next.parameterGroups ?? {}).find((g) => g.parameters?.[name]);
    const parameters = group?.parameters ?? (next.parameters ??= {});
    const existing = parameters[name];
    const before = rawValue(existing);
    if (value === null) {
      if (existing) {
        const rest = Object.fromEntries(Object.entries(parameters).filter(([other]) => other !== name));
        if (group) group.parameters = rest;
        else next.parameters = rest;
        changes.push(`${name}: removed (was ${before ?? 'in-app default'}; the registry default applies)`);
      }
      continue;
    }
    const raw = String(value);
    const valueType = VALUE_TYPES[flag.type];
    if (before === raw && existing?.valueType === valueType) continue;
    parameters[name] = {
      ...existing,
      defaultValue: { value: raw },
      valueType,
      description: existing?.description ?? flag.description.slice(0, MAX_DESCRIPTION),
    };
    changes.push(`${name}: ${before ?? 'unset'} → ${raw}`);
  }
  return { template: next, changes };
}

export interface Args {
  project: string;
  apply: string | undefined;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const option = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = option('--project');
  const apply = option('--apply');
  if (!project || (argv.includes('--apply') && !apply)) {
    throw new Error('Usage: materia-scripts remote-config --project <id> [--apply <flags.json>] [--dry-run]');
  }
  if (apply && project !== WRITABLE_PROJECT) {
    throw new Error(`--apply only writes ${WRITABLE_PROJECT}; ${project}'s Remote Config is changed by hand.`);
  }
  return { project, apply, dryRun: argv.includes('--dry-run') };
}

export interface RunDeps extends RcDeps {
  readFile: (path: string) => Promise<string>;
  orgOverrides: () => Promise<OrgOverride[] | undefined>;
  log: (line: string) => void;
}

/** Applies the file (when given) to both templates, then reports. Returns the markdown report. */
export async function run(args: Args, deps: RunDeps): Promise<string> {
  const templates = {} as Record<Side, RcTemplate>;
  for (const side of SIDES) templates[side] = await getTemplate(deps, args.project, side);

  if (args.apply) {
    const desired = parseDesired(JSON.parse(await deps.readFile(args.apply)));
    for (const side of SIDES) {
      const { template, changes } = applyFlags(templates[side], desired);
      if (!changes.length) {
        deps.log(`${side} template: already matches ${args.apply}.`);
        continue;
      }
      for (const change of changes) deps.log(`${side} template: ${change}`);
      const published = await publishTemplate(deps, args.project, side, template, { validateOnly: args.dryRun });
      if (args.dryRun) {
        deps.log(`${side} template: dry run, Remote Config validated the change; nothing published.`);
      } else {
        templates[side] = published;
        deps.log(`${side} template: published.`);
      }
    }
  }

  return renderReport(args.project, templates, buildReport(templates, await deps.orgOverrides()));
}

/** Org ids with a non-empty `flags` map. Reads only that field. */
async function readOrgOverrides(project: string): Promise<OrgOverride[]> {
  const { applicationDefault, deleteApp, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp({ projectId: project, credential: applicationDefault() }, `remote-config-${Date.now()}`);
  try {
    const snapshot = await getFirestore(app).collection('orgs').select('flags').get();
    return snapshot.docs
      .map((doc) => ({ orgId: doc.id, flags: (doc.get('flags') as Record<string, unknown> | undefined) ?? {} }))
      .filter((org) => Object.keys(org.flags).length > 0);
  } finally {
    await deleteApp(app);
  }
}

export async function main(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv);
  const { applicationDefault } = await import('firebase-admin/app');
  const { appendFile, readFile } = await import('node:fs/promises');
  const credential = applicationDefault();
  const markdown = await run(args, {
    fetch,
    token: async () => (await credential.getAccessToken()).access_token,
    readFile: (path) => readFile(path, 'utf8'),
    orgOverrides: () =>
      readOrgOverrides(args.project).catch((error: unknown) => {
        console.log(
          `::warning::Couldn't read org overrides: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }),
    log: (line) => console.log(line),
  });
  console.log(markdown);
  if (process.env['GITHUB_STEP_SUMMARY']) await appendFile(process.env['GITHUB_STEP_SUMMARY'], `${markdown}\n`);
}
