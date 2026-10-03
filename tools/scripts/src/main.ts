/** `materia-scripts <command> [options]`: dispatches to the ops scripts in this package. */
const COMMANDS = {
  'clerk-bench': 'Clerk provider latency benchmark (AI-01)',
  env: 'Write apps/web environment files from Terraform outputs (FND-03)',
  'bundle-size': 'Check the apps/web gzip bundle budgets (FND-04)',
  'ci-summary': 'Render the coverage and bundle PR comment (FND-04)',
  'sync-design': 'Sync design tokens, component CSS and fonts into libs/ui (FND-07)',
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
      env: () => import('./env.ts'),
      'bundle-size': () => import('./bundle-size.ts'),
      'ci-summary': () => import('./ci-summary.ts'),
      'sync-design': () => import('./sync-design.ts'),
    } satisfies Record<Command, () => Promise<{ main: (argv: string[]) => Promise<void> }>>;
    const { main } = await modules[command]();
    await main(rest);
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}
