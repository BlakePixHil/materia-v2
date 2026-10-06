import { createHash } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';
import type * as z from 'zod';

import type { InsightsNarrativeOutput } from '@materia/clerk';
import {
  comparisonPeriod,
  DEFAULT_ORG_TIMEZONE,
  ExplainInsightsInputSchema,
  INSIGHTS_NARRATIVE_CALLABLES,
  INSIGHTS_NARRATIVE_PROMPT,
  INSIGHTS_NARRATIVE_REFRESH_MINUTES,
  INSIGHTS_NARRATIVE_TTL_HOURS,
  insightsPeriod,
  instantOf,
  narrativeKey,
  narrativePeriodInfo,
  narrativePromptVars,
  PERMISSIONS,
  today,
  verifiedNarrative,
  type ExplainInsightsResult,
  type InsightsNarrativeView,
  type NarrativeFigure,
  type ShownParagraph,
} from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';
import type { ContextBuilder } from './context/build-context';
import { clerkContext } from './context/service';
import type { ClerkGateway, GatewayContext } from './gateway';
import { clerkGateway } from './service';

type Data = Record<string, unknown>;

/** Where explanations are kept, one per period and comparison (`narrativeKey`). Server-only. */
export const insightsNarrativesPath = (orgId: string) => `orgs/${orgId}/insightsNarratives`;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** A short fingerprint of the figures, so a kept explanation can say the figures have moved since. */
export function figuresHash(figures: readonly NarrativeFigure[]): string {
  return createHash('sha256').update(JSON.stringify(figures)).digest('hex').slice(0, 16);
}

/** What `insightsNarratives/{key}` holds: the checked paragraphs only, and how they were written. */
interface StoredNarrative {
  periodLabel: string;
  comparisonLabel: string | null;
  paragraphs: ShownParagraph[];
  insufficientData: boolean;
  omitted: number;
  figuresHash: string;
  promptRef: string;
  model: string;
  generatedAt: Date;
}

function storedOf(data: Data | undefined): StoredNarrative | null {
  const generatedAt = instantOf(data?.['generatedAt']);
  if (!data || !generatedAt || !Array.isArray(data['paragraphs'])) return null;
  return {
    periodLabel: String(data['periodLabel'] ?? ''),
    comparisonLabel: typeof data['comparisonLabel'] === 'string' ? data['comparisonLabel'] : null,
    paragraphs: data['paragraphs'] as ShownParagraph[],
    insufficientData: data['insufficientData'] === true,
    omitted: typeof data['omitted'] === 'number' ? data['omitted'] : 0,
    figuresHash: String(data['figuresHash'] ?? ''),
    promptRef: String(data['promptRef'] ?? ''),
    model: String(data['model'] ?? ''),
    generatedAt,
  };
}

function viewOf(stored: StoredNarrative, hash: string): InsightsNarrativeView {
  const at = stored.generatedAt.getTime();
  return {
    periodLabel: stored.periodLabel,
    comparisonLabel: stored.comparisonLabel,
    paragraphs: stored.paragraphs,
    insufficientData: stored.insufficientData,
    omitted: stored.omitted,
    generatedAt: stored.generatedAt.toISOString(),
    refreshAfter: new Date(at + INSIGHTS_NARRATIVE_REFRESH_MINUTES * MINUTE_MS).toISOString(),
    expiresAt: new Date(at + INSIGHTS_NARRATIVE_TTL_HOURS * HOUR_MS).toISOString(),
    stale: stored.figuresHash !== hash,
    promptRef: stored.promptRef,
  };
}

export interface ExplainInsightsDeps {
  db: Firestore;
  gateway: Pick<ClerkGateway, 'run' | 'assertOn'>;
  context: ContextBuilder;
}

/**
 * Explains an Insights selection (INS-04, ADR-054). The org's switches come first, so turning
 * Clerk or the feature off hides kept explanations too. The periods are worked out here, on the
 * org's today and FY start, exactly as the screen does; `buildContext` gives Clerk the two periods'
 * figures and nothing else. A kept explanation of the same periods is returned for 24 hours (with
 * `stale` when the figures have moved); a refresh asks again only once it is 10 minutes old. Every
 * paragraph's numbers are checked against the figures it cites, and one that fails is never kept.
 */
