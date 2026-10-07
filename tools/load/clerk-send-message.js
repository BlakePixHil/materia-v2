import { COMMON_OPTIONS, accounts, call, callMany, openMatters, pick, signIn, uuid } from './lib/emulator.js';
import { peakScenario } from './lib/peak.js';

/**
 * `clerk-sendMessage` at 10× peak with the fake model (the Functions emulator uses the fakes):
 * each queues an answer on a matter and returns; `clerk-runMessage` writes it through the Cloud
 * Tasks emulator. The setup saves a fictional Anthropic key as the owner (BYOK, ADR-011b), as an
 * owner does in Settings. Questions are fictional and name no one.
 */
export const options = {
  ...COMMON_OPTIONS,
  scenarios: { peak10x: peakScenario('sendMessage') },
  thresholds: {
    'http_req_duration{name:clerk-sendMessage,step:peak10x}': ['p(95)<1000'],
    'checks{step:peak10x}': ['rate==1'],
  },
};

const MEMBERS = 20;
const QUESTIONS = [
  'What is due next on this matter?',
  'Summarise where this estate is up to.',
  'Which tasks are overdue here?',
  'What do we still need from the executor?',
];

export function setup() {
  const owner = signIn('owner@large.example');
  const saved = call(
    'clerk-setApiKey',
    { requestId: uuid(), apiKey: 'sk-ant-api03-fictional-load-test-key-0000' },
    owner,
    {
      step: 'setup',
    },
  );
  if (!saved.ok) throw new Error(`Couldn’t save the Clerk key: ${JSON.stringify(saved.error)}`);
  const people = accounts('lawyer', MEMBERS)
    .map((a) => ({ token: signIn(a.email), matters: openMatters(a.uid, 30) }))
    .filter((p) => p.matters.length);
  const first = people[0];
  callMany(
    'clerk-sendMessage',
    () => ({ requestId: uuid(), matterId: pick(first.matters), text: pick(QUESTIONS) }),
    first.token,
    3,
  );
  return { people };
}

export default function ({ people }) {
  const person = pick(people);
  call('clerk-sendMessage', { requestId: uuid(), matterId: pick(person.matters), text: pick(QUESTIONS) }, person.token);
}
