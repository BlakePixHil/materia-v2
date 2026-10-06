import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import {
  CLERK_DISCLOSURE_VERSION,
  INSIGHTS_NARRATIVE_PROMPT,
  type ExplainInsightsResult,
  type Role,
} from '@materia/domain';

import { explainInsightsDefinition, insightsNarrativesPath } from './insights';
import { anthropicKeyPath } from './keyring';
import { FakeClerkModel, type FakeStep } from './providers/fake';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeKms, fakePorts } from '../ports/fakes';

/** Unit tests for `clerk-explainInsights` (INS-04) against the fake model. Every name is fictional. */

type Data = Record<string, unknown>;

const ORG = 'org-insights-narrative';
const NOW = new Date('2026-10-05T00:00:00.000Z'); // 11:00 on 5 October in Melbourne
const FLAGS = { 'clerk.enabled': true, 'clerk.features.insightsNarrative': true };
const CANARY = 'Wexcombe';
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const M = `orgs/${ORG}/metrics`;
/** Last month (September) against the month before: the selection most tests make. */
const LAST_MONTH = { range: 'last_month', compare: 'previous' } as const;
const KEY = '2026-09_2026-09__2026-08_2026-08';

/** September and August's figures, with a shard (ADR-048) and a referrer key the narrative scope leaves out. */
const METRICS: Record<string, Data> = {
  [`${M}/month-2026-09`]: {
    period: 'month-2026-09',
    values: {
      'billing.invoicedCents': 1_200_000,
      'billing.collectedCents': 900_000,
      'matters.opened': 4,
      'matters.opened.referrer.c-wexcombe': 1,
      'referrals.referrer.c-wexcombe.billedCents': 250_000,
    },
  },
  [`${M}/month-2026-09/shards/0`]: { values: { 'billing.invoicedCents': 100_000 } },
  [`${M}/month-2026-08`]: {
    period: 'month-2026-08',
    values: { 'billing.invoicedCents': 1_000_000, 'billing.collectedCents': 1_000_000, 'matters.opened': 2 },
  },
};

async function world(options: { script?: FakeStep[]; flags?: Data; settings?: Data; metrics?: boolean } = {}) {
  const kms = new FakeKms();
  const sealed = await kms.encrypt('sk-ant-fictional-insights-unit-test-0000', anthropicKeyPath(ORG));
  const initial: Record<string, Data> = {
    [`orgs/${ORG}`]: {
      name: 'Fictional Wexcombe Legal',
      timezone: 'Australia/Melbourne',
      fy: { startMonth: 7 },
      flags: options.flags ?? FLAGS,
      settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION, ...options.settings } },
    },
    [anthropicKeyPath(ORG)]: {
      provider: 'anthropic',
      uid: null,
      status: 'valid',
      scopes: [],
      encryptedApiKey: sealed.ciphertext,
      kmsKeyVersion: sealed.keyVersion,
      last4: '0000',
    },
    // A matter and a client whose names must never reach the model.
    [`orgs/${ORG}/contacts/c-wexcombe`]: { ...meta, kind: 'person', givenNames: 'Avery', familyName: CANARY },
    [`orgs/${ORG}/matters/m-wexcombe`]: {
      ...meta,
      number: 'M-2026-0310',
      title: `Estate of Fictional ${CANARY}`,
      type: 'probate',
      status: 'open',
      privileged: false,
      deletedAt: null,
      clientContactIds: ['c-wexcombe'],
    },
    ...(options.metrics === false ? {} : METRICS),
  };
  for (const role of ['lawyer', 'paralegal', 'readonly'] as const)
    initial[`orgs/${ORG}/members/u-${role}`] = { ...meta, role, status: 'active', displayName: `Fictional ${role}` };
  clearFlagCaches();
  const store = memoryFirestore(initial);
  const clock = new FakeClock(NOW);
  const model = new FakeClerkModel(options.script ?? []);
  const ports = fakePorts({ clerkModel: model, clerkKms: kms, clock });
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const explain = (data: Data = {}, role: Role = 'lawyer') =>
    runCallable(
      explainInsightsDefinition as unknown as CallableDefinition<never, ExplainInsightsResult>,
      {
        data: { requestId: randomUUID(), ...LAST_MONTH, ...data },
        auth: { uid: `u-${role}`, token: { orgId: ORG, role } },
      },
      deps(),
    );
  const kept = (key = KEY) => store.docs.get(`${insightsNarrativesPath(ORG)}/${key}`);
  return { store, clock, model, explain, kept };
}

async function failure(promise: Promise<unknown>): Promise<HttpsError & { details: Data }> {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError & { details: Data };
  }
  throw new Error('expected the call to fail');
}

