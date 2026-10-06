import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { LegacyDoc, StorageObject } from './snapshot.ts';

/**
 * The synthetic legacy database in `tools/migration/fixtures/legacy/` (MIG-01; reused by MIG-02
 * and MIG-03): a few fictional users, workflows, cards and files that exercise every hazard in
 * the Legacy migration plan. Its README lists what each one covers. Fictional data only.
 */

export const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/legacy/', import.meta.url));

/** The user the fixtures migrate, and the others they reference. */
export const FIXTURE_UIDS = {
  subject: 'AlexRiversLegacyUid000000001',
  colleague: 'JordanEllisLegacyUid00000002',
  departed: 'DepartedUserLegacyUid0000003',
  stranger: 'UnrelatedUserLegacyUid000004',
} as const;

const COLLECTIONS = [
  'profiles',
  'workspaces',
  'workflows',
  'cards',
  'attachments',
  'checklist-templates',
  'referrers',
  'dashboard-checklist-items',
  'integrations',
  'notifications',
] as const;

function read<T>(name: string, dir: string): T {
  return JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')) as T;
}

export function loadLegacyFixtures(dir = FIXTURE_DIR): { docs: LegacyDoc[]; objects: StorageObject[] } {
  return {
    docs: COLLECTIONS.flatMap((name) => read<LegacyDoc[]>(name, dir)),
    objects: read<StorageObject[]>('storage-objects', dir),
  };
}
