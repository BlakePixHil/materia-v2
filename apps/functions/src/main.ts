// Must be first: it sets the global options (service account, max instances) before any function is defined.
import './global-options';

// Each export group becomes a function-name prefix: `system.echo` deploys as `system-echo`.
export * as system from './system/index';
export * as audit from './audit/index';
export * as auth from './auth/index';
export * as flags from './flags/index';
export * as clerk from './clerk/index';
export * as jobs from './jobs/index';
export * as orgs from './orgs/index';
export * as contacts from './contacts/index';
export * as matters from './matters/index';
export * as conflicts from './conflicts/index';
export * as templates from './templates/index';
export * as tasks from './tasks/index';
export * as deadlines from './deadlines/index';
export * as docs from './docs/index';
export * as documents from './documents/index';
export * as notifications from './notifications/index';
export * as notes from './notes/index';
export * as activity from './activity/index';
export * as reminders from './reminders/index';
export * as estate from './estate/index';
export * as suggestions from './suggestions/index';
export * as safeCustody from './safe-custody/index';
export * as time from './time/index';
export * as fees from './fees/index';
export * as costs from './costs/index';
export * as billing from './billing/index';
export * as disbursements from './disbursements/index';
export * as backups from './backups/index';
export * as trust from './trust/index';
export * as security from './security/index';
export * as metrics from './metrics/index';
export * as integrations from './integrations/index';
export * as connector from './connector/index';
export * as xero from './xero/index';
export * as migration from './migration/index';
export * as exports from './exports/index';
// Emulator-only tools (the dev mail preview): undefined, so never deployed, anywhere else.
export * as dev from './dev/index';
