import { expect, type APIRequestContext } from '@playwright/test';

import { EMULATOR_PROJECT, FIRESTORE_EMULATOR } from './auth';

const ADMIN = { Authorization: 'Bearer owner' };

/** A plain value as a Firestore REST `Value` (strings, numbers, booleans, null, Dates, arrays, maps). */
export function toFirestoreRestValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreRestValue) } };
  if (typeof value === 'object') {
    return { mapValue: { fields: toFirestoreRestFields(value as Record<string, unknown>) } };
  }
  throw new Error(`Can't write ${typeof value} to Firestore`);
}

/** Plain data as Firestore REST `fields`. */
export function toFirestoreRestFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, toFirestoreRestValue(value)]),
  );
}

/**
 * Writes (replaces) a document through the Firestore emulator's admin access, bypassing the rules
 * and triggers' callables: for seeding fictional records an e2e test needs, such as a matter and a
 * party (with the server-owned `orgId` and `matterId`).
 */
export async function setEmulatorDocument(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  const response = await request.patch(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`,
    { headers: ADMIN, data: { fields: toFirestoreRestFields(data) } },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

/** Most writes one emulator commit takes. */
const COMMIT_LIMIT = 500;

/**
 * Writes (replaces) many documents through the Firestore emulator's admin access, in commits of up
 * to 500: for seeding a large fictional practice, such as 500 matters for a list's performance
 * check. Rules and the request-per-document cost of `setEmulatorDocument` are both skipped.
 */
export async function setEmulatorDocuments(
  request: APIRequestContext,
  documents: readonly { path: string; data: Record<string, unknown> }[],
): Promise<void> {
  const root = `projects/${EMULATOR_PROJECT}/databases/(default)/documents`;
  for (let start = 0; start < documents.length; start += COMMIT_LIMIT) {
    const writes = documents.slice(start, start + COMMIT_LIMIT).map(({ path, data }) => ({
      update: { name: `${root}/${path}`, fields: toFirestoreRestFields(data) },
    }));
    const response = await request.post(`${FIRESTORE_EMULATOR}/v1/${root}:commit`, {
      headers: ADMIN,
      data: { writes },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
}
