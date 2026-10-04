import { setGlobalOptions } from 'firebase-functions/v2';

import { REGION } from './config';

// Deployed functions run as fn-runtime (FND-03), not the default compute service account.
// The trailing @ means "in this project". The emulator ignores it.
setGlobalOptions({ region: REGION, maxInstances: 10, serviceAccount: 'fn-runtime@' });

// Each export group becomes a function-name prefix: `system.echo` deploys as `system-echo`.
export * as system from './system/index';
export * as audit from './audit/index';
export * as auth from './auth/index';
