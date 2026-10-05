import type { FlagKey } from '@materia/domain';

/** A matter screen tab: its path, label, the ticket that builds it, and the matter types it's for. */
export interface MatterTab {
  path: string;
  label: string;
  ticket: string;
  /** Shown only for these matter types (all types when absent). */
  types?: readonly string[];
  /** Shown only while this feature flag is on. */
  flag?: FlagKey;
}

/** The matter detail tabs, in order (CORE-06). Unknown tabs redirect to `overview`. */
export const MATTER_TABS: readonly MatterTab[] = [
  { path: 'overview', label: 'Overview', ticket: 'CORE-06' },
  { path: 'tasks', label: 'Tasks', ticket: 'CORE-08' },
  { path: 'deadlines', label: 'Deadlines', ticket: 'CORE-10' },
  { path: 'documents', label: 'Documents', ticket: 'CORE-12' },
  { path: 'time', label: 'Time', ticket: 'BILL-01' },
  { path: 'parties', label: 'Parties', ticket: 'CORE-06' },
  // ESTATE_REGISTER_TYPES in libs/domain (kept literal here: the tab list is in the initial bundle).
  {
    path: 'estate',
    label: 'Estate',
    ticket: 'CORE-16',
    types: ['probate', 'loa', 'admin', 'trust'],
    flag: 'estate.register',
  },
  { path: 'litigation', label: 'Litigation', ticket: 'LIT-03', types: ['fp', 'contest'] },
  { path: 'notes', label: 'Notes', ticket: 'CORE-13' },
  { path: 'activity', label: 'Activity', ticket: 'CORE-13' },
];

/** The tabs a matter of this type shows, leaving out those whose flag is off. */
export function matterTabsFor(type: string | undefined, isOn: (flag: FlagKey) => boolean = () => true): MatterTab[] {
  return MATTER_TABS.filter(
    (tab) => (!tab.types || (type !== undefined && tab.types.includes(type))) && (!tab.flag || isOn(tab.flag)),
  );
}
