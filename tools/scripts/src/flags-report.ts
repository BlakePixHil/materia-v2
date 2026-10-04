import * as domainModule from '@materia/domain';

import { unwrap } from './seed/interop.ts';

/** Days a flag may stay fully on before it should be deleted (FND-23). */
export const STALE_AFTER_DAYS = 90;

export interface FlagReport {
  problems: string[];
  stale: { key: string; owner: string; fullyOnSince: string }[];
  lines: string[];
}

/** Builds the report: registry problems fail CI; stale flags are reported as warnings. */
export function buildFlagReport(today: string, domain = unwrap(domainModule)): FlagReport {
  const problems = domain.flagRegistryProblems();
  const stale = domain.staleFlags(today, STALE_AFTER_DAYS).map((flag) => ({
    key: flag.key,
    owner: flag.owner,
    fullyOnSince: flag.fullyOnSince ?? '',
  }));
  const rows = Object.values(domain.FLAGS).map((flag) =>
    `  ${flag.key.padEnd(32)} ${String(flag.default).padEnd(6)} ${flag.serverEnforced ? 'server' : 'client'}  ${flag.owner.padEnd(8)} ${flag.fullyOnSince ? `fully on since ${flag.fullyOnSince}` : ''}`.trimEnd(),
  );
  return {
    problems,
    stale,
    lines: [`Feature flags (${rows.length}):`, ...rows],
  };
}

/**
 * `materia-scripts flags-report` (FND-23, runs in CI): checks every flag has an owner ticket and a
 * valid key, and reports flags fully on for more than 90 days so they get removed.
 */
export async function main(argv: string[] = []): Promise<void> {
  const today =
    argv.find((arg) => arg.startsWith('--today='))?.slice('--today='.length) ?? new Date().toISOString().slice(0, 10);
  const report = buildFlagReport(today);
  console.log(report.lines.join('\n'));
  for (const flag of report.stale) {
    // A GitHub annotation in CI; plain text locally.
    console.log(
      `::warning title=Stale feature flag::${flag.key} has been fully on since ${flag.fullyOnSince} (over ${STALE_AFTER_DAYS} days). ${flag.owner}: delete it and its dead branch.`,
    );
  }
  if (report.stale.length === 0) console.log(`No flags fully on for more than ${STALE_AFTER_DAYS} days.`);
  if (report.problems.length) {
    throw new Error(`Feature flag registry problems:\n${report.problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}
