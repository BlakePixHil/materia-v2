import type { Firestore } from 'firebase-admin/firestore';

import { DomainError, type MigrationEnrichmentPause } from '@materia/domain';

import { DEFAULT_MONTHLY_TOKEN_BUDGET, meteringPeriod } from '../clerk/features';
import { firestoreClerkStore } from '../clerk/firestore-store';
import { BYOK_MISSING_SWITCH, type ClerkGateway, type ClerkRunInput } from '../clerk/gateway';
import { IngestInterrupted } from '../documents/ingest/pipeline';

/**
 * The enrichment's spend (MIG-09, D-21). It has its own allowance, approved with the estimate, and
 * the org's monthly Clerk limits (AI-13) still apply on top: it stops once the month's token budget
 * or spend limit is `ORG_BUDGET_SHARE` used, leaving the rest for people.
 */

/** The share of the org's monthly Clerk budget the enrichment may take the month to. */
export const ORG_BUDGET_SHARE = 0.8;

/** Switches that turn Clerk off for the whole org, and the one key dates can't do without. */
const PAUSING_SWITCHES = new Set([
  'clerk.enabled',
  'org.settings.clerk.enabled',
  'org.settings.clerk.acknowledgement',
  BYOK_MISSING_SWITCH,
  'clerk.features.suggestions',
  'org.settings.clerk.features.suggestions',
]);

/** Why a run must stop here (null: an ordinary failure). Another feature switched off (OCR, classification) doesn't stop it. */
export function pauseReason(error: unknown): MigrationEnrichmentPause | null {
  if (error instanceof IngestInterrupted) return error.reason as MigrationEnrichmentPause;
  if (!(error instanceof DomainError)) return null;
  if (error.code === 'CLERK_BUDGET_EXCEEDED') return 'budget';
  if (error.code === 'CLERK_KEY_INVALID') return 'clerk_off';
  if (error.code === 'CLERK_DISABLED' && PAUSING_SWITCHES.has(String(error.details?.['switch'] ?? ''))) return 'clerk_off';
  return null;
}

export type MeteredGateway = ClerkGateway & { spentMicros(): number };

/**
 * The gateway, counting what each call cost. A call past the allowance isn't made; a call that
 * finds Clerk off or the org's budget used ends the run's step (`IngestInterrupted`, which ingestion
 * passes through and keeps its checkpoint for). One call can take the spend past the allowance.
 */
export function meteredGateway(gateway: ClerkGateway, start: { spentMicros: number; allowanceMicros: number }): MeteredGateway {
  let spent = start.spentMicros;
  async function run<TOutput>(input: ClerkRunInput<TOutput>) {
    if (spent >= start.allowanceMicros) throw new IngestInterrupted('allowance');
    try {
      const result = await gateway.run(input);
      spent += result.costMicros;
      return result;
    } catch (error) {
      const reason = pauseReason(error);
      if (reason) throw error instanceof IngestInterrupted ? error : new IngestInterrupted(reason);
      throw error;
    }
  }
  return { ...gateway, run, spentMicros: () => spent };
}

/** Whether the org's month is `ORG_BUDGET_SHARE` used (tokens, or spend when it has a limit). */
export async function orgBudgetNearlyUsed(db: Firestore, orgId: string, at: Date): Promise<boolean> {
  const store = firestoreClerkStore(db);
  const [settings, used] = await Promise.all([store.orgSettings(orgId), store.periodUsage(orgId, meteringPeriod(at))]);
  if (used.tokens >= (settings.monthlyTokenBudget ?? DEFAULT_MONTHLY_TOKEN_BUDGET) * ORG_BUDGET_SHARE) return true;
  return settings.monthlyBudgetCents !== undefined && used.costMicros >= settings.monthlyBudgetCents * 10_000 * ORG_BUDGET_SHARE;
}
