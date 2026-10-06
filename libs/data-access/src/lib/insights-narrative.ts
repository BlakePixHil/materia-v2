import { INSIGHTS_NARRATIVE_CALLABLES, type ExplainInsightsInput, type ExplainInsightsResult } from '@materia/domain';

import type { CallableClient } from './callable-client';

/** `clerk-explainInsights` (INS-04): Clerk's explanation of an Insights selection. */
export interface InsightsNarrativeCallables {
  /**
   * `cached` returns the kept explanation of the selection, or null; `explain` writes one when none
   * is kept; `refresh` writes a new one once the kept one is 10 minutes old. Explaining and
   * refreshing are idempotent, so a retry never asks Clerk twice.
   */
  explain(input: Omit<ExplainInsightsInput, 'requestId'>): Promise<ExplainInsightsResult>;
}

export function insightsNarrativeCallables(client: Pick<CallableClient, 'call'>): InsightsNarrativeCallables {
  return {
    explain: (input) =>
      client.call<Omit<ExplainInsightsInput, 'requestId'>, ExplainInsightsResult>(
        INSIGHTS_NARRATIVE_CALLABLES.explain,
        input,
        { idempotent: input.mode !== 'cached' },
      ),
  };
}
