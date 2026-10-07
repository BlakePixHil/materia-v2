import { COMMON_OPTIONS, accounts, call, callMany, openMatters, pick, signIn, uuid } from './lib/emulator.js';
import { MENTIONS_PER_NOTE, peakScenario } from './lib/peak.js';

/**
 * The notification fan-out at 10× peak: `notes-create` with a note mentioning ten colleagues,
 * which writes a `mention` notification for each in its transaction and queues their email and
 * push deliveries (`notifications-deliver`, through the Cloud Tasks emulator; mail and push are the
 * fakes). The callable's latency is the fan-out the author waits for; deliveries follow.
 */
export const options = {
  ...COMMON_OPTIONS,
  scenarios: { peak10x: peakScenario('mentionNotes') },
  thresholds: {
    'http_req_duration{name:notes-create,step:peak10x}': ['p(95)<1000'],
    'checks{step:peak10x}': ['rate==1'],
  },
};

const LAWYERS = 10;
/** Everyone the notes mention: lawyers and paralegals (all of whom can open a matter's notes). */
const MENTIONABLE = [...accounts('lawyer', 25), ...accounts('paralegal', 17)].map((a) => a.uid);

function note(author, matterId) {
  const others = MENTIONABLE.filter((uid) => uid !== author);
  const mentioned = new Set();
  while (mentioned.size < MENTIONS_PER_NOTE) mentioned.add(pick(others));
  const tokens = [...mentioned].map((uid) => `@[${uid}]`).join(' ');
  return {
    requestId: uuid(),
    matterId,
    bodyMd: `Team update on the estate accounts. ${tokens} please check your tasks before Friday.`,
    pinned: false,
    privileged: false,
  };
}

export function setup() {
  const lawyers = accounts('lawyer', LAWYERS)
    .map((a) => ({ uid: a.uid, token: signIn(a.email), matters: openMatters(a.uid, 50) }))
    .filter((l) => l.matters.length);
  const first = lawyers[0];
  callMany('notes-create', () => note(first.uid, pick(first.matters)), first.token, 3);
  return { lawyers };
}

export default function ({ lawyers }) {
  const lawyer = pick(lawyers);
  call('notes-create', note(lawyer.uid, pick(lawyer.matters)), lawyer.token);
}
