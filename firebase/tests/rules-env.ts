import { readFileSync } from 'node:fs';
import path from 'node:path';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';

/**
 * Shared test environment for the Firestore and Storage rules. The emulator hosts come from
 * `firebase emulators:exec` (FIRESTORE_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST).
 * FND-14 adds role helpers and per-collection suites.
 */
export async function createRulesEnv(): Promise<RulesTestEnvironment> {
  const rulesDir = path.resolve(import.meta.dirname, '..');
  return initializeTestEnvironment({
    projectId: 'demo-materia',
    firestore: { rules: readFileSync(path.join(rulesDir, 'firestore.rules'), 'utf8') },
    storage: { rules: readFileSync(path.join(rulesDir, 'storage.rules'), 'utf8') },
  });
}
