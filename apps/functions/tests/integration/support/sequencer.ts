import { basename } from 'node:path';

import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * Splits the integration files into shards of about the same running time.
 *
 * Vitest's own `--shard` gives each shard the same number of files, picked by a hash of their
 * paths, and these files take from 1 s to two minutes. With four shards that way, shard 2 took 356 s
 * of its 360 s limit and shard 3 took 223 s (a local run on 4 CPUs, 2026-10-07), and that was before
 * migration-enrichment.spec hashed into shard 2 as well.
 *
 * Each shard works out the same plan from the same files: longest first, each to the shard with
 * the least time so far. The times are the mean of two local runs, one in four shards and one in
 * five. A file's time includes the triggers it leaves queued, which the next file's drain waits for
 * (see drain-triggers.ts): clerk-context's tests take 3 s, then its task fixtures keep the emulator
 * busy for well over a minute. A file not listed counts as an average file. When a shard's Duration
 * drifts well away from the others, update the times from vitest's output
 * (`✓ … tests/integration/<file>.spec.ts (N tests) <ms>ms`, and the `Waited` lines after it).
 */
const SECONDS: Record<string, number> = {
  audit: 37,
  auth: 11,
  clerk: 25,
  'clerk-chat': 16,
  'clerk-context': 88,
  'clerk-drafts': 8,
  'clerk-insights': 6,
  'clerk-matter-brief': 8,
  'client-errors': 3,
  conflicts: 32,
  connector: 10,
  contacts: 100,
  'costs-disclosure': 6,
  'csv-exports': 9,
  'data-rights': 25,
  deadlines: 35,
  disbursements: 28,
  'doc-templates': 5,
  documents: 38,
  echo: 9,
  estate: 12,
  exports: 2,
  fees: 28,
  flags: 6,
  ingest: 11,
  intake: 21,
  invoices: 90,
  'matter-detail': 27,
  matters: 87,
  metrics: 15,
  'migration-enrichment': 13,
  'migration-review': 9,
  notes: 23,
  notifications: 23,
  'org-settings': 21,
  orgs: 35,
  payments: 30,
  reminders: 8,
  retention: 23,
  'safe-custody': 17,
  search: 15,
  suggestions: 62,
  tasks: 61,
  templates: 56,
  time: 47,
  timer: 15,
  trust: 11,
};
const UNLISTED_SECONDS = 30;

export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const seconds = (file: TestSpecification) => SECONDS[basename(file.moduleId, '.spec.ts')] ?? UNLISTED_SECONDS;
    const shards = Array.from({ length: shard.count }, () => ({ seconds: 0, files: [] as TestSpecification[] }));
    const longestFirst = [...files].sort(
      (a, b) => seconds(b) - seconds(a) || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0),
    );
    for (const file of longestFirst) {
      const least = shards.reduce((min, next) => (next.seconds < min.seconds ? next : min));
      least.seconds += seconds(file);
      least.files.push(file);
    }
    const mine = shards[shard.index - 1];
    if (!mine) throw new Error(`There is no shard ${shard.index} of ${shard.count}`);
    process.stdout.write(
      `Shard ${shard.index}/${shard.count}: ${mine.files.length} files, about ${mine.seconds} s by their recorded times\n`,
    );
    return mine.files;
  }
}
