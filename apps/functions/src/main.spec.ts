import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Every function whose own code calls `ports.mail.send`, by source file. A function reads only the
 * secrets it declares, so one that sends without declaring RESEND_API_KEY records every email as
 * `not_configured` even once the key is set (invites, invoices and deletion certificates did).
 */
const MAIL_SENDERS: Record<string, string[]> = {
  'billing/reminders.ts': ['billing.sendReminder'],
  'billing/send.ts': ['billing.sendInvoice'],
  'notifications/deliver.ts': ['notifications.deliver'],
  'notifications/digest.ts': ['notifications.digest'],
  'notifications/weekly-report.ts': ['notifications.weeklyReport'],
  'orgs/invites.ts': ['orgs.inviteMember', 'orgs.resendInvite'],
  'orgs/purge.ts': ['orgs.purge'],
};

describe('functions that send email (FND-20)', () => {
  const endpoints = new Map(collect(main as Record<string, unknown>));

  it('lists every source file that sends email itself', () => {
    const src = dirname(fileURLToPath(import.meta.url));
    const senders = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .filter((file) => /\.mail\.send\(/.test(readFileSync(join(src, file), 'utf8')))
      .map((file) => file.split(sep).join('/'))
      .sort();
    expect(senders).toEqual(Object.keys(MAIL_SENDERS).sort());
  });

  it.each(Object.values(MAIL_SENDERS).flat())('%s declares RESEND_API_KEY', (name) => {
    const endpoint = endpoints.get(name) as unknown as
      { __endpoint: { secretEnvironmentVariables?: { key: string }[] } } | undefined;
    expect(endpoint).toBeDefined();
    expect(endpoint?.__endpoint.secretEnvironmentVariables?.map((secret) => secret.key)).toContain('RESEND_API_KEY');
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
