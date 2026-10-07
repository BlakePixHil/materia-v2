import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

/**
 * The Firebase emulators the SEC-07 load scripts drive (project `demo-materia`), with the large
 * practice from `materia-scripts seed-large` in them. Nothing here can reach a real project: the
 * hosts default to localhost, and the project id must start with `demo-`.
 */
const HOST = __ENV.EMULATOR_HOST || '127.0.0.1';
export const PROJECT = __ENV.PROJECT || 'demo-materia';
if (!PROJECT.startsWith('demo-')) throw new Error(`Load tests run against demo- projects only, not ${PROJECT}`);
const REGION = 'australia-southeast1';
const AUTH = `http://${HOST}:${__ENV.AUTH_PORT || 9099}`;
const FUNCTIONS = `http://${HOST}:${__ENV.FUNCTIONS_PORT || 5001}/${PROJECT}/${REGION}`;
const FIRESTORE = `http://${HOST}:${__ENV.FIRESTORE_PORT || 8080}/v1/projects/${PROJECT}/databases/(default)/documents`;

/** The large practice (tools/scripts/src/seed/large.ts). */
export const ORG = 'org-large';
export const PASSWORD = 'materia-local-dev';

/** The first two hex digits of a `requestId` by step, so the functions' logs can be split by step. */
const STEP_PREFIX = { peak10x: 'aa', contention: 'cc' };

/**
 * A version 4 UUID for callables' `requestId`. It starts `aa` in the 10× peak step, `cc` in the
 * contention step and `ee` in the setup, so a run's function logs (which carry the requestId, and
 * the counters' transaction attempts) can be split by step.
 */
export function uuid() {
  let prefix = 'ee';
  try {
    prefix = STEP_PREFIX[exec.scenario.name] || prefix;
  } catch {
    // setup() runs outside any scenario.
  }
  const random = 'xxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  return `${prefix}${random}`;
}

/** Options every script shares: a setup long enough to sign in the members on a busy emulator. */
export const COMMON_OPTIONS = { setupTimeout: '180s' };

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Signs in through the Auth emulator; returns the ID token (valid for an hour). */
export function signIn(email) {
  const res = http.post(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'signIn' } },
  );
  if (res.status !== 200) throw new Error(`Sign-in failed for ${email}: ${res.status} ${res.body}`);
  return res.json('idToken');
}

/** The large practice's accounts by role (uids `lg-lawyer-1`, emails `lawyer1@large.example`). */
export function accounts(role, count) {
  return Array.from({ length: count }, (_, i) => ({
    uid: `lg-${role}-${i + 1}`,
    email: `${role}${i + 1}@large.example`,
  }));
}

function callableRequest(name, data, token, tags) {
  return {
    method: 'POST',
    url: `${FUNCTIONS}/${name}`,
    body: JSON.stringify({ data }),
    params: {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      tags: { name, ...tags },
      timeout: '120s',
    },
  };
}

function outcome(name, res) {
  let body = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  const ok = res.status === 200 && body && body.result !== undefined;
  check(res, { [`${name} succeeded`]: () => ok });
  if (!ok && __ENV.LOAD_VERBOSE) console.warn(`${name}: ${res.status} ${String(res.body).slice(0, 300)}`);
  return { ok, result: ok ? body.result : null, error: ok ? null : (body && body.error) || { status: res.status } };
}

/** Calls a callable as the token's member; `ok`, `result` and `error` as the client SDK sees them. */
export function call(name, data, token, tags = {}) {
  const req = callableRequest(name, data, token, tags);
  return outcome(name, http.request(req.method, req.url, req.body, req.params));
}

/** Calls a callable `count` times at once (a warm-up: the emulator starts a worker per call). */
export function callMany(name, makeData, token, count) {
  const reqs = Array.from({ length: count }, () => callableRequest(name, makeData(), token, { step: 'warmup' }));
  return http.batch(reqs).map((res) => outcome(name, res));
}

/** A Firestore field filter for the REST API. */
export function where(field, op, value) {
  if (value === null)
    return { unaryFilter: { op: op === '==' ? 'IS_NULL' : 'IS_NOT_NULL', field: { fieldPath: field } } };
  const ops = { '==': 'EQUAL', '!=': 'NOT_EQUAL', 'array-contains': 'ARRAY_CONTAINS' };
  const encoded = typeof value === 'boolean' ? { booleanValue: value } : { stringValue: String(value) };
  return { fieldFilter: { field: { fieldPath: field }, op: ops[op], value: encoded } };
}

/** A structured query, as the Firestore REST API takes it. */
export function structuredQuery(collectionId, filters, options = {}) {
  return {
    from: [{ collectionId, allDescendants: !!options.group }],
    where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } },
    ...(options.orderBy ? { orderBy: [{ field: { fieldPath: options.orderBy }, direction: 'DESCENDING' }] } : {}),
    limit: options.limit || 20,
  };
}

/** A `runQuery` request under `parent` (`orgs/org-large`, or '' for a collection group at the root). */
export function queryRequest(parent, query, token, tags = {}) {
  return {
    method: 'POST',
    url: `${FIRESTORE}${parent ? `/${parent}` : ''}:runQuery`,
    body: JSON.stringify({ structuredQuery: query }),
    params: {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      tags: { name: 'runQuery', ...tags },
      timeout: '60s',
    },
  };
}

/** Runs a query and returns the documents' names (paths). `owner` bypasses the rules (setup only). */
export function runQuery(parent, query, token) {
  const req = queryRequest(parent, query, token, { step: 'setup' });
  const res = http.request(req.method, req.url, req.body, req.params);
  if (res.status !== 200) throw new Error(`runQuery failed: ${res.status} ${String(res.body).slice(0, 300)}`);
  return res
    .json()
    .filter((row) => row.document)
    .map((row) => row.document.name.split('/documents/')[1]);
}

/** The emulator's admin token: Firestore REST calls with it skip the rules (setup reads only). */
export const ADMIN_TOKEN = 'owner';

/** Live matters of the large practice for a responsible lawyer (setup only). */
export function openMatters(responsibleUid, limit = 300) {
  const query = structuredQuery(
    'matters',
    [where('responsibleUid', '==', responsibleUid), where('status', '==', 'open'), where('deletedAt', '==', null)],
    { limit },
  );
  return runQuery(`orgs/${ORG}`, query, ADMIN_TOKEN).map((path) => path.split('/').pop());
}
