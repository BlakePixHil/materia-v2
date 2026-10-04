import { setGlobalOptions } from 'firebase-functions/v2';

import { REGION } from './config';

setGlobalOptions({ region: REGION, maxInstances: 10 });

// Each export group becomes a function-name prefix: `system.echo` deploys as `system-echo`.
export * as system from './system/index';
