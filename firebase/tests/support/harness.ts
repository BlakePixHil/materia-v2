import { readFileSync } from 'node:fs';
import path from 'node:path';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, type Firestore } from 'firebase/firestore';

import { ROLES, type Role } from '@materia/domain';

/**
 * Rules test harness (FND-14). The emulator hosts come from `firebase emulators:exec`
 * (FIRESTORE_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST); run with `pnpm nx run firebase:test-rules`.
 */
export const PROJECT_ID = 'demo-materia';
export const ORG = 'org-a';
export const OTHER_ORG = 'org-b';
export const MATTER = `orgs/${ORG}/matters/matter-1`;

/** The test uid for a role in org A, e.g. `lawyer-a`. */
export const uidFor = (role: Role, org: string = ORG) => `${role}-${org.slice(-1)}`;
/** A lawyer in org A whose member document is suspended (the claim still says lawyer). */
export const SUSPENDED_UID = 'suspended-a';

const rulesDir = path.resolve(import.meta.dirname, '../..');

export async function createRulesEnv(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(path.join(rulesDir, 'firestore.rules'), 'utf8') },
    storage: { rules: readFileSync(path.join(rulesDir, 'storage.rules'), 'utf8') },
  });
}

/** An authenticated context carrying the custom claims {orgId, role} (ADR-005). */
export function ctx(env: RulesTestEnvironment, role: Role, orgId: string = ORG, uid: string = uidFor(role, orgId)) {
  return env.authenticatedContext(uid, { orgId, role });
}

// rules-unit-testing types its contexts with the compat SDK; the instances work with the modular API.
export function db(env: RulesTestEnvironment, role: Role, orgId: string = ORG, uid?: string): Firestore {
  return ctx(env, role, orgId, uid).firestore() as unknown as Firestore;
}

/** Runs `fn` with security rules disabled (seeding). */
export async function seedAdmin(env: RulesTestEnvironment, fn: (db: Firestore) => Promise<unknown>): Promise<void> {
  await env.withSecurityRulesDisabled(async (context) => {
    await fn(context.firestore() as unknown as Firestore);
  });
}

/** Member documents for every role in org A (active), plus one suspended lawyer. */
export async function seedMembers(env: RulesTestEnvironment): Promise<void> {
  await seedAdmin(env, async (firestore) => {
    for (const role of ROLES) {
      await setDoc(doc(firestore, `orgs/${ORG}/members/${uidFor(role)}`), { role, status: 'active' });
    }
    await setDoc(doc(firestore, `orgs/${ORG}/members/${SUSPENDED_UID}`), { role: 'lawyer', status: 'suspended' });
  });
}
