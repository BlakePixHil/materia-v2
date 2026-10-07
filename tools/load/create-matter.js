import { COMMON_OPTIONS, accounts, call, callMany, pick, signIn, uuid } from './lib/emulator.js';
import { WITH_CONTENTION, contentionScenario, peakScenario } from './lib/peak.js';

/**
 * `matters-createMatter` at 10× peak, then 5 a second for the year's matter counter (one
 * transaction per org). Each matter is a probate intake with a client and the deceased from the
 * large practice's contacts, as the New matter form sends it. Every name is fictional.
 */
export const options = {
  ...COMMON_OPTIONS,
  scenarios: {
    peak10x: peakScenario('createMatter'),
    ...(WITH_CONTENTION ? { contention: contentionScenario() } : {}),
  },
  thresholds: {
    'http_req_duration{name:matters-createMatter,step:peak10x}': ['p(95)<1000'],
    'checks{step:peak10x}': ['rate==1'],
    ...(WITH_CONTENTION ? { 'checks{step:contention}': ['rate==1'] } : {}),
  },
};

const LAWYERS = 10;
/** Contacts the seed writes at scale 0.05 and above (`c-lg-000001`…). */
const CONTACTS = 700;

const contact = () => `c-lg-${String(1 + Math.floor(Math.random() * CONTACTS)).padStart(6, '0')}`;

function newMatter(uid) {
  const client = contact();
  let deceased = contact();
  while (deceased === client) deceased = contact();
  return {
    requestId: uuid(),
    matter: {
      title: `Estate of Fictional Load ${Math.floor(Math.random() * 1e6)}`,
      type: 'probate',
      jurisdiction: 'VIC',
      responsibleUid: uid,
      teamUids: [],
      clientContactIds: [client],
      deceased: { contactId: deceased, dateOfDeath: '2026-05-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
      fee: { arrangement: 'hourly' },
      costsDisclosure: { status: 'required' },
      conflictCheck: { status: 'clear' },
    },
  };
}

export function setup() {
  const lawyers = accounts('lawyer', LAWYERS).map((a) => ({ uid: a.uid, token: signIn(a.email) }));
  // Start a few workers before measuring: the emulator loads the functions bundle per worker.
  callMany('matters-createMatter', () => newMatter(lawyers[0].uid), lawyers[0].token, 5);
  return { lawyers };
}

export default function ({ lawyers }) {
  const lawyer = pick(lawyers);
  call('matters-createMatter', newMatter(lawyer.uid), lawyer.token);
}
