/** `materia-scripts <command> [options]`: dispatches to the ops scripts in this package. */
const COMMANDS = {
  'clerk-bench': 'Clerk provider latency benchmark (AI-01)',
  'clerk-prompts': 'Compile the Clerk prompt registry (libs/clerk/prompts) for Functions (AI-02)',
  'legal-docs': 'Compile the legal documents (docs/compliance) for the /legal pages (SEC-01; --check)',
  env: 'Write apps/web environment files from Terraform outputs (FND-03)',
  'bundle-size': 'Check the apps/web gzip bundle budgets (FND-04)',
  csp: 'Check the built index.html against the Hosting CSP; write the e2e emulator config (FND-22)',
  'ci-summary': 'Render the coverage and bundle PR comment (FND-04)',
  'sync-design': 'Sync design tokens, component CSS and fonts into libs/ui (FND-07)',
  'rules-sync': 'Sync the Firestore rules role lists and field whitelists from libs/domain (FND-14)',
  stamp: 'Stamp the web and functions builds with the release version and SHA (FND-05)',
  seed: 'Wipe the emulators and seed the fictional practice (FND-06)',
  dev: 'Run the emulators, seed and web app together: pnpm dev (FND-06)',
  'fixture-pdfs': 'Regenerate the fictional fixture PDFs in libs/test-utils (FND-06)',
  'make-fixtures': 'Render the Clerk eval fixture PDFs, typed and scanned (AI-12; --check)',
  'flags-report': 'Check the feature flag registry and report stale flags (FND-23)',
  'remote-config': 'Report every flag in Remote Config; --apply a flags file to dev (FND-23a)',
  'platform-admin': 'Grant or revoke the platformAdmin claim (FND-23; humans only)',
  'backfill-search-tokens': 'Rewrite search tokens and stamp recent entries (CORE-15; idempotent)',
  'backfill-ingest': 'Have Clerk ingest documents from before AI-04 or that failed, and report ingest status (AI-04)',
  'backfill-metrics': 'Restate the practice metrics rollups from an FY start, from the records (INS-01; idempotent)',
  'backfill-matter-roles':
    'Give every contact its roles in live matters for the contacts filter (CORE-01a; idempotent)',
  'backfill-deadline-privilege': 'Copy each matter’s privileged flag to its events, deadlines and proposals (CORE-10b)',
  'search-load': 'Time the ⌘K search against the emulator with 5,000 matters (CORE-15)',
  'decode-stack': 'Deobfuscate a web stack trace with the private sourcemaps (FND-21)',
  'restore-matter': 'Restore one matter from a PITR time or a restored database (SEC-03; dry run unless --apply)',
  'backup-drill': 'Restore a backup or export into a scratch database and verify the counts (SEC-03; dev)',
  'backup-status': 'List recent backups, exports, the files copy and the export job logs (SEC-03; read-only)',
  'dependabot-automerge': 'Merge Dependabot’s dev-patch group once ci passes (SEC-02; run by its workflow)',
  'demo-reset':
    'Load (or reset) the demo practice and its accounts on dev or the emulators (--dry-run, --verify, --remove)',
  'demo-lighthouse':
    'Mobile Lighthouse on a page of dev, signed in to the demo practice (MOB-02b; --path, --runs, --url)',
} as const;

type Command = keyof typeof COMMANDS;

export function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, summary]) => `  ${name.padEnd(14)}${summary}`);
  return ['Usage: materia-scripts <command> [options]', '', 'Commands:', ...lines].join('\n');
}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!isCommand(command)) {
    console.log(usage());
    return command === undefined || command === '--help' ? 0 : 1;
  }
  try {
    const modules = {
      'clerk-bench': () => import('./clerk-bench.ts'),
      'clerk-prompts': () => import('./clerk-prompts.ts'),
      'legal-docs': () => import('./legal-docs.ts'),
      env: () => import('./env.ts'),
      'bundle-size': () => import('./bundle-size.ts'),
      csp: () => import('./csp.ts'),
      'ci-summary': () => import('./ci-summary.ts'),
      'sync-design': () => import('./sync-design.ts'),
      'rules-sync': () => import('./rules-sync.ts'),
      stamp: () => import('./stamp.ts'),
      seed: () => import('./seed.ts'),
      dev: () => import('./dev.ts'),
      'fixture-pdfs': () => import('./seed/pdfs.ts'),
      'make-fixtures': () => import('./make-fixtures.ts'),
      'flags-report': () => import('./flags-report.ts'),
      'remote-config': () => import('./remote-config.ts'),
      'platform-admin': () => import('./platform-admin.ts'),
      'backfill-search-tokens': () => import('./backfills/search-tokens.ts'),
      'backfill-ingest': () => import('./backfills/ingest.ts'),
      'backfill-metrics': () => import('./backfills/metrics.ts'),
      'backfill-matter-roles': () => import('./backfills/matter-roles.ts'),
      'backfill-deadline-privilege': () => import('./backfills/deadline-privilege.ts'),
      'search-load': () => import('./search-load.ts'),
      'decode-stack': () => import('./decode-stack.ts'),
      'restore-matter': () => import('./backups/restore-matter.ts'),
      'backup-drill': () => import('./backups/drill.ts'),
      'backup-status': () => import('./backups/status.ts'),
      'dependabot-automerge': () => import('./dependabot-automerge.ts'),
      'demo-reset': () => import('./demo-reset.ts'),
      'demo-lighthouse': () => import('./demo-lighthouse.ts'),
    } satisfies Record<Command, () => Promise<{ main: (argv: string[]) => Promise<void> }>>;
    const { main } = await modules[command]();
    await main(rest);
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}
