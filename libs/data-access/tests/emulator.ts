/**
 * Seeding and inspecting the Firestore emulator through its REST API with admin access (rules
 * bypassed), for the data layer's integration tests. Everything written here is fictional.
 */
export const PROJECT = 'demo-materia';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

type Value = Record<string, unknown>;

function encode(value: unknown): Value {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number')
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: fields(value as Record<string, unknown>) } };
}

function fields(data: Record<string, unknown>): Record<string, Value> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)]));
}

/** Writes a whole document. */
export async function setDoc(path: string, data: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: ADMIN,
    body: JSON.stringify({ fields: fields(data) }),
  });
  if (!response.ok) throw new Error(`setDoc ${path}: ${response.status} ${await response.text()}`);
}

/** Reads a document's raw REST fields (or null). */
export async function getDoc(path: string): Promise<Record<string, Value> | null> {
  const response = await fetch(`${BASE}/${path}`, { headers: ADMIN });
  if (response.status === 404) return null;
  return ((await response.json()) as { fields: Record<string, Value> }).fields;
}

/** Deletes every document in the emulator. */
export async function clearFirestore(): Promise<void> {
  const response = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(`clear: ${response.status}`);
}

/** A member document as the orgs-* callables write it (fictional people). */
export function member(displayName: string, role: string, status = 'active'): Record<string, unknown> {
  const now = new Date('2026-10-01T00:00:00Z');
  return {
    displayName,
    role,
    status,
    email: `${displayName.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`,
    initials: displayName
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 3),
    title: 'Lawyer',
    defaultRateCents: 30000,
    rates: [],
    colour: '#346CFC',
    budgets: {},
    createdAt: now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
    schemaVersion: 1,
  };
}
