import { COMMON_OPTIONS, accounts, call, callMany, openMatters, pick, signIn } from './lib/emulator.js';
import { peakScenario } from './lib/peak.js';

/**
 * `deadlines-recompute` at 10× peak on the large practice's open matters: each reads the matter,
 * its events and deadlines, runs the rule set and writes what changed (nothing, once settled).
 */
export const options = {
  ...COMMON_OPTIONS,
  scenarios: { peak10x: peakScenario('recompute') },
  thresholds: {
    'http_req_duration{name:deadlines-recompute,step:peak10x}': ['p(95)<1000'],
    'checks{step:peak10x}': ['rate==1'],
  },
};

const LAWYERS = 10;

export function setup() {
  const lawyers = accounts('lawyer', LAWYERS)
    .map((a) => ({ token: signIn(a.email), matters: openMatters(a.uid, 100) }))
    .filter((l) => l.matters.length);
  const first = lawyers[0];
  callMany('deadlines-recompute', () => ({ matterId: pick(first.matters) }), first.token, 3);
  return { lawyers };
}

export default function ({ lawyers }) {
  const lawyer = pick(lawyers);
  call('deadlines-recompute', { matterId: pick(lawyer.matters) }, lawyer.token);
}
