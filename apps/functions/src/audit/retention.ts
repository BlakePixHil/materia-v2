import type { Firestore } from 'firebase-admin/firestore';

/** Audit entries are kept this long unless the org says otherwise (Security doc: retention). */
export const DEFAULT_RETENTION_YEARS = 7;
const CACHE_MS = 10 * 60 * 1000;

const cache = new Map<string, { years: number; at: number }>();

/** The org's `retentionYears`, cached per instance for ten minutes. */
export async function retentionYears(db: Firestore, orgId: string, now: number): Promise<number> {
  const hit = cache.get(orgId);
  if (hit && now - hit.at < CACHE_MS) return hit.years;
  const value = (await db.doc(`orgs/${orgId}`).get()).get('retentionYears') as unknown;
  const years = typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : DEFAULT_RETENTION_YEARS;
  cache.set(orgId, { years, at: now });
  return years;
}

/** For tests. */
export function clearRetentionCache(): void {
  cache.clear();
}
