/** `materia-scripts <command> [options]`: dispatches to the ops scripts in this package. */
const COMMANDS = {
  'clerk-bench': 'Clerk provider latency benchmark (AI-01)',
  'clerk-prompts': 'Compile the Clerk prompt registry (libs/clerk/prompts) for Functions (AI-02)',
  env: 'Write apps/web environment files from Terraform outputs (FND-03)',
  'bundle-size': 'Check the apps/web gzip bundle budgets (FND-04)',
  'ci-summary': 'Render the coverage and bundle PR comment (FND-04)',
  'sync-design': 'Sync design tokens, component CSS and fonts into libs/ui (FND-07)',
  'rules-sync': 'Sync the Firestore rules role lists and field whitelists from libs/domain (FND-14)',
  stamp: 'Stamp the web and functions builds with the release version and SHA (FND-05)',
  seed: 'Wipe the emulators and seed the fictional practice (FND-06)',
  dev: 'Run the emulators, seed and web app together: pnpm dev (FND-06)',
  'fixture-pdfs': 'Regenerate the fictional fixture PDFs in libs/test-utils (FND-06)',
  'flags-report': 'Check the feature flag registry and report stale flags (FND-23)',
  'platform-admin': 'Grant or revoke the platformAdmin claim (FND-23; humans only)',
  'decode-stack': 'Deobfuscate a web stack trace with the private sourcemaps (FND-21)',
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
      env: () => import('./env.ts'),
      'bundle-size': () => import('./bundle-size.ts'),
      'ci-summary': () => import('./ci-summary.ts'),
      'sync-design': () => import('./sync-design.ts'),
      'rules-sync': () => import('./rules-sync.ts'),
      stamp: () => import('./stamp.ts'),
      seed: () => import('./seed.ts'),
      dev: () => import('./dev.ts'),
      'fixture-pdfs': () => import('./seed/pdfs.ts'),
      'flags-report': () => import('./flags-report.ts'),
      'platform-admin': () => import('./platform-admin.ts'),
      'decode-stack': () => import('./decode-stack.ts'),
    } satisfies Record<Command, () => Promise<{ main: (argv: string[]) => Promise<void> }>>;
    const { main } = await modules[command]();
    await main(rest);
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}
