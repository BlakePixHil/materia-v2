/**
 * Version of the deadline engine (ADR-009). Every computed deadline records it alongside the
 * rule-set version. CORE-09 builds the engine and the Victorian rule set.
 */
export const ENGINE_VERSION = '0.0.0';

// FND-04 demo (reverted): a type error that only `typecheck` should catch. Nothing that `build`
// bundles imports this lib, so build stays green and e2e can run.
export const DEMO_TYPE_ERROR: number = 'not a number' as unknown as string;
