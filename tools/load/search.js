import { check } from 'k6';
import http from 'k6/http';

import { COMMON_OPTIONS, ORG, accounts, pick, queryRequest, signIn, structuredQuery, where } from './lib/emulator.js';
import { peakScenario } from './lib/peak.js';

/**
 * The command palette's search (CORE-15) at 10× peak: for each search, the four queries the web
 * app runs at once (matters, contacts, my tasks and documents holding the typed token, 20 each),
 * straight to Firestore with the member's ID token, so the rules apply. The emulator answers by
 * scanning (it has no indexes), so its latency grows with the data; production reads the indexes.
 */
export const options = {
  ...COMMON_OPTIONS,
  scenarios: { peak10x: peakScenario('search') },
  thresholds: {
    'http_req_duration{name:runQuery,step:peak10x}': ['p(95)<1000'],
    'checks{step:peak10x}': ['rate==1'],
  },
};

const MEMBERS = 20;
/** Prefixes of the large practice's fictional names and words in its titles. */
const TOKENS = ['quill', 'ferns', 'ash', 'thistle', 'marrow', 'penny', 'lock', 'bram', 'wex', 'oak', 'est', 'will'];

export function setup() {
  return { people: accounts('lawyer', MEMBERS).map((a) => ({ uid: a.uid, token: signIn(a.email) })) };
}

export default function ({ people }) {
  const person = pick(people);
  const token = pick(TOKENS);
  const step = { step: 'peak10x' };
  const group = { group: true };
  const responses = http.batch([
    queryRequest(
      `orgs/${ORG}`,
      structuredQuery('matters', [where('deletedAt', '==', null), where('search', 'array-contains', token)], {
        orderBy: 'lastActivityAt',
      }),
      person.token,
      { ...step, query: 'matters' },
    ),
    queryRequest(
      `orgs/${ORG}`,
      structuredQuery('contacts', [where('search', 'array-contains', token)], { orderBy: 'updatedAt' }),
      person.token,
      { ...step, query: 'contacts' },
    ),
    queryRequest(
      '',
      structuredQuery(
        'tasks',
        [where('orgId', '==', ORG), where('assigneeUid', '==', person.uid), where('search', 'array-contains', token)],
        { ...group, orderBy: 'updatedAt' },
      ),
      person.token,
      { ...step, query: 'tasks' },
    ),
    queryRequest(
      '',
      structuredQuery('documents', [where('orgId', '==', ORG), where('search', 'array-contains', token)], {
        ...group,
        orderBy: 'updatedAt',
      }),
      person.token,
      { ...step, query: 'documents' },
    ),
  ]);
  for (const res of responses) check(res, { 'search query answered': (r) => r.status === 200 });
}
