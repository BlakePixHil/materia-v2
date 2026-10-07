/**
 * Feature flags (FND-23, ADR-016): unfinished and practitioner-review features ship dark. Values
 * come from Firebase Remote Config with per-org overrides on `orgs/{orgId}.flags`.
 *
 * Flags are never authorisation: they hide or reveal features, and `serverEnforced` flags also
 * stop the callables behind them. Who may do what is always roles and rules (permissions.ts).
 */
export type FlagValue = boolean | string | number;
export type FlagType = 'boolean' | 'string' | 'number';

export interface FlagDefinition<T extends FlagValue = FlagValue> {
  key: string;
  description: string;
  /** The ticket that owns the flag and removes it once the feature is fully on. */
  owner: string;
  type: FlagType;
  default: T;
  /** The callables implementing the feature check it too (client-only hiding is not security). */
  serverEnforced: boolean;
  /** When the flag went fully on everywhere (`YYYY-MM-DD`); 90 days later it should be removed. */
  fullyOnSince?: string;
}

export function defineFlag<const T extends FlagValue>(definition: FlagDefinition<T>): FlagDefinition<T> {
  return definition;
}

export const FLAGS = {
  'clerk.enabled': defineFlag({
    key: 'clerk.enabled',
    description: 'Clerk (AI) for the org: the panel, briefs and suggestions.',
    owner: 'AI-02',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.brief': defineFlag({
    key: 'clerk.features.brief',
    description: 'The Clerk daily brief on Today.',
    owner: 'AI-09',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.willExtraction': defineFlag({
    key: 'clerk.features.willExtraction',
    description: 'Extracting parties and gifts from an uploaded will.',
    owner: 'AI-08',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.drafting': defineFlag({
    key: 'clerk.features.drafting',
    description: 'Clerk drafting of letters from templates.',
    owner: 'AI-10',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.timeAssist': defineFlag({
    key: 'clerk.features.timeAssist',
    description: 'Time-entry suggestions from notes and activity.',
    owner: 'AI-11',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.chat': defineFlag({
    key: 'clerk.features.chat',
    description: 'The Clerk chat panel (⌘J) with matter-scoped threads.',
    owner: 'AI-06',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.suggestions': defineFlag({
    key: 'clerk.features.suggestions',
    description: 'Clerk suggestions (proposed tasks, deadlines, parties and more).',
    owner: 'AI-07',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.classification': defineFlag({
    key: 'clerk.features.classification',
    description: 'Classifying and titling documents on ingest.',
    owner: 'AI-04',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.insightsNarrative': defineFlag({
    key: 'clerk.features.insightsNarrative',
    description: 'Explain on Insights: Clerk describes what changed between two periods, from the metrics only.',
    owner: 'INS-04',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.matterBrief': defineFlag({
    key: 'clerk.features.matterBrief',
    description: 'The Clerk brief on a matter’s Overview (the template brief shows while it is off).',
    owner: 'AI-06c',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'clerk.features.intakePrefill': defineFlag({
    key: 'clerk.features.intakePrefill',
    description: 'The "Prefill from email or notes" button on the New matter form (shown disabled while off).',
    owner: 'CORE-05',
    type: 'boolean',
    default: false,
    serverEnforced: false,
  }),
  'deadlines.ruleset.vic.v1': defineFlag({
    key: 'deadlines.ruleset.vic.v1',
    description: 'Victorian rule set v1 computes persisted deadlines (off until a practitioner signs it off).',
    owner: 'CORE-09',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'conflicts.enforced': defineFlag({
    key: 'conflicts.enforced',
    description:
      'Conflict checks flag adverse roles from the adverse-role matrix (off until a practitioner signs it off, CORE-02a).',
    owner: 'CORE-02',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'templates.system': defineFlag({
    key: 'templates.system',
    description:
      'Matter templates: stages and tasks from the system or org template, stage entry requirements (off until a practitioner signs the system templates off, CORE-07a).',
    owner: 'CORE-07',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'matters.destruction': defineFlag({
    key: 'matters.destruction',
    description:
      'Retention destruction: the monthly destruction queue, approvals and permanent deletion of matters past their retention date (off until a practitioner signs the retention rules off, CORE-19a).',
    owner: 'CORE-19',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'estate.register': defineFlag({
    key: 'estate.register',
    description:
      'The Estate tab: assets, liabilities, distributions and the inventory export (off until a practitioner reviews the asset classes and summary wording, CORE-16a).',
    owner: 'CORE-16',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'litigation.enabled': defineFlag({
    key: 'litigation.enabled',
    description: 'Disputes: contested estates, proceedings and court deadlines.',
    owner: 'LIT-01',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'billing.invoicing': defineFlag({
    key: 'billing.invoicing',
    description: 'Pre-bills and tax invoices.',
    owner: 'BILL-07',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'billing.feeBudgets': defineFlag({
    key: 'billing.feeBudgets',
    description:
      'Fee arrangements on the matter Overview: the budget meter, revising the fee and the 80%/100% budget alerts (off until a practitioner signs it off, BILL-05a).',
    owner: 'BILL-05',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'billing.costsDisclosure': defineFlag({
    key: 'billing.costsDisclosure',
    description:
      'Costs disclosure tracking on the matter Overview: generating the disclosure, recording it as sent, update-required on a significant estimate change, the 7-day reminder and the report (off until a practitioner signs off the rules and template, BILL-06a).',
    owner: 'BILL-06',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'billing.disbursements': defineFlag({
    key: 'billing.disbursements',
    description:
      'Disbursements on the matter Time tab, with GST treatment, receipts and the org presets (off until a practitioner signs off the GST treatment and presets, BILL-04a).',
    owner: 'BILL-04',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'billing.trustDisplay': defineFlag({
    key: 'billing.trustDisplay',
    description:
      'Trust balances copied from the firm’s trust records on matters, and Settings → Trust account (off until a practitioner checks the labels, BILL-10a).',
    owner: 'BILL-11',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'billing.trustNotice': defineFlag({
    key: 'billing.trustNotice',
    description:
      'The r 42(3) notice of intended withdrawal from trust on invoices marked "To be paid from trust" (off until a practitioner approves the wording, BILL-10a).',
    owner: 'BILL-12',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'integrations.microsoft': defineFlag({
    key: 'integrations.microsoft',
    description: 'Microsoft 365 connection and calendar push.',
    owner: 'INT-01',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'integrations.xero': defineFlag({
    key: 'integrations.xero',
    description: 'Xero: connect the practice, send invoices and credit notes, bring payments back.',
    owner: 'BILL-09',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'mobile.voice': defineFlag({
    key: 'mobile.voice',
    description: 'Record by voice on mobile.',
    owner: 'MOB-03',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'auth.openSignup': defineFlag({
    key: 'auth.openSignup',
    description: 'Sign-up without an invite (to create a practice). Without a Remote Config value, only dev is open.',
    owner: 'FND-16',
    type: 'boolean',
    default: false,
    serverEnforced: true,
  }),
  'system.echo': defineFlag({
    key: 'system.echo',
    description: 'The example callable system-echo; shows server-side flag enforcement.',
    owner: 'FND-23',
    type: 'boolean',
    default: true,
    serverEnforced: true,
  }),
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAGS;
export type FlagValueOf<K extends FlagKey> = (typeof FLAGS)[K]['default'] extends boolean
  ? boolean
  : (typeof FLAGS)[K]['default'] extends number
    ? number
    : string;
export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(value: unknown): value is FlagKey {
  return typeof value === 'string' && Object.hasOwn(FLAGS, value);
}

/** Remote Config parameter names allow only letters, digits and underscores: `clerk.enabled` → `clerk_enabled`. */
export function remoteConfigKey(key: FlagKey): string {
  return key.replace(/\./g, '_');
}

/** Whether a value has the flag's type. */
export function isValidFlagValue(key: FlagKey, value: unknown): value is FlagValue {
  return typeof value === FLAGS[key].type;
}

export type FlagSource = 'local' | 'org' | 'remote' | 'default';

/**
 * A flag's value: a local dev override, then the org override, then Remote Config, then the
 * registry default. Values of the wrong type are ignored.
 */
export function resolveFlag<K extends FlagKey>(
  key: K,
  layers: { local?: Record<string, unknown>; org?: Record<string, unknown>; remote?: Record<string, unknown> },
): { value: FlagValueOf<K>; source: FlagSource } {
  for (const source of ['local', 'org', 'remote'] as const) {
    const value = layers[source]?.[key];
    if (value !== undefined && isValidFlagValue(key, value)) return { value: value as FlagValueOf<K>, source };
  }
  return { value: FLAGS[key].default as FlagValueOf<K>, source: 'default' };
}

/** Problems with the registry: owner format, key format, missing descriptions. Empty when valid. */
export function flagRegistryProblems(flags: Record<string, FlagDefinition> = FLAGS): string[] {
  const problems: string[] = [];
  for (const [name, flag] of Object.entries(flags)) {
    if (flag.key !== name) problems.push(`${name}: key "${flag.key}" doesn't match its registry name`);
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(flag.key))
      problems.push(`${name}: key must be dotted camelCase`);
    if (!/^[A-Z]+-\d+[a-z]?$/.test(flag.owner))
      problems.push(`${name}: owner "${flag.owner}" is not a ticket key (FND-23)`);
    if (!flag.description.trim()) problems.push(`${name}: missing description`);
    if (typeof flag.default !== flag.type) problems.push(`${name}: default doesn't match type ${flag.type}`);
    if (flag.fullyOnSince !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flag.fullyOnSince))
      problems.push(`${name}: fullyOnSince must be YYYY-MM-DD`);
  }
  return problems;
}

/** Flags fully on for longer than `days`: time to delete the flag and its dead branch. */
export function staleFlags(today: string, days = 90, flags: Record<string, FlagDefinition> = FLAGS): FlagDefinition[] {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - days * 86_400_000;
  return Object.values(flags).filter(
    (flag) => flag.fullyOnSince && Date.parse(`${flag.fullyOnSince}T00:00:00Z`) < cutoff,
  );
}
