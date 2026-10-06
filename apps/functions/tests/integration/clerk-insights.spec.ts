import { randomUUID } from 'node:crypto';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  CLERK_DISCLOSURE_VERSION,
  comparisonPeriod,
  insightsPeriod,
  narrativeKey,
  today,
  type ExplainInsightsResult,
  type Role,
} from '@materia/domain';

import { explainInsightsDefinition, insightsNarrativesPath } from '../../src/clerk/insights';
import { anthropicKeyPath } from '../../src/clerk/keyring';
import { FakeClerkModel } from '../../src/clerk/providers/fake';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { cachedMemberLookup } from '../../src/core/members';
import { FakeKms, fakePorts } from '../../src/ports/fakes';

/**
 * INS-04 against the Firestore emulator and the fake model: `clerk-explainInsights` explains last
 * month against the month before from the INS-01 month documents (with a shard added in), keeps the
 * explanation for the selection and returns it from the cache, and never sends the model a client,
 * matter or referrer. The callable runs in this process. Fictional data only.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-clerk-insights';
const CANARY = 'Quillfeather';
const kms = new FakeKms();
const model = new FakeClerkModel();

let admin: App;
let db: Firestore;

const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};
const uidOf = (role: Role) => `ins4-${role}`;
const day = () => today('Australia/Melbourne', new Date());
const current = () => insightsPeriod({ range: 'last_month' }, day(), 7);
const previous = () => comparisonPeriod(current(), 'previous', day());

function explain(mode: 'cached' | 'explain' | 'refresh', role: Role = 'lawyer') {
  const clock = { now: () => new Date() };
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts({ clerkModel: model, clerkKms: kms }),
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  return runCallable(
    explainInsightsDefinition as unknown as CallableDefinition<never, ExplainInsightsResult>,
    {
      data: { requestId: randomUUID(), range: 'last_month', compare: 'previous', mode },
      auth: { uid: uidOf(role), token: { orgId: ORG, role } },
    },
    deps,
  );
}

beforeAll(async () => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'clerk-insights-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Quillfeather Legal',
    timezone: 'Australia/Melbourne',
    fy: { startMonth: 7 },
    flags: { 'clerk.enabled': true, 'clerk.features.insightsNarrative': true },
    settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION } },
  });
  const sealed = await kms.encrypt('sk-ant-fictional-insights-integration-0000', anthropicKeyPath(ORG));
  await db.doc(anthropicKeyPath(ORG)).set({
    provider: 'anthropic',
    uid: null,
    status: 'valid',
    scopes: [],
    encryptedApiKey: sealed.ciphertext,
    kmsKeyVersion: sealed.keyVersion,
    last4: '0000',
  });
  for (const role of ['lawyer', 'readonly'] as const)
    await db
      .doc(`orgs/${ORG}/members/${uidOf(role)}`)
      .set({ role, status: 'active', displayName: `Fictional ${role}` });
  // A client and matter whose names must never reach the model.
  await db
    .doc(`orgs/${ORG}/contacts/c-quill`)
    .set({ kind: 'person', givenNames: 'Rowan', familyName: CANARY, ...meta });
  await db.doc(`orgs/${ORG}/matters/m-quill`).set({
    number: 'M-2026-0777',
    title: `Estate of Fictional ${CANARY}`,
    type: 'probate',
    status: 'open',
    privileged: false,
    deletedAt: null,
    clientContactIds: ['c-quill'],
    ...meta,
  });
  const [last] = current().months as [string];
  const [before] = previous()?.months as [string];
  await db.doc(`orgs/${ORG}/metrics/month-${last}`).set({
    period: `month-${last}`,
    values: {
      'billing.invoicedCents': 2_400_000,
      'matters.opened': 5,
      'matters.opened.referrer.c-quill': 1,
      'referrals.referrer.c-quill.billedCents': 300_000,
    },
  });
  await db.doc(`orgs/${ORG}/metrics/month-${last}/shards/3`).set({ values: { 'billing.invoicedCents': 60_000 } });
  await db.doc(`orgs/${ORG}/metrics/month-${before}`).set({
    period: `month-${before}`,
    values: { 'billing.invoicedCents': 2_000_000, 'matters.opened': 4 },
  });
});

afterAll(async () => {
  clearFlagCaches();
  await deleteAdminApp(admin);
});

describe('Clerk Insights narratives (INS-04)', () => {
  it('explains last month from the month documents, keeps it, and sends the model no names', async () => {
    expect(await explain('cached')).toEqual({ narrative: null });

    const { narrative } = await explain('explain');
    expect(narrative).toMatchObject({
      periodLabel: current().label,
      comparisonLabel: previous()?.label,
      insufficientData: false,
      stale: false,
    });
    // The shard is added in: $24,000 + $600.
    expect(narrative?.paragraphs[0]?.citations).toEqual([
      { metric: 'billing.invoicedCents', period: 'current', label: 'Billed, excluding GST', value: '$24,600' },
    ]);

    const request = JSON.stringify(model.requests.at(-1));
    for (const leak of [CANARY, 'c-quill', 'M-2026-0777', 'Rowan']) expect(request).not.toContain(leak);

    const kept = await db.doc(`${insightsNarrativesPath(ORG)}/${narrativeKey(current(), previous())}`).get();
    expect(kept.data()).toMatchObject({ paragraphs: narrative?.paragraphs, generatedBy: uidOf('lawyer') });

    // Read back through Firestore (a Timestamp), the kept one is what the cache returns.
    const calls = model.requests.length;
    expect((await explain('cached')).narrative).toEqual(narrative);
    expect((await explain('refresh')).narrative).toEqual(narrative);
    expect(model.requests).toHaveLength(calls);
  });

  it('is not for read-only members', async () => {
    await expect(explain('cached', 'readonly')).rejects.toMatchObject({ details: { code: 'PERMISSION_DENIED' } });
  });
});
