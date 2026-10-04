import { setGlobalOptions } from 'firebase-functions/v2';

import { REGION } from './config';

// Deployed functions run as fn-runtime (FND-03), not the default compute or App Engine service
// account. The trailing @ means "in this project". The emulator ignores it.
// This must stay a separate module that main.ts imports first: ES exports are hoisted, so options
// set inside main.ts would run after every function was already defined.
setGlobalOptions({ region: REGION, maxInstances: 10, serviceAccount: 'fn-runtime@' });
