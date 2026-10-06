import * as z from 'zod';

import { ClerkModelChoiceSchema } from './clerk';
import { CLERK_DISCLOSURE_VERSION } from './clerk-disclosure.generated';
import { InstantSchema } from './schemas/common';

/**
 * Clerk settings and admin controls (AI-13): the org's switches, per-feature toggles, spend and
 * request limits, and its acknowledgement of the data-use disclosure. They live on
 * `orgs/{orgId}.settings.clerk`, change only through `clerk-updateSettings` (owners and admins,
 * audited), and the gateway (AI-02) enforces them on every call.
 */

export { CLERK_DISCLOSURE_VERSION, CLERK_DISCLOSURES } from './clerk-disclosure.generated';

/**
 * The features an org can turn off one by one. `chronology`, `ordersExtract`, `insightsNarrative`
 * and `voice` aren't built yet: their tickets add a row to ORG_CLERK_FEATURES (and a gateway
 * feature that names them) when they land.
 */
export const ORG_CLERK_FEATURE_KEYS = [
  'chat',
  'brief',
  'suggestions',
  'classification',
  'willExtract',
  'drafting',
  'timeAssist',
  'chronology',
  'ordersExtract',
  'insightsNarrative',
  'voice',
] as const;
export const OrgClerkFeatureSchema = z.enum(ORG_CLERK_FEATURE_KEYS);
export type OrgClerkFeature = z.infer<typeof OrgClerkFeatureSchema>;

export interface OrgClerkFeatureInfo {
  key: OrgClerkFeature;
  label: string;
  description: string;
}

/** The toggles Settings → Clerk and AI shows, in order: the features that exist today. */
export const ORG_CLERK_FEATURES: readonly OrgClerkFeatureInfo[] = [
  {
    key: 'chat',
    label: 'Ask Clerk',
    description: 'Questions about a matter or the practice, answered with citations.',
  },
  { key: 'brief', label: 'Morning brief', description: 'A summary of what needs you, on Today.' },
  {
    key: 'suggestions',
    label: 'Suggest tasks and deadlines',
    description: 'From new documents and notes. A person accepts, edits or dismisses each one.',
  },
  {
    key: 'classification',
    label: 'Sort new documents',
    description: 'Suggests a type and title for each document filed to a matter.',
  },
  {
    key: 'willExtract',
    label: 'Read wills',
    description: 'Suggests executors, beneficiaries and gifts from an uploaded will.',
  },
  { key: 'drafting', label: 'Draft documents', description: 'Drafts letters from templates for a person to review.' },
  { key: 'timeAssist', label: 'Capture time', description: 'Drafts time entries from notes and activity for review.' },
];

/** Every limit a person can type, so a typo can't set a budget of millions. */
export const MAX_MONTHLY_BUDGET_CENTS = 100_000_00;
export const MAX_DAILY_REQUESTS = 10_000;

/** `orgs/{orgId}.settings.clerk`. */
export const OrgClerkSettingsSchema = z.object({
  /** The org's own Clerk switch; `false` turns Clerk off for everyone in the org. */
  enabled: z.boolean().optional(),
  /** The model Clerk runs on (AI-02a): Sonnet 5.5 unless an admin opts into Opus 5.5 (`clerk-setModel`). */
  model: ClerkModelChoiceSchema.optional(),
  /** Features turned off for the org (`false`); a feature not listed is on. */
  features: z.partialRecord(OrgClerkFeatureSchema, z.boolean()).optional(),
  /** Monthly spend limit in US cents (Anthropic bills in US dollars); none when unset. */
  monthlyBudgetCents: z.number().int().min(0).max(MAX_MONTHLY_BUDGET_CENTS).optional(),
  /** Requests each person may make a day (Melbourne days); none when unset. */
  perUserDailyRequests: z.number().int().min(1).max(MAX_DAILY_REQUESTS).optional(),
  /** Monthly token budget (all token kinds); the gateway default applies when unset. */
  monthlyTokenBudget: z.number().int().positive().optional(),
  /** Per-user request window; the gateway default (30 per 10 minutes) applies when unset. */
  userRateLimit: z
    .object({ requests: z.number().int().positive(), windowMinutes: z.number().int().positive() })
    .optional(),
  /** Pages per day Clerk may OCR for the org (AI-04); the ingestion default applies when unset. */
  ocrDailyPages: z.number().int().min(0).optional(),
  /** Who acknowledged the data-use disclosure, when, and which version of it. */
  acknowledgedAt: InstantSchema.optional(),
  acknowledgedBy: z.string().optional(),
  ackVersion: z.number().int().min(1).optional(),
});
export type OrgClerkSettings = z.infer<typeof OrgClerkSettingsSchema>;

