import { COMMON_OPTIONS, accounts, call, callMany, openMatters, pick, signIn, uuid } from './lib/emulator.js';
import { contentionScenario, peakScenario } from './lib/peak.js';

/**
 * `billing-issueInvoice` at 10× peak, then 5 a second for the invoice counter (one transaction per
 * org). Each iteration saves a pre-bill on one of the lawyer's open matters (its unbilled time,
 * plus a fixed-fee line so there is always something to bill) and issues it: the issue is what
 * contends. Every amount is in integer cents and every name is fictional.
 */
export const options = {
  ...COMMON_OPTIONS,
  scenarios: {
    peak10x: peakScenario('issueInvoice'),
    contention: contentionScenario(),
  },
  thresholds: {
    'http_req_duration{name:billing-issueInvoice,step:peak10x}': ['p(95)<1000'],
    'http_req_duration{name:billing-saveDraft,step:peak10x}': ['p(95)<1000'],
    'checks{step:peak10x}': ['rate==1'],
    'checks{step:contention}': ['rate==1'],
  },
};

const LAWYERS = 10;

const draft = (matterId) => ({
  requestId: uuid(),
  matterId,
  fields: {
    extraLines: [
      { kind: 'fixed_fee', description: 'Fixed fee: estate administration stage', amountExGstCents: 55_000 },
    ],
  },
});

export function setup() {
  const lawyers = accounts('lawyer', LAWYERS).map((a) => ({
    uid: a.uid,
    token: signIn(a.email),
    matters: openMatters(a.uid, 100),
  }));
  const usable = lawyers.filter((l) => l.matters.length);
  if (!usable.length) throw new Error('No open matters: seed the large practice first (materia-scripts seed-large)');
  const first = usable[0];
  for (const saved of callMany('billing-saveDraft', () => draft(pick(first.matters)), first.token, 3)) {
    if (saved.ok)
      call('billing-issueInvoice', { requestId: uuid(), invoiceId: saved.result.invoiceId }, first.token, {
        step: 'warmup',
      });
  }
  return { lawyers: usable };
}

export default function ({ lawyers }) {
  const lawyer = pick(lawyers);
  const saved = call('billing-saveDraft', draft(pick(lawyer.matters)), lawyer.token);
  if (!saved.ok) return;
  call('billing-issueInvoice', { requestId: uuid(), invoiceId: saved.result.invoiceId }, lawyer.token);
}
