/** `materia-scripts <command> [options]`: dispatches to the ops scripts in this package. */
const COMMANDS = {
  'clerk-bench': 'Clerk provider latency benchmark (AI-01)',
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
    const { main } = await import('./clerk-bench.ts');
    await main(rest);
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}