export async function explainInsightsFor(
  deps: ExplainInsightsDeps,
  ctx: GatewayContext,
  input: z.output<typeof ExplainInsightsInputSchema>,
): Promise<ExplainInsightsResult> {
  await deps.gateway.assertOn(ctx, 'insightsNarrative');
  const org = (await deps.db.doc(`orgs/${ctx.orgId}`).get()).data() ?? {};
  const timeZone = typeof org['timezone'] === 'string' && org['timezone'] ? org['timezone'] : DEFAULT_ORG_TIMEZONE;
  const startMonth = Number((org['fy'] as Data | undefined)?.['startMonth']);
  const fyStartMonth = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 7;
  const day = today(timeZone, ctx.clock.now());
  const current = insightsPeriod({ range: input.range, from: input.from, to: input.to }, day, fyStartMonth);
  const comparison = comparisonPeriod(current, input.compare, day);

  const context = await deps.context.buildContext({
    ctx,
    scope: {
      org: 'metrics',
      current: narrativePeriodInfo(current),
      comparison: comparison ? narrativePeriodInfo(comparison) : null,
    },
    feature: 'insightsNarrative',
  });
  const figures = context.figures ?? [];
  const hash = figuresHash(figures);
  const ref = deps.db.doc(`${insightsNarrativesPath(ctx.orgId)}/${narrativeKey(current, comparison)}`);
  const kept = storedOf((await ref.get()).data());
  const now = ctx.clock.now();
  const fresh =
    kept && now.getTime() < kept.generatedAt.getTime() + INSIGHTS_NARRATIVE_TTL_HOURS * HOUR_MS ? kept : null;
  if (input.mode === 'cached') return { narrative: fresh ? viewOf(fresh, hash) : null };
  const refreshable =
    fresh && now.getTime() >= fresh.generatedAt.getTime() + INSIGHTS_NARRATIVE_REFRESH_MINUTES * MINUTE_MS;
  if (fresh && (input.mode === 'explain' || !refreshable)) return { narrative: viewOf(fresh, hash) };

  const labels = [current.label, ...(comparison ? [comparison.label] : [])];
  const base = { periodLabel: current.label, comparisonLabel: comparison?.label ?? null, figuresHash: hash };
  // Nothing recorded in either period: nothing to explain, and no call.
  if (!figures.length)
    return {
      narrative: viewOf(
        { ...base, paragraphs: [], insufficientData: true, omitted: 0, promptRef: '', model: '', generatedAt: now },
        hash,
      ),
    };

  const result = await deps.gateway.run<InsightsNarrativeOutput>({
    ctx,
    feature: 'insightsNarrative',
    promptId: INSIGHTS_NARRATIVE_PROMPT,
    vars: narrativePromptVars(current, comparison),
    context,
  });
  const keptView = fresh ? viewOf(fresh, hash) : null;
  if (result.status !== 'done' || !result.parsed) {
    ctx.log.warn('insights narrative not written', { status: result.status, promptRef: result.promptRef });
    return { narrative: keptView, problem: 'failed' };
  }
  const checked = verifiedNarrative(result.parsed.paragraphs, figures, labels);
  // Metadata only: how many paragraphs failed the number check, never their text.
  if (checked.omitted)
    ctx.log.warn('insights narrative paragraphs failed the number check', {
      omitted: checked.omitted,
      paragraphs: result.parsed.paragraphs.length,
      promptRef: result.promptRef,
    });
  if (!checked.paragraphs.length && !result.parsed.insufficientData)
    return { narrative: keptView, problem: 'unverified' };

  const stored: StoredNarrative = {
    ...base,
    paragraphs: checked.paragraphs,
    insufficientData: result.parsed.insufficientData,
    omitted: checked.omitted,
    promptRef: result.promptRef,
    model: result.model,
    generatedAt: now,
  };
  await ref.set({
    ...stored,
    months: { current: current.months, comparison: comparison?.months ?? null },
    generatedBy: ctx.uid,
    createdAt: now,
    createdBy: ctx.uid,
    updatedAt: now,
    updatedBy: ctx.uid,
    schemaVersion: 1,
  });
  return { narrative: viewOf(stored, hash) };
}

/**
 * `clerk-explainInsights` (INS-04): the "Explain" card on Insights. For any role that may use Clerk;
 * the figures are org totals every member already reads on the screen.
 */
export const explainInsightsDefinition = {
  name: INSIGHTS_NARRATIVE_CALLABLES.explain,
  input: ExplainInsightsInputSchema,
  roles: PERMISSIONS['clerk.use'],
  timeoutSeconds: 120,
  handler: ({ input, uid, orgId, role, requestId, log, clock, db, ports }) =>
    explainInsightsFor(
      {
        db,
        gateway: clerkGateway({ db, ports, clock }),
        context: clerkContext({ db, embedding: ports.embedding }),
      },
      { orgId, uid, role, requestId, log, clock },
      input,
    ),
} satisfies CallableDefinition<typeof ExplainInsightsInputSchema, ExplainInsightsResult>;

export const explainInsights = defineCallable(explainInsightsDefinition);
