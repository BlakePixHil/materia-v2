/**
 * Cross-cutting domain constants (ADR-008). FND-13 adds the zod schemas and the
 * money, time and date utilities.
 */

/** Legal dates are computed in the org timezone; this is the default for new orgs. */
export const DEFAULT_ORG_TIMEZONE = 'Australia/Melbourne';

/** Money is integer cents in this currency. */
export const CURRENCY = 'AUD';

/** Time is stored in integer minutes and billed in 6-minute units (0.1 h). */
export const BILLING_UNIT_MINUTES = 6;

// FND-04 demo (reverted): a type error that only `typecheck` should catch.
export const DEMO_TYPE_ERROR: number = 'not a number' as unknown as string;