/** Whether the org has acknowledged the current disclosure (a newer version needs it again). */
export function clerkAcknowledged(settings: Pick<OrgClerkSettings, 'ackVersion'> | undefined): boolean {
  return (settings?.ackVersion ?? 0) >= CLERK_DISCLOSURE_VERSION;
}

/** Whether a feature is on for the org (on unless turned off). */
export function orgClerkFeatureOn(settings: Pick<OrgClerkSettings, 'features'> | undefined, key: OrgClerkFeature) {
  return settings?.features?.[key] !== false;
}

/** `clerk-updateSettings`: only the fields sent change; `null` clears a limit. */
export const UpdateClerkSettingsInput = z
  .object({
    requestId: z.uuid(),
    enabled: z.boolean().optional(),
    features: z.partialRecord(OrgClerkFeatureSchema, z.boolean()).optional(),
    monthlyBudgetCents: z.number().int().min(0).max(MAX_MONTHLY_BUDGET_CENTS).nullable().optional(),
    perUserDailyRequests: z.number().int().min(1).max(MAX_DAILY_REQUESTS).nullable().optional(),
    /** Acknowledges this version of the disclosure; it must be the current one. */
    acknowledgeVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type UpdateClerkSettingsInput = z.infer<typeof UpdateClerkSettingsInput>;

export interface UpdateClerkSettingsResult {
  /** The fields that changed (`features.chat`, `monthlyBudgetCents`, `acknowledgement`). */
  changed: string[];
}

// ---------- usage ----------

/** One bar of the usage dashboard. */
export interface ClerkUsageRow {
  key: string;
  calls: number;
  tokens: number;
  costMicros: number;
}

/** A month of Clerk usage, read from `metrics/clerk-{YYYY-MM}.values` (AI-02 metering, AI-07 outcomes). */
export interface ClerkUsage {
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** US dollars × 1,000,000. */
  costMicros: number;
  /** Calls whose cost used a fallback price (a model missing from the price table). */
  estimatedCostCalls: number;
  byFeature: ClerkUsageRow[];
  byUser: ClerkUsageRow[];
  suggestions: { proposed: number; accepted: number; edited: number; dismissed: number; expired: number };
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Reads a metrics document's `values` map (flat keys like `feature.chat.costMicros`). */
export function clerkUsageFromMetrics(values: Record<string, unknown> | undefined): ClerkUsage {
  const v = values ?? {};
  const rows = (prefix: 'feature' | 'user'): ClerkUsageRow[] => {
    const byKey = new Map<string, ClerkUsageRow>();
    for (const [name, value] of Object.entries(v)) {
      if (!name.startsWith(`${prefix}.`)) continue;
      const metric = name.slice(name.lastIndexOf('.') + 1);
      const key = name.slice(prefix.length + 1, name.lastIndexOf('.'));
      if (!key || !['calls', 'tokens', 'costMicros'].includes(metric)) continue;
      const row = byKey.get(key) ?? { key, calls: 0, tokens: 0, costMicros: 0 };
      row[metric as 'calls' | 'tokens' | 'costMicros'] = num(value);
      byKey.set(key, row);
    }
    return [...byKey.values()].sort((a, b) => b.costMicros - a.costMicros || b.tokens - a.tokens);
  };
  return {
    calls: num(v['calls']),
    tokens: num(v['tokens']),
    inputTokens: num(v['inputTokens']),
    outputTokens: num(v['outputTokens']),
    cacheReadTokens: num(v['cacheReadTokens']),
    cacheWriteTokens: num(v['cacheWriteTokens']),
    costMicros: num(v['costMicros']),
    estimatedCostCalls: num(v['estimatedCostCalls']),
    byFeature: rows('feature'),
    byUser: rows('user'),
    suggestions: {
      proposed: num(v['suggestions.proposed']),
      accepted: num(v['suggestions.accepted']),
      edited: num(v['suggestions.edited']),
      dismissed: num(v['suggestions.dismissed']),
      expired: num(v['suggestions.expired']),
    },
  };
}

/**
 * Accepted (as is or edited) out of those resolved (accepted, edited, dismissed or expired), as
 * AI-07 counts them, or null before any are resolved.
 */
export function suggestionAcceptance(s: ClerkUsage['suggestions']): number | null {
  const resolved = s.accepted + s.edited + s.dismissed + s.expired;
  return resolved ? (s.accepted + s.edited) / resolved : null;
}

/** Micros (US dollars × 1,000,000) to whole US cents, rounded up so a budget is never overshot on paper. */
export function microsToCents(micros: number): number {
  return Math.ceil(micros / 10_000);
}

/** "US$12.34" from US cents. */
export function formatUsdCents(cents: number): string {
  return `US$${(cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `clerk-YYYY-MM` for an instant in Melbourne: the metering document Clerk's usage is in (AI-02). */
export function clerkMeteringPeriod(at: Date, timeZone = 'Australia/Melbourne'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  return `clerk-${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}
