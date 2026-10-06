import { domain } from '../domain.ts';
import type { AuthPort, TargetDb } from './target.ts';

type MembershipRole = Parameters<typeof domain.computeClaims>[0][number];

/** The tenancy part of a claims object, with keys in a fixed order (for comparison). */
function tenancyPart(claims: Record<string, unknown> | null | undefined): string {
  const entries = domain.TENANCY_CLAIM_KEYS.flatMap((key) => (claims?.[key] === undefined ? [] : [[key, claims[key]]]));
  return JSON.stringify(Object.fromEntries(entries), (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

const isRole = (value: unknown): value is MembershipRole['role'] =>
  typeof value === 'string' && (domain.ROLES as readonly string[]).includes(value);

/**
 * The claims sync `auth-syncClaims` runs when a member document is written (FND-17,
 * apps/functions/src/orgs/claims.ts), done here too so the load leaves the person able to sign in
 * to the org without waiting for the trigger (and on the emulator, which runs no functions): the
 * tenancy claims recomputed from their member documents, other claims kept, and `orgIds`,
 * `memberships`, `activeOrgId` and `claimsVersion` mirrored on `users/{uid}`. Running it twice
 * (here and in the trigger) gives the same claims.
 */
export async function syncClaims(
  db: TargetDb,
  auth: AuthPort,
  uid: string,
  options: { alsoOrgIds?: readonly string[]; now: Date },
): Promise<{ changed: boolean; orgIds: string[] }> {
  const userPath = `users/${uid}`;
  const [users, existing] = await Promise.all([db.getAll([userPath]), auth.claimsOf(uid)]);
  if (existing === null) throw new Error(`There is no v2 account ${uid}: import it first (auth-import).`);
  const user = users.get(userPath) ?? {};
  const orgIds = [
    ...new Set([
      ...((user['orgIds'] as string[] | undefined) ?? []),
      ...Object.keys((user['memberships'] as Record<string, unknown> | undefined) ?? {}),
      ...(options.alsoOrgIds ?? []),
    ]),
  ].sort();

  const paths = orgIds.flatMap((orgId) => [`orgs/${orgId}/members/${uid}`, `orgs/${orgId}`]);
  const found = await db.getAll(paths);
  const memberships: MembershipRole[] = [];
  for (const orgId of orgIds) {
    const member = found.get(`orgs/${orgId}/members/${uid}`);
    const role = member?.['role'];
    if (member && member['status'] === 'active' && isRole(role)) {
      memberships.push({ orgId, role, name: String(found.get(`orgs/${orgId}`)?.['name'] ?? '') });
    }
  }

  const activeOrgId = domain.pickActiveOrg(memberships, (user['activeOrgId'] as string | null | undefined) ?? null);
  const tenancy = domain.computeClaims(memberships, activeOrgId);
  const changed = tenancyPart(existing) !== tenancyPart(tenancy as Record<string, unknown>);
  if (changed) {
    const kept = Object.fromEntries(
      Object.entries(existing).filter(([key]) => !(domain.TENANCY_CLAIM_KEYS as readonly string[]).includes(key)),
    );
    await auth.setClaims(uid, { ...kept, ...tenancy });
  }

  if (users.has(userPath)) {
    const version = Number(user['claimsVersion'] ?? 0);
    const failures = await db.apply([
      {
        op: 'update',
        path: userPath,
        data: {
          orgIds: memberships.map((m) => m.orgId),
          memberships: Object.fromEntries(memberships.map((m) => [m.orgId, { role: m.role, name: m.name }])),
          activeOrgId,
          claimsVersion: changed ? version + 1 : version,
          updatedAt: options.now,
          updatedBy: 'system',
        },
      },
    ]);
    if (failures.length) throw new Error(`Could not update ${userPath}: ${failures[0]?.message}`);
  }
  return { changed, orgIds: memberships.map((m) => m.orgId) };
}
