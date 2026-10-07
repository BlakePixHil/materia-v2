/** Cross-cutting domain constants (ADR-008). */

/** Legal dates are computed in the org timezone; this is the default for new orgs. */
export const DEFAULT_ORG_TIMEZONE = 'Australia/Melbourne';

/** Money is integer cents in this currency. */
export const CURRENCY = 'AUD';

/** Time is stored in integer minutes and billed in 6-minute units (0.1 h). */
export const BILLING_UNIT_MINUTES = 6;

/** Australian GST rate. */
export const GST_RATE = 0.1;

/**
 * The web app's compatibility with the API (MOB-01). The web app is built with this number and
 * system-ping reports the server's as `minClientVersion`; an app left open across a deploy that
 * raised it asks the person to save their work and reload. Raise it in a change that apps built
 * before it would break against (a callable's input renamed, a document shape their code can't
 * read).
 */
export const CLIENT_COMPAT_VERSION = 1;
