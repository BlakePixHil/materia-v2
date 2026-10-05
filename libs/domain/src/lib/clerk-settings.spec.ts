import {
  CLERK_DISCLOSURE_VERSION,
  clerkAcknowledged,
  clerkMeteringPeriod,
  clerkUsageFromMetrics,
  formatUsdCents,
  microsToCents,
  orgClerkFeatureOn,
  OrgClerkSettingsSchema,
  suggestionAcceptance,
  UpdateClerkSettingsInput,
} from './clerk-settings';

describe('Clerk settings (AI-13)', () => {
  it('needs the current disclosure version acknowledged', () => {
    expect(clerkAcknowledged(undefined)).toBe(false);
    expect(clerkAcknowledged({})).toBe(false);
    expect(clerkAcknowledged({ ackVersion: CLERK_DISCLOSURE_VERSION })).toBe(true);
    expect(clerkAcknowledged({ ackVersion: CLERK_DISCLOSURE_VERSION - 1 })).toBe(false);
  });

  it('treats a feature as on unless it is turned off', () => {
    expect(orgClerkFeatureOn(undefined, 'chat')).toBe(true);
    expect(orgClerkFeatureOn({ features: { chat: true } }, 'chat')).toBe(true);
    expect(orgClerkFeatureOn({ features: { chat: false } }, 'chat')).toBe(false);
  });

  it('validates the stored settings and the callable input', () => {
    expect(OrgClerkSettingsSchema.safeParse({ monthlyBudgetCents: -1 }).success).toBe(false);
    expect(OrgClerkSettingsSchema.safeParse({ features: { teleport: false } }).success).toBe(false);
    const requestId = '6f1c1d2e-1b2c-4d5e-8f90-0a1b2c3d4e5f';
    expect(UpdateClerkSettingsInput.safeParse({ requestId, monthlyBudgetCents: null }).success).toBe(true);
    expect(UpdateClerkSettingsInput.safeParse({ requestId, perUserDailyRequests: 0 }).success).toBe(false);
    expect(UpdateClerkSettingsInput.safeParse({ requestId, model: 'claude-opus-5-5' }).success).toBe(false);
  });

  it('reads a month of metering by feature and by person, costliest first', () => {
    const usage = clerkUsageFromMetrics({
      calls: 5,
      tokens: 9000,
      costMicros: 1_234_567,
      'feature.chat.calls': 3,
      'feature.chat.costMicros': 1_000_000,
      'feature.suggestions.calls': 2,
      'feature.suggestions.costMicros': 234_567,
      'user.u-1.calls': 5,
      'user.u-1.tokens': 9000,
      'user.u-1.costMicros': 1_234_567,
      'suggestions.accepted': 6,
      'suggestions.edited': 2,
      'suggestions.dismissed': 1,
      'suggestions.expired': 1,
      'suggestions.kind.task.accepted': 6,
    });
    expect(usage.byFeature.map((row) => row.key)).toEqual(['chat', 'suggestions']);
    expect(usage.byUser).toEqual([{ key: 'u-1', calls: 5, tokens: 9000, costMicros: 1_234_567 }]);
    expect(suggestionAcceptance(usage.suggestions)).toBe(0.8);
    expect(suggestionAcceptance(clerkUsageFromMetrics(undefined).suggestions)).toBeNull();
    expect(microsToCents(1_234_567)).toBe(124);
    expect(formatUsdCents(123_456)).toBe('US$1,234.56');
  });

  it('names the metering month in Melbourne', () => {
    // 3 pm UTC on 31 October is 2 am on 1 November in Melbourne.
    expect(clerkMeteringPeriod(new Date('2026-10-31T15:00:00Z'))).toBe('clerk-2026-11');
  });
});
