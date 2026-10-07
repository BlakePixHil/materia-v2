import { inject, InjectionToken } from '@angular/core';

import { CallableClient, Connectivity } from '@materia/data-access';
import { DialogService } from '@materia/ui';

import { AuthState } from '../auth/auth-state';

/**
 * The app's callable client (FND-19): request ids reused on retry, `DomainError`s, a claims
 * refresh on `ORG_CLAIM_MISMATCH`, and "Confirm it's you" then a retry on `REAUTH_REQUIRED`
 * (SEC-04), so no feature handles re-authentication itself. Calls go through the auth port's
 * Functions instance. Offline, calls fail at once with "Needs connection" (MOB-01).
 */
export const CALLABLES = new InjectionToken<CallableClient>('CALLABLES', {
  providedIn: 'root',
  factory: () => {
    const auth = inject(AuthState);
    const dialogs = inject(DialogService);
    const connectivity = inject(Connectivity);
    return new CallableClient(
      {
        call: (name, data) => auth.api.call(name, data),
        refreshClaims: () => auth.refreshClaims(),
        reauthenticate: async () => {
          const { ReauthDialog } = await import('../auth/reauth-dialog');
          const handle = dialogs.open<{ reason: string }, boolean>(ReauthDialog, {
            data: { reason: 'For your security, confirm it’s you to do this.' },
          });
          return (await handle.result) === true;
        },
      },
      { online: connectivity.online },
    );
  },
});
