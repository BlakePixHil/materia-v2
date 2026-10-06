import { FIXTURE_DIR, FIXTURE_UIDS } from '../legacy/fixtures.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { Warnings, type TransformContext, type WarningCode } from './context.ts';

/**
 * Shared set-up for the transform's unit specs (MIG-03): the fixture mapping profile and a fresh
 * TransformContext per test, plus the warnings it collected. Fictional data only.
 */

export const SPEC_AS_OF = new Date('2026-10-06T21:00:00.123Z');
export const SPEC_PROFILE = `${FIXTURE_DIR}mapping-profile.json`;

/** The fixture profile (`fixtures/legacy/mapping-profile.json`), parsed afresh. */
export function loadSpecProfile(): Promise<MappingProfile> {
  return loadProfile(SPEC_PROFILE);
}

/** A context for one test: a new warnings collector, the fixture subject and org, and any overrides. */
export function specContext(profile: MappingProfile, over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: FIXTURE_UIDS.subject,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: SPEC_AS_OF,
    people: new Map(),
    members: new Set([FIXTURE_UIDS.subject]),
    warnings: new Warnings(),
    ...over,
  };
}

/** The warnings a context collected, by code, with their legacy paths (zero counts left out). */
export function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}
