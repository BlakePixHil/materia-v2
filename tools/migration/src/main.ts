import { auditCommand, checkProfileCommand } from './audit.ts';
import { authImportCommand } from './auth-import.ts';

/**
 * `materia-migrate <step>`: the legacy materia to v2 migration CLI (Legacy migration plan).
 * Steps without a command are placeholders until their ticket lands. Nothing here ever writes to
 * the legacy project.
 */
const STEPS = {
  audit: 'MIG-01: read-only profile of the legacy user data (audit-report.json and .md)',
  'check-profile': "MIG-01: validate a mapping profile against the audit's workflows and swimlanes",
  export: 'MIG-02: read-only export of the legacy user data',
  transform: 'MIG-03: pure legacy to v2 mapping',
  'auth-import': 'MIG-04: move one legacy Auth account into v2 with the same uid',
  load: 'MIG-06: idempotent load into a v2 org',
  verify: 'MIG-06: verification suite',
  rollback: 'MIG-06: one-command rollback',
} as const;

type Step = keyof typeof STEPS;

const COMMANDS: Partial<Record<Step, (argv: string[]) => Promise<number>>> = {
  audit: (argv) => auditCommand(argv),
  'check-profile': (argv) => checkProfileCommand(argv),
  'auth-import': (argv) => authImportCommand(argv),
};

export function usage(): string {
  const lines = Object.entries(STEPS).map(([name, summary]) => `  ${name.padEnd(15)}${summary}`);
  return ['Usage: materia-migrate <step> [options]', '', 'Steps:', ...lines].join('\n');
}

function isStep(value: string | undefined): value is Step {
  return value !== undefined && Object.hasOwn(STEPS, value);
}

export async function run(argv: string[]): Promise<number> {
  const [step, ...rest] = argv;
  if (!isStep(step)) {
    console.log(usage());
    return step === undefined || step === '--help' ? 0 : 1;
  }
  const command = COMMANDS[step];
  if (command) return command(rest);
  console.error(`"${step}" is not implemented yet (${STEPS[step]}).`);
  return 2;
}
