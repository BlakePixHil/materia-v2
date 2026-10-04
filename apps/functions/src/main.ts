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
