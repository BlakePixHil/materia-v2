/**
 * The seed only ever runs against the Firebase emulators. It wipes data, so a mistake here could
 * destroy a real project: both an emulator host variable and a `demo-` project id are required.
 */

/** The emulator project the local stack and CI use. */
export const SEED_PROJECT_ID = 'demo-materia';

export interface SeedTarget {
  projectId: string;
  firestoreHost: string;
  authHost: string;
  storageHost: string | null;
}

export class SeedGuardError extends Error {
  override readonly name = 'SeedGuardError';
}

/**
 * Returns the emulator target, or throws unless FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST are set and the project id starts with `demo-`.
 */
export function resolveSeedTarget(
  env: NodeJS.ProcessEnv,
  projectId = env['GCLOUD_PROJECT'] ?? SEED_PROJECT_ID,
): SeedTarget {
  const firestoreHost = env['FIRESTORE_EMULATOR_HOST']?.trim();
  const authHost = env['FIREBASE_AUTH_EMULATOR_HOST']?.trim();
  if (!firestoreHost) {
    throw new SeedGuardError(
      'Refusing to seed: FIRESTORE_EMULATOR_HOST is not set. The seed only runs against the Firebase emulators (pnpm dev, or firebase emulators:exec).',
    );
  }
  if (!authHost) {
    throw new SeedGuardError('Refusing to seed: FIREBASE_AUTH_EMULATOR_HOST is not set.');
  }
  if (!projectId.startsWith('demo-')) {
    throw new SeedGuardError(
      `Refusing to seed project "${projectId}": only demo- projects (emulator-only) can be seeded.`,
    );
  }
  return {
    projectId,
    firestoreHost,
    authHost,
    storageHost: env['FIREBASE_STORAGE_EMULATOR_HOST']?.trim() || null,
  };
}
