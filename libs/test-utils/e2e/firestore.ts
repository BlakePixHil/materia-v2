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

/**
 * Writes (replaces) many documents in batched commits through the emulator's admin access: for
 * bulk fixtures such as `buildLoadMatters` from `@materia/test-utils` (500 matters, CORE-03).
 */
export async function setEmulatorDocuments(
  request: APIRequestContext,
  docs: readonly { path: string; data: Record<string, unknown> }[],
  batchSize = 250,
): Promise<void> {
  const root = `projects/${EMULATOR_PROJECT}/databases/(default)/documents`;
  for (let i = 0; i < docs.length; i += batchSize) {
    const writes = docs.slice(i, i + batchSize).map(({ path, data }) => ({
      update: { name: `${root}/${path}`, fields: toFirestoreRestFields(data) },
    }));
    const response = await request.post(`${FIRESTORE_EMULATOR}/v1/${root}:commit`, {
      headers: ADMIN,
      data: { writes },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
}
