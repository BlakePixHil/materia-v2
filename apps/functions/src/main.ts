import { setGlobalOptions } from 'firebase-functions/v2';

import { REGION } from './config';

setGlobalOptions({ region: REGION, maxInstances: 10 });

// Each export group becomes a function-name prefix: `platform.ping` deploys as `platform-ping`.
export * as platform from './platform/index';