/** The `<org_metrics>` block of the model's nth request. */
const metricsOf = (n: number, model: FakeClerkModel) =>
  ((model.requests[n]?.messages[0]?.content ?? []) as { text?: string }[])[0]?.text ?? '';

/** A narrative the model "wrote", as structured output. */
const wrote = (paragraphs: { text: string; citations: Data[] }[], insufficientData = false): FakeStep => ({
  chunks: [JSON.stringify({ paragraphs, insufficientData })],
});

beforeEach(() => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
});

describe('clerk-explainInsights (INS-04)', () => {
  it('explains the two periods from their figures only, keeps it, and shows each number with its source', async () => {
    const w = await world();
    const { narrative, problem } = await w.explain();

    expect(problem).toBeUndefined();
    expect(narrative).toMatchObject({
      periodLabel: 'September 2026',
      comparisonLabel: 'August 2026',
      insufficientData: false,
      omitted: 0,
      stale: false,
      generatedAt: NOW.toISOString(),
      refreshAfter: '2026-10-05T00:10:00.000Z',
      expiresAt: '2026-10-06T00:00:00.000Z',
      promptRef: INSIGHTS_NARRATIVE_PROMPT,
    });
    // The fake model writes the first two figures' current values; the shard is added in.
    expect(narrative?.paragraphs[0]).toEqual({
      text: 'Billed, excluding GST: $13,000 in September 2026 (fake Clerk model).',
      citations: [
        { metric: 'billing.invoicedCents', period: 'current', label: 'Billed, excluding GST', value: '$13,000' },
      ],
    });
    expect(narrative?.paragraphs).toHaveLength(2);

    // One call, at low effort, with the two periods' figures and nothing else.
    expect(w.model.requests).toHaveLength(1);
    expect(w.model.requests[0]?.effort).toBe('low');
    const request = JSON.stringify(w.model.requests[0]);
    expect(metricsOf(0, w.model)).toContain('"change":"+$3,000","changePct":"+30%"');
    expect(request).toContain('Explain what changed in the practice');
    for (const leak of [CANARY, 'c-wexcombe', 'M-2026-0310', 'Avery']) expect(request).not.toContain(leak);

    // Kept for the selection, with only the checked paragraphs and how they were written.
    expect(w.kept()).toMatchObject({
      periodLabel: 'September 2026',
      paragraphs: narrative?.paragraphs,
      promptRef: INSIGHTS_NARRATIVE_PROMPT,
      months: { current: ['2026-09'], comparison: ['2026-08'] },
      generatedBy: 'u-lawyer',
      schemaVersion: 1,
    });
  });

  it('returns the kept explanation for 24 hours, refreshes it only after 10 minutes, and says when the figures moved', async () => {
    const w = await world();
    expect(await w.explain({ mode: 'cached' })).toEqual({ narrative: null });
    expect(w.model.requests).toHaveLength(0);

    const first = (await w.explain()).narrative;
    w.clock.advance(5 * 60_000);
    expect((await w.explain({ mode: 'cached' })).narrative).toEqual(first);
    expect((await w.explain()).narrative).toEqual(first);
    // Too soon to refresh: the kept one comes back and the model isn't asked again.
    expect((await w.explain({ mode: 'refresh' })).narrative).toEqual(first);
    expect(w.model.requests).toHaveLength(1);

    // New time recorded since: still kept, but marked stale.
    w.store.docs.set(`${M}/month-2026-09/shards/1`, { values: { 'billing.invoicedCents': 50_000 } });
    expect((await w.explain({ mode: 'cached' })).narrative).toMatchObject({
      stale: true,
      generatedAt: NOW.toISOString(),
    });

    w.clock.advance(6 * 60_000);
    const refreshed = (await w.explain({ mode: 'refresh' })).narrative;
    expect(w.model.requests).toHaveLength(2);
    expect(refreshed).toMatchObject({ stale: false, generatedAt: '2026-10-05T00:11:00.000Z' });
    expect(refreshed?.paragraphs[0]?.citations[0]?.value).toBe('$13,500');

    // A day after it was written it is no longer kept.
    w.clock.advance(24 * 3_600_000);
    expect(await w.explain({ mode: 'cached' })).toEqual({ narrative: null });
  });

  it('keeps one explanation per period and comparison', async () => {
    const w = await world();
    await w.explain();
    await w.explain({ compare: 'none' });
    await w.explain({ range: 'custom', from: '2026-08', to: '2026-09', compare: 'last_year' });
    expect(w.model.requests).toHaveLength(3);
    expect(w.kept('2026-09_2026-09__none')).toMatchObject({ comparisonLabel: null });
    expect(w.kept('2026-08_2026-09__2025-08_2025-09')).toBeDefined();
    expect(metricsOf(1, w.model)).toContain('"comparison":null');
  });

  it('leaves out a paragraph whose numbers don’t match what it cites, and keeps nothing when none pass', async () => {
    const billed = { metric: 'billing.invoicedCents', period: 'current' };
    const collected = { metric: 'billing.collectedCents', period: 'current' };
    const w = await world({
      script: [
        wrote([
          { text: 'Billing reached $13,000 in September 2026.', citations: [billed] },
          { text: 'Collections were $8,000.', citations: [collected] },
        ]),
      ],
    });
    const { narrative } = await w.explain();
    expect(narrative?.paragraphs.map((p) => p.text)).toEqual(['Billing reached $13,000 in September 2026.']);
    expect(narrative?.omitted).toBe(1);
    expect(w.kept()).toMatchObject({ omitted: 1 });

    const none = await world({
      script: [wrote([{ text: 'Collections fell by 12% because of the holidays.', citations: [collected] }])],
    });
    expect(await none.explain()).toEqual({ narrative: null, problem: 'unverified' });
    expect(none.kept()).toBeUndefined();
  });

  it('keeps the first 4 paragraphs of a longer answer', async () => {
    const billed = { metric: 'billing.invoicedCents', period: 'current' };
    const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
    const w = await world({
      script: [wrote(words.map((word) => ({ text: `${word}: billing reached $13,000.`, citations: [billed] })))],
    });
    const { narrative } = await w.explain();
    expect(narrative?.paragraphs.map((p) => p.text.split(':')[0])).toEqual(['One', 'Two', 'Three', 'Four']);
    expect(narrative?.omitted).toBe(0);
  });

  it('reports an explanation the model didn’t finish without keeping it, and keeps showing the earlier one', async () => {
    const refusal: FakeStep = { chunks: ['I can’t help with that request.'], stopReason: 'refusal' };
    const w = await world({ script: [refusal] });
    expect(await w.explain()).toEqual({ narrative: null, problem: 'failed' });
    expect(w.kept()).toBeUndefined();

    const first = (await w.explain()).narrative;
    w.clock.advance(11 * 60_000);
    w.model.push(refusal);
    expect(await w.explain({ mode: 'refresh' })).toEqual({ narrative: first, problem: 'failed' });
  });

  it('says there is nothing to explain, without asking Clerk, when nothing was recorded in either period', async () => {
    const w = await world({ metrics: false });
    const { narrative } = await w.explain();
    expect(narrative).toMatchObject({ insufficientData: true, paragraphs: [], periodLabel: 'September 2026' });
    expect(w.model.requests).toHaveLength(0);
    expect(w.kept()).toBeUndefined();
  });

  it('keeps the model’s word that the figures are too few', async () => {
    const w = await world({
      script: [
        wrote([{ text: 'Only September 2026 has figures, so there is nothing to compare.', citations: [] }], true),
      ],
    });
    const { narrative } = await w.explain();
    expect(narrative).toMatchObject({ insufficientData: true });
    expect(narrative?.paragraphs).toHaveLength(1);
  });

  it('is off, kept explanations included, when Clerk, the feature or the org’s toggle is off, and for read-only members', async () => {
    const off = await world({ flags: { 'clerk.enabled': true } });
    off.store.docs.set(`${insightsNarrativesPath(ORG)}/${KEY}`, { generatedAt: NOW, paragraphs: [] });
    expect((await failure(off.explain({ mode: 'cached' }))).details).toMatchObject({
      code: 'CLERK_DISABLED',
      switch: 'clerk.features.insightsNarrative',
    });
    const toggled = await world({ settings: { features: { insightsNarrative: false } } });
    expect((await failure(toggled.explain())).details).toMatchObject({
      code: 'CLERK_DISABLED',
      switch: 'org.settings.clerk.features.insightsNarrative',
    });
    const unacknowledged = await world({ settings: { ackVersion: null } });
    expect((await failure(unacknowledged.explain())).details).toMatchObject({
      switch: 'org.settings.clerk.acknowledgement',
    });
    const w = await world();
    expect((await failure(w.explain({}, 'readonly'))).details['code']).toBe('PERMISSION_DENIED');
    expect((await w.explain({}, 'paralegal')).narrative?.paragraphs).toHaveLength(2);
    expect(w.model.requests).toHaveLength(1);
  });

  it('rejects a custom range without its months', async () => {
    const w = await world();
    expect((await failure(w.explain({ range: 'custom', from: '2026-09-01' }))).details['code']).toBe(
      'INVALID_ARGUMENT',
    );
  });
});
