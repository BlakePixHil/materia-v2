/** The matter detail tabs, in order. Unknown tabs redirect to `overview`. */
export const MATTER_TABS = [
  { path: 'overview', label: 'Overview', ticket: 'CORE-06' },
  { path: 'tasks', label: 'Tasks', ticket: 'CORE-08' },
  { path: 'deadlines', label: 'Deadlines', ticket: 'CORE-10' },
  { path: 'documents', label: 'Documents', ticket: 'CORE-12' },
  { path: 'time', label: 'Time', ticket: 'BILL-01' },
  { path: 'parties', label: 'Parties', ticket: 'CORE-06' },
  { path: 'notes', label: 'Notes', ticket: 'CORE-13' },
  { path: 'activity', label: 'Activity', ticket: 'CORE-13' },
] as const;
