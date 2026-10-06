/**
 * Writes made by the legacy migration's load (MIG-06, D-20). The load stamps every document it
 * writes with `migration {runId, legacyPath, loadedAt}`, a new `loadedAt` on every load, so a
 * trigger tells its writes apart from the person's: a write that set `migration`, or changed its
 * run or `loadedAt`. Such writes skip notifications, activity, ingestion and per-document audit
 * entries (the run records one); the denormalising triggers (counts, search, claims, metrics)
 * still run. A person's later edit of a migrated document leaves `migration` alone, so it is an
 * ordinary write.
 */

type Data = Record<string, unknown>;

interface MigrationMeta {
  runId?: unknown;
  loadedAt?: unknown;
}

const metaOf = (data: Data | undefined) => data?.['migration'] as MigrationMeta | undefined;

const millis = (value: unknown): number | undefined => {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: () => number } | undefined)?.toMillis;
  return typeof toMillis === 'function' ? toMillis.call(value) : undefined;
};

/** The run a document was loaded by, if it was. */
export function migrationRunOf(data: Data | undefined): string | undefined {
  const runId = metaOf(data)?.runId;
  return typeof runId === 'string' && runId ? runId : undefined;
}

/** Whether this write is the migration's load (a create or re-load), rather than a person's edit. */
export function isMigrationWrite(before: Data | undefined, after: Data | undefined): boolean {
  const runId = migrationRunOf(after);
  if (!runId) return false;
  const previous = metaOf(before);
  if (!previous) return true;
  return previous.runId !== runId || millis(previous.loadedAt) !== millis(metaOf(after)?.loadedAt);
}
