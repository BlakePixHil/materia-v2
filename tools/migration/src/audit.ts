import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { assertReadOnly, NotReadOnlyError } from './audit/iam.ts';
import { renderAuditMarkdown } from './audit/markdown.ts';
import { auditSnapshot, type AuditReport } from './audit/report.ts';
import { collectSnapshot, type LegacyReader } from './legacy/reader.ts';
import { restIamTester, restReader, type IamTester, type RestDeps } from './legacy/rest.ts';
import { checkProfileCoverage, loadProfile, type MappingProfile } from './profile.ts';

/**
 * `materia-migrate audit` (MIG-01): profiles one user's legacy data read-only and writes
 * `audit-report.json` and `audit-report.md`. It checks with IAM that its credentials can't write
 * before it reads anything, and refuses otherwise. The report holds counts and shapes only, but it
 * is still about a real person's data: it goes to `dist/` (gitignored) or the project files, never
 * into the repo.
 */

export const LEGACY_PROJECT = 'matt-r-1fe15';
export const LEGACY_BUCKET = 'matt-r-1fe15.firebasestorage.app';
export const LEGACY_READER = `legacy-migration-reader@${LEGACY_PROJECT}.iam.gserviceaccount.com`;
export const DEFAULT_OUT = 'dist/migration/audit';

export interface AuditArgs {
  uid: string;
  out: string;
  project: string;
  bucket: string;
  profile?: MappingProfile;
}

export interface AuditDeps {
  reader: LegacyReader;
  iam: IamTester;
  write: (path: string, content: string) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
}

