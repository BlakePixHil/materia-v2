import type { Role } from './schemas/enums';

/**
 * The role × action matrix (ADR-005), shared by the UI (hide or disable controls) and functions
 * (enforce). Firestore rules mirror it (FND-14). The table in libs/domain/README.md is generated
 * from this object (`UPDATE_PERMISSIONS_README=1 pnpm nx test domain`).
 */
export const PERMISSIONS = {
  'matter.view': ['owner', 'admin', 'lawyer', 'paralegal', 'readonly'],
  'matter.create': ['owner', 'admin', 'lawyer', 'paralegal'],
  'matter.edit': ['owner', 'admin', 'lawyer', 'paralegal'],
  'matter.delete': ['owner', 'admin', 'lawyer'],
  'matter.close': ['owner', 'admin', 'lawyer'],
  'matter.status': ['owner', 'admin', 'lawyer'],
  'matter.restore': ['owner', 'admin'],
  /** Change a matter's number (CORE-21a). */
  'matter.renumber': ['owner', 'admin', 'lawyer'],
  'contact.edit': ['owner', 'admin', 'lawyer', 'paralegal'],
  'contact.delete': ['owner', 'admin', 'lawyer'],
  'contact.merge': ['owner', 'admin'],
  'conflict.run': ['owner', 'admin', 'lawyer', 'paralegal'],
  'conflict.determine': ['owner', 'admin', 'lawyer'],
  'privileged.view': ['owner', 'admin', 'lawyer'],
  'document.upload': ['owner', 'admin', 'lawyer', 'paralegal'],
  'document.delete': ['owner', 'admin', 'lawyer'],
  'task.edit': ['owner', 'admin', 'lawyer', 'paralegal'],
  'note.write': ['owner', 'admin', 'lawyer', 'paralegal'],
  'deadline.override': ['owner', 'admin', 'lawyer'],
  'time.record': ['owner', 'admin', 'lawyer', 'paralegal'],
  'time.approve': ['owner', 'admin', 'lawyer'],
  'billing.view': ['owner', 'admin', 'lawyer'],
  'billing.issue': ['owner', 'admin'],
  'billing.void': ['owner', 'admin'],
  'clerk.use': ['owner', 'admin', 'lawyer', 'paralegal'],
  'clerk.configure': ['owner', 'admin'],
  'members.manage': ['owner', 'admin'],
  'org.settings': ['owner', 'admin'],
  'org.delete': ['owner'],
  'audit.view': ['owner', 'admin'],
  'export.run': ['owner', 'admin'],
  'export.includePrivileged': ['owner', 'admin'],
  /** Receive, move, return and stocktake original wills in safe custody (CORE-17). */
  'safeCustody.edit': ['owner', 'admin', 'lawyer', 'paralegal'],
  /** Release an original or destroy it on instructions, or confirm a destruction (CORE-17). */
  'safeCustody.release': ['owner', 'admin', 'lawyer'],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;
export const ACTIONS = Object.keys(PERMISSIONS) as Action[];
export const ROLES: readonly Role[] = ['owner', 'admin', 'lawyer', 'paralegal', 'readonly'];

/** What the action targets. A privileged resource additionally needs `privileged.view`. */
export interface PermissionResource {
  privileged?: boolean;
}

/**
 * `can('paralegal', 'matter.view', { privileged: true })` → false. Read-only users never see
 * privileged material (Domain doc, invariant 7).
 */
export function can(role: Role, action: Action, resource: PermissionResource = {}): boolean {
  const allowed = (PERMISSIONS[action] as readonly Role[]).includes(role);
  if (!allowed) return false;
  if (resource.privileged) return (PERMISSIONS['privileged.view'] as readonly Role[]).includes(role);
  return true;
}

/** The matrix as a Markdown table (generated into libs/domain/README.md). */
export function permissionsTable(): string {
  const header = `| Action | ${ROLES.join(' | ')} |`;
  const divider = `| -- | ${ROLES.map(() => '--').join(' | ')} |`;
  const rows = ACTIONS.map(
    (action) =>
      `| \`${action}\` | ${ROLES.map((role) => ((PERMISSIONS[action] as readonly Role[]).includes(role) ? '✓' : '')).join(' | ')} |`,
  );
  return [header, divider, ...rows].join('\n');
}
