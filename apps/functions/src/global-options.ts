import { setGlobalOptions } from 'firebase-functions/v2';

import { REGION } from './config';

// Deployed functions run as fn-runtime (FND-03), not the default compute or App Engine service
// account. firebase-tools expands a trailing @ to "in this project" for the function itself, but
// passes it unexpanded to Secret Manager when it grants secret access, which then rejects it. So
// use the full email whenever the project is known (always at deploy time). The emulator and unit
// tests have no project and keep the short form.
export function runtimeServiceAccount(projectId: string | undefined): string {
  return projectId ? `fn-runtime@${projectId}.iam.gserviceaccount.com` : 'fn-runtime@';
}

// This must stay a separate module that main.ts imports first: ES exports are hoisted, so options
// set inside main.ts would run after every function was already defined.
setGlobalOptions({
  region: REGION,
  maxInstances: 10,
  serviceAccount: runtimeServiceAccount(process.env['GCLOUD_PROJECT']),
});
