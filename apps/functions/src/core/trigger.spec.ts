import type { Firestore } from 'firebase-admin/firestore';

import type { LogSink } from './log';
import { runTrigger, type TriggerDeps } from './trigger';
import { FakeClock, fakePorts } from '../ports/fakes';

function setup() {
  const guards = new Set<string>();
  const logs: { message: string; entry: Record<string, unknown> }[] = [];
  const sink: LogSink = (_severity, message, entry) => logs.push({ message, entry });
  const db = {
    doc: (path: string) => ({
      create: async () => {
        if (guards.has(path)) throw Object.assign(new Error('exists'), { code: 6 });
        guards.add(path);
      },
    }),
  } as unknown as Firestore;
  const deps: TriggerDeps = { db: () => db, clock: new FakeClock(), ports: () => fakePorts(), sink };
  return { deps, logs, guards };
}

const event = (id: string) => ({
  id,
  params: { orgId: 'org-a', matterId: 'm1' },
  change: { before: undefined, after: undefined },
});

describe('runTrigger', () => {
  it('runs a handler once per event id', async () => {
    const { deps } = setup();
    const handler = vi.fn();
    const def = {
      name: 'matters-onWrite',
      document: 'orgs/{orgId}/matters/{matterId}',
      on: 'written' as const,
      handler,
    };
    expect(await runTrigger(def, event('e1'), deps)).toBe('ran');
    expect(await runTrigger(def, event('e1'), deps)).toBe('duplicate');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ eventId: 'e1', params: { orgId: 'org-a' } });
  });

  it('runs every trigger on the same write: they share its event id', async () => {
    const { deps, guards } = setup();
    const handler = vi.fn();
    const on = (name: string) => ({
      name,
      document: 'orgs/{orgId}/matters/{matterId}',
      on: 'written' as const,
      handler,
    });
    expect(await runTrigger(on('audit-onMatterWrite'), event('e4'), deps)).toBe('ran');
    expect(await runTrigger(on('documents-onIngestChange'), event('e4'), deps)).toBe('ran');
    expect(await runTrigger(on('documents-onIngestChange'), event('e4'), deps)).toBe('duplicate');
    expect(handler).toHaveBeenCalledTimes(2);
    expect([...guards]).toEqual(['eventGuards/audit-onMatterWrite-e4', 'eventGuards/documents-onIngestChange-e4']);
  });

  it('passes the event time, or the clock when the event has none', async () => {
    const { deps } = setup();
    const handler = vi.fn();
    const def = { name: 'x-onWrite', document: 'a/{b}', on: 'written' as const, handler };
    await runTrigger(def, { ...event('t1'), time: '2026-10-04T01:02:03.000Z' }, deps);
    await runTrigger(def, event('t2'), deps);
    expect(handler.mock.calls[0]?.[1].time).toEqual(new Date('2026-10-04T01:02:03.000Z'));
    expect(handler.mock.calls[1]?.[1].time).toEqual(deps.clock.now());
  });

  it('logs a failure as a dead letter with ids only, and does not rethrow', async () => {
    const { deps, logs } = setup();
    const def = {
      name: 'matters-onWrite',
      document: 'orgs/{orgId}/matters/{matterId}',
      on: 'written' as const,
      handler: () => {
        throw new Error('Failed for Margaret Whitfield');
      },
    };
    expect(await runTrigger(def, event('e2'), deps)).toBe('failed');
    const dead = logs.find((l) => l.message === 'dead-letter');
    expect(dead?.entry).toMatchObject({
      deadLetter: true,
      eventId: 'e2',
      params: { matterId: 'm1' },
      errorType: 'Error',
    });
    expect(JSON.stringify(logs)).not.toContain('Whitfield');
  });

  it('rethrows unexpected guard errors', async () => {
    const { deps } = setup();
    const broken = {
      ...deps,
      db: () => ({ doc: () => ({ create: async () => Promise.reject(new Error('down')) }) }) as unknown as Firestore,
    };
    await expect(
      runTrigger({ name: 'x', document: 'a/{b}', on: 'created', handler: vi.fn() }, event('e3'), broken),
    ).rejects.toThrow('down');
  });
});

describe('defineTrigger and toChange', () => {
  const snap = (exists: boolean) => ({ exists }) as never;

  it('maps each event kind to before/after', async () => {
    const { toChange } = await import('./trigger');
    expect(toChange('created', snap(true))).toEqual({ before: undefined, after: snap(true) });
    expect(toChange('deleted', snap(true))).toEqual({ before: snap(true), after: undefined });
    expect(toChange('written', { before: snap(false), after: snap(true) } as never)).toEqual({
      before: undefined,
      after: snap(true),
    });
    expect(toChange('updated', { before: snap(true), after: snap(true) } as never)).toEqual({
      before: snap(true),
      after: snap(true),
    });
    expect(toChange('written', undefined)).toEqual({ before: undefined, after: undefined });
  });

  it('builds a v2 Firestore function for each kind', async () => {
    const { defineTrigger } = await import('./trigger');
    for (const on of ['written', 'created', 'updated', 'deleted'] as const) {
      const fn = defineTrigger({ name: `t-${on}`, document: 'orgs/{orgId}/matters/{matterId}', on, handler: vi.fn() });
      expect(typeof fn).toBe('function');
    }
  });
});
