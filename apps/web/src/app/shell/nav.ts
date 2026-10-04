import type { FlagKey } from '@materia/domain';
import type { MtIconName, MtTabBarItem } from '@materia/ui';

/** A sidebar destination. Keep this the single list so feature flags (FND-23) can hide items. */
export interface NavEntry {
  id: string;
  label: string;
  icon: MtIconName;
  link: string;
  /** `g` then this key goes there. */
  key: string;
  section?: 'workspace';
  /** Feature flag that hides the item (and its route, shortcut and command) while off (FND-23). */
  flag?: FlagKey;
}

export const NAV_ITEMS: readonly NavEntry[] = [
  { id: 'today', label: 'Today', icon: 'today', link: '/today', key: 't' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', link: '/inbox', key: 'i' },
  { id: 'matters', label: 'Matters', icon: 'matters', link: '/matters', key: 'm', section: 'workspace' },
  { id: 'deadlines', label: 'Deadlines', icon: 'calendar', link: '/deadlines', key: 'd', section: 'workspace' },
  {
    id: 'disputes',
    label: 'Disputes',
    icon: 'scale',
    link: '/disputes',
    key: 'p',
    section: 'workspace',
    flag: 'litigation.enabled',
  },
  { id: 'contacts', label: 'Contacts', icon: 'contacts', link: '/contacts', key: 'c', section: 'workspace' },
  { id: 'billing', label: 'Time & billing', icon: 'billing', link: '/billing', key: 'b', section: 'workspace' },
  { id: 'insights', label: 'Insights', icon: 'insights', link: '/insights', key: 'n', section: 'workspace' },
];

export const SETTINGS_ITEM: NavEntry = {
  id: 'settings',
  label: 'Settings',
  icon: 'settings',
  link: '/settings',
  key: 's',
};

/** The phone TabBar: four destinations and Record in the middle (MOB-02 refines it). */
export const TAB_BAR_ITEMS: readonly MtTabBarItem[] = [
  { label: 'Today', icon: 'today', link: '/today' },
  { label: 'Matters', icon: 'matters', link: '/matters' },
  { label: 'Record', icon: 'timer', link: '/billing', fab: true },
  { label: 'Deadlines', icon: 'calendar', link: '/deadlines' },
  { label: 'Inbox', icon: 'inbox', link: '/inbox' },
];
