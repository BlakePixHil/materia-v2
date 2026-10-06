import type { FlagKey, Role } from '@materia/domain';
import type { MtIconName } from '@materia/ui';

/** One page in the Settings sidebar (CORE-21). */
export interface SettingsSection {
  /** The path under `/settings`. */
  path: string;
  label: string;
  icon: MtIconName;
  group: 'You' | 'Firm' | 'Practice' | 'Clerk' | 'Records';
  /** Who sees it in the sidebar; the route's own guard enforces the same. Everyone when absent. */
  roles?: readonly Role[];
  /** Shown only while this flag is on. */
  flag?: FlagKey;
}

export const SETTINGS_ADMIN_ROLES: readonly Role[] = ['owner', 'admin'];

/**
 * The Settings pages, in sidebar order. A new settings page adds its route under `settings` in
 * app.routes.ts and an entry here (Clerk settings, AI-13; integrations, INT-03; security, SEC-04; trust account, BILL-11).
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // The person's own (CORE-20).
  { path: 'profile', label: 'Profile', icon: 'user', group: 'You' },
  { path: 'preferences', label: 'Preferences', icon: 'settings', group: 'You' },
  { path: 'practice', label: 'Practice', icon: 'matters', group: 'Firm', roles: SETTINGS_ADMIN_ROLES },
  { path: 'team', label: 'Team and roles', icon: 'contacts', group: 'Firm' },
  { path: 'billing', label: 'Billing and rates', icon: 'billing', group: 'Firm', roles: SETTINGS_ADMIN_ROLES },
  // Everyone: their own sessions; the policy itself is owners' and admins' (SEC-04).
  { path: 'security', label: 'Security', icon: 'lock', group: 'Firm' },
  // Trust balances copied from the firm's trust records (BILL-11, ADR-035): display only.
  {
    path: 'trust',
    label: 'Trust account',
    icon: 'scale',
    group: 'Firm',
    roles: SETTINGS_ADMIN_ROLES,
    flag: 'billing.trustDisplay',
  },
  { path: 'numbering', label: 'Matter numbering', icon: 'list', group: 'Practice', roles: SETTINGS_ADMIN_ROLES },
  {
    path: 'templates',
    label: 'Matter templates',
    icon: 'board',
    group: 'Practice',
    roles: SETTINGS_ADMIN_ROLES,
    flag: 'templates.system',
  },
  // Clerk settings (AI-02a, then AI-13): the route is the Clerk thread's own.
  { path: 'clerk', label: 'Clerk and AI', icon: 'sparkle', group: 'Clerk', roles: SETTINGS_ADMIN_ROLES },
  { path: 'audit', label: 'Audit log', icon: 'shield', group: 'Records', roles: SETTINGS_ADMIN_ROLES },
];

/** The sections a role sees, with flags checked by `isOn`. */
export function visibleSections(role: Role | null, isOn: (flag: FlagKey) => boolean): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => (!s.roles || (!!role && s.roles.includes(role))) && (!s.flag || isOn(s.flag)));
}