export async function runAudit(args: AuditArgs, deps: AuditDeps): Promise<AuditReport> {
  // Before any read: refuse credentials that could write.
  const readOnly = await assertReadOnly(deps.iam);
  deps.log(`Read-only check passed: ${readOnly.granted.join(', ')}.`);
  const { authUser, ...withoutAuth } = deps.reader;
  const reader: LegacyReader = readOnly.authReadable && authUser ? { ...withoutAuth, authUser } : withoutAuth;
  const snapshot = await collectSnapshot(reader, args.uid);
  const report = auditSnapshot(snapshot, {
    generatedAt: deps.now().toISOString(),
    source: { project: args.project, bucket: args.bucket },
    readOnly,
    ...(args.profile ? { profile: args.profile } : {}),
  });
  await deps.write(join(args.out, 'audit-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await deps.write(join(args.out, 'audit-report.md'), renderAuditMarkdown(report));
  deps.log(
    `Wrote ${join(args.out, 'audit-report.json')} and audit-report.md: ${report.counts.cards.total} cards in ` +
      `${report.counts.workflows.inScope} workflows, ${report.warnings.length} kinds of warning.`,
  );
  return report;
}

// ---------- credentials ----------

/**
 * An access token for the legacy project: `MIGRATION_ACCESS_TOKEN` if set (CI with workload
 * identity), Application Default Credentials with `--adc`, else a short-lived token for the
 * read-only account through `gcloud --impersonate-service-account`. Tokens stay in memory.
 */
export function tokenSource(
  { adc, impersonate }: { adc: boolean; impersonate: string },
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string> {
  const fixed = env['MIGRATION_ACCESS_TOKEN'];
  if (fixed) return async () => fixed;
  let cached: { token: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    let token: string;
    if (adc) {
      const { applicationDefault } = await import('firebase-admin/app');
      token = (await applicationDefault().getAccessToken()).access_token;
    } else {
      const { stdout } = await promisify(execFile)('gcloud', [
        'auth',
        'print-access-token',
        `--impersonate-service-account=${impersonate}`,
      ]);
      token = stdout.trim();
    }
    cached = { token, until: Date.now() + 45 * 60 * 1000 };
    return token;
  };
}

// ---------- commands ----------

const AUDIT_USAGE = `Usage: materia-migrate audit (--uid <legacyUid> | --profile <profile.json>) [options]

Profiles one user's legacy data read-only and writes audit-report.json and audit-report.md.

  --uid <uid>            The legacy uid to audit (or take it from --profile)
  --profile <path>       A mapping profile: scope comes from it, and its coverage is checked
  --out <dir>            Where to write the report (default ${DEFAULT_OUT})
  --project <id>         Legacy project (default ${LEGACY_PROJECT})
  --bucket <name>        Legacy bucket (default ${LEGACY_BUCKET})
  --impersonate <email>  Read-only account to impersonate through gcloud (default ${LEGACY_READER})
  --adc                  Use Application Default Credentials instead of impersonation

MIGRATION_ACCESS_TOKEN, when set, is used as the token. Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.`;

export async function auditCommand(argv: string[], log = console.log, error = console.error): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      uid: { type: 'string' },
      profile: { type: 'string' },
      out: { type: 'string', default: DEFAULT_OUT },
      project: { type: 'string', default: LEGACY_PROJECT },
      bucket: { type: 'string', default: LEGACY_BUCKET },
      impersonate: { type: 'string', default: LEGACY_READER },
      adc: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    log(AUDIT_USAGE);
    return 0;
  }
  const profile = values.profile ? await loadProfile(values.profile) : undefined;
  const uid = values.uid ?? profile?.subject.legacyUid;
  if (!uid) {
    error(AUDIT_USAGE);
    return 1;
  }
  const project = { project: values.project, bucket: values.bucket };
  const rest: RestDeps = { fetch, token: tokenSource({ adc: values.adc, impersonate: values.impersonate }) };
  try {
    await runAudit(
      { uid, out: values.out, ...project, ...(profile ? { profile } : {}) },
      {
        reader: restReader(rest, project),
        iam: restIamTester(rest, project),
        write: async (path, content) => {
          await mkdir(join(path, '..'), { recursive: true });
          await writeFile(path, content);
        },
        now: () => new Date(),
        log,
      },
    );
    return 0;
  } catch (err) {
    if (err instanceof NotReadOnlyError) {
      error(err.message);
      return 3;
    }
    throw err;
  }
}

const CHECK_USAGE = `Usage: materia-migrate check-profile --profile <profile.json> [--report <audit-report.json>]

Validates a mapping profile, and with --report checks it maps every workflow and swimlane the audit found.`;

export async function checkProfileCommand(argv: string[], log = console.log, error = console.error): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { profile: { type: 'string' }, report: { type: 'string' }, help: { type: 'boolean', default: false } },
  });
  if (values.help || !values.profile) {
    (values.help ? log : error)(CHECK_USAGE);
    return values.help ? 0 : 1;
  }
  let profile: MappingProfile;
  try {
    profile = await loadProfile(values.profile);
  } catch (err) {
    error(`${values.profile} is not a valid mapping profile: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!values.report) {
    log(`${values.profile} is a valid mapping profile (${profile.workflows.length} workflows).`);
    return 0;
  }
  const report = JSON.parse(await readFile(values.report, 'utf8')) as AuditReport;
  const coverage = checkProfileCoverage(profile, report.workflows);
  if (coverage.ok) {
    log(`${values.profile} maps every workflow and swimlane in ${values.report}.`);
    return 0;
  }
  error(
    [
      `${values.profile} does not match ${values.report}:`,
      ...coverage.unmappedWorkflows.map((w) => `  no mapping for workflow "${w}"`),
      ...coverage.unknownWorkflows.map((w) => `  mapping matches no workflow: "${w}"`),
      ...coverage.unmappedSwimlanes.map((s) => `  no mapping for swimlane "${s.workflow}" › "${s.swimlane}"`),
      ...coverage.unknownSwimlanes.map((s) => `  mapping matches no swimlane: "${s.workflow}" › "${s.swimlane}"`),
    ].join('\n'),
  );
  return 1;
}
