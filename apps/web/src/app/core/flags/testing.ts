import type { Provider } from '@angular/core';

import type { FlagValue } from '@materia/domain';

import { FLAG_SOURCE, type FlagValueSource } from './feature-flags';

/** A flag source for tests: fixed Remote Config values and per-org overrides. */
export function fakeFlagSource(
  remote: Record<string, FlagValue> = {},
  orgs: Record<string, Record<string, unknown>> = {},
): FlagValueSource {
  return { remote: async () => remote, org: async (orgId) => orgs[orgId] ?? {} };
}

export function provideTestFlags(
  remote: Record<string, FlagValue> = {},
  orgs: Record<string, Record<string, unknown>> = {},
): Provider[] {
  return [{ provide: FLAG_SOURCE, useValue: fakeFlagSource(remote, orgs) }];
}
