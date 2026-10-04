import * as main from './main';

interface EndpointLike {
  __endpoint: { serviceAccountEmail?: string | null; maxInstances?: number | null };
}

const isFunction = (value: unknown): value is EndpointLike => typeof value === 'function' && '__endpoint' in value;

function collect(group: Record<string, unknown>, prefix = ''): [string, EndpointLike][] {
  return Object.entries(group).flatMap(([name, value]) =>
    isFunction(value)
      ? [[`${prefix}${name}`, value] as [string, EndpointLike]]
      : value && typeof value === 'object'
        ? collect(value as Record<string, unknown>, `${prefix}${name}.`)
        : [],
  );
}

describe('functions entry point', () => {
  const endpoints = collect(main as Record<string, unknown>);

  it('exports functions', () => {
    expect(endpoints.length).toBeGreaterThan(0);
  });

  // Regression: global options set after the exports are evaluated reach no function, so deploys
  // fall back to the default service account and fail on iam.serviceAccounts.ActAs.
  it.each(endpoints)('%s runs as fn-runtime with the global instance cap', (_name, fn) => {
    expect(fn.__endpoint.serviceAccountEmail).toBe('fn-runtime@');
    expect(fn.__endpoint.maxInstances).toBe(10);
  });
});
