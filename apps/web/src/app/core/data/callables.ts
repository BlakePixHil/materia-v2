import { inject, InjectionToken } from '@angular/core';

import { CallableClient } from '@materia/data-access';

import { AuthState } from '../auth/auth-state';

/**
 * The app's callable client (FND-19): request ids reused on retry, `DomainError`s, and a claims
 * refresh on `ORG_CLAIM_MISMATCH`. Calls go through the auth port's Functions instance.
 */
export const CALLABLES = new InjectionToken<CallableClient>('CALLABLES', {
  providedIn: 'root',
  factory: () => {
    const auth = inject(AuthState);
    return new CallableClient({
      call: (name, data) => auth.api.call(name, data),
      refreshClaims: () => auth.refreshClaims(),
    });
  },
});
