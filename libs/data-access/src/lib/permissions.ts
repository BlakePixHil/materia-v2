import { computed, inject, type Signal } from '@angular/core';

import { can as allowed, type Action, type PermissionResource } from '@materia/domain';

import { OrgContext } from './org-context';

/**
 * `can('matter.close')`: whether the current role may do something, as a signal (FND-19). Wraps
 * the `libs/domain` matrix (ADR-005) with the role from `OrgContext`; signed out or without an
 * org it's false. Pass the resource (or a function of signals returning it) for privileged
 * material. Call it in an injection context. Hiding a control is a courtesy; the rules and
 * callables enforce the same matrix.
 */
export function can(action: Action, resource?: PermissionResource | (() => PermissionResource)): Signal<boolean> {
  const context = inject(OrgContext);
  return computed(() => {
    const role = context.role();
    if (!role) return false;
    return allowed(role, action, typeof resource === 'function' ? resource() : resource);
  });
}
