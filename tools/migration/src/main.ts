/**
 * `materia-migrate <step>`: the legacy materia to v2 migration CLI (Legacy migration plan).
 * Each step is a placeholder until its ticket lands. Nothing here ever writes to the legacy project.
 */
const STEPS = {
  export: 'MIG-02: read-only export of the legacy user data',
  transform: 'MIG-03: pure legacy to v2 mapping',
  load: 'MIG-06: idempotent load into a v2 org',
  verify: 'MIG-06: verification suite',
  rollback: 'MIG-06: one-command rollback',
} as const;

type Step = keyof typeof STEPS;

export function usage(): string {
  const lines = Object.entries(STEPS).map(([name, summary]) => `  ${name.padEnd(11)}${summary}`);
  return ['Usage: materia-migrate <step> [options]', '', 'Steps:', ...lines].join('\n');
}

function isStep(value: string | undefined): value is Step {
  return value !== undefined && Object.hasOwn(STEPS, value);
}

export async function run(argv: string[]): Promise<number> {
  const [step] = argv;
  if (!isStep(step)) {
    console.log(usage());
    return step === undefined || step === '--help' ? 0 : 1;
  }
  console.error(`"${step}" is not implemented yet (${STEPS[step]}).`);
  return 2;
}
