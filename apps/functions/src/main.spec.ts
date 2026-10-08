import { READ_ONLY_CALLABLES } from './core/read-only';
import { runtimeServiceAccount } from './global-options';
import * as main from './main';

interface EndpointLike {
  __endpoint: { serviceAccountEmail?: string | null; maxInstances?: number | null; callableTrigger?: object };
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

  it('every callable a practice waiting to be deleted still runs is a deployed callable (SEC-05)', () => {
    const callables = new Set(
      endpoints.filter(([, fn]) => fn.__endpoint.callableTrigger).map(([name]) => name.replace('.', '-')),
    );
    expect(callables).toContain('orgs-requestDeletion');
    expect([...READ_ONLY_CALLABLES].filter((name) => !callables.has(name))).toEqual([]);
  });
});

describe('the Clerk reply queue (SEC-07g)', () => {
  it('runs 80 answers at once, 20 an instance, within the global instance cap', () => {
    const endpoint = (
      main.clerk.runMessage as unknown as {
        __endpoint: {
          concurrency?: number;
          maxInstances?: number;
          taskQueueTrigger: { rateLimits?: { maxConcurrentDispatches?: number } };
        };
      }
    ).__endpoint;
    expect(endpoint.taskQueueTrigger.rateLimits?.maxConcurrentDispatches).toBe(80);
    expect(endpoint.concurrency).toBe(20);
    // Instances are never what holds answers back: the queue's 80 need 4 of them.
    expect((endpoint.maxInstances ?? 0) * (endpoint.concurrency ?? 0)).toBeGreaterThanOrEqual(80);
  });
});

describe('runtimeServiceAccount', () => {
  it('uses the full email once the project is known', () => {
    expect(runtimeServiceAccount('materia-v2-dev')).toBe('fn-runtime@materia-v2-dev.iam.gserviceaccount.com');
  });

  it('keeps the short form without a project', () => {
    expect(runtimeServiceAccount(undefined)).toBe('fn-runtime@');
  });
});
