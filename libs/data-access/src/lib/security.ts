import { inject } from '@angular/core';

import { SignIn } from '@materia/domain';

import { OrgContext } from './org-context';
import { repo, type Repository } from './repository';

/** A logged sign-in (`users/{uid}/signIns`, SEC-04). */
export type SignInItem = SignIn;

/**
 * The signed-in person's sign-in log, for "Your sessions" in Settings → Security (SEC-04).
 * Written by `auth-beforeSignIn` only; read-only here. Call it in an injection context.
 */
export function mySignInsRepository(): Repository<SignInItem> {
  const context = inject(OrgContext);
  return repo(() => `users/${context.uid() ?? '_'}/signIns`, SignIn);
}
