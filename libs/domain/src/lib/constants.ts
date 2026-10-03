/** Cross-cutting domain constants (ADR-008). */

/** Legal dates are computed in the org timezone; this is the default for new orgs. */
export const DEFAULT_ORG_TIMEZONE = 'Australia/Melbourne';

/** Money is integer cents in this currency. */
export const CURRENCY = 'AUD';

/** Time is stored in integer minutes and billed in 6-minute units (0.1 h). */
export const BILLING_UNIT_MINUTES = 6;

/** Australian GST rate. */
export const GST_RATE = 0.1;
