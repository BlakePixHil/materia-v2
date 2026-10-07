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
  /** Shown only once the practice has a legacy migration run (MIG-08). */
  migrated?: boolean;
}

export const SETTINGS_ADMIN_ROLES: readonly Role[] = ['owner', 'admin'];
/** Exporting everything and deleting the practice are owners' alone (SEC-05). */
export const SETTINGS_OWNER_ROLES: readonly Role[] = ['owner'];

/**
 * The Settings pages, in sidebar order. A new settings page adds its route under `settings` in
 * app.routes.ts and an entry here (Clerk settings, AI-13; security, SEC-04; trust account, BILL-11;
 * integrations, BILL-09 and INT-03; the Claude connector, INT-07; document templates, INT-06; the migration import, MIG-08; data and
 * deletion, SEC-05).
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
  // The practice's Xero connection and where invoices go in it (BILL-09).
  {
    path: 'integrations',
    label: 'Integrations',
    icon: 'link',
    group: 'Firm',
    roles: SETTINGS_ADMIN_ROLES,
    flag: 'integrations.xero',
  },
  // Using Materia from a person's own Claude (INT-07): everyone connects their own.
  {
    path: 'claude',
    label: 'Claude connector',
    icon: 'share',
    group: 'Firm',
    flag: 'integrations.claudeConnector',
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
  // Letterhead and .docx templates (INT-06).
  {
    path: 'document-templates',
    label: 'Document templates',
    icon: 'document',
    group: 'Practice',
    roles: SETTINGS_ADMIN_ROLES,
  },
  // Clerk and AI (AI-02a, AI-13): everyone; read-only below owners and admins.
  { path: 'clerk', label: 'Clerk and AI', icon: 'sparkle', group: 'Clerk' },
  { path: 'audit', label: 'Audit log', icon: 'shield', group: 'Records', roles: SETTINGS_ADMIN_ROLES },
  // Export everything, or delete the practice (SEC-05): owners only; everyone sees the shell's banner.
  { path: 'data', label: 'Data and deletion', icon: 'archive', group: 'Records', roles: SETTINGS_OWNER_ROLES },
  // The practice brought across from the old materia (MIG-08).
  {
    path: 'migration',
    label: 'Import from materia',
    icon: 'inbox',
    group: 'Records',
    roles: SETTINGS_ADMIN_ROLES,
    migrated: true,
  },
];

/** The sections a role sees, with flags checked by `isOn`; the import once the practice was `migrated`. */
export function visibleSections(
  role: Role | null,
  isOn: (flag: FlagKey) => boolean,
  migrated = false,
): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (s) => (!s.roles || (!!role && s.roles.includes(role))) && (!s.flag || isOn(s.flag)) && (!s.migrated || migrated),
  );
}
