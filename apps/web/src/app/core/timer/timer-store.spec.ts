import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { Connectivity, OrgContext, type TimerState } from '@materia/data-access';
import { InMemoryTimerPort, provideInMemoryFirestore } from '@materia/data-access/repository';
import type { Role } from '@materia/domain';
import { DialogService, ToastService, type MtToastOptions } from '@materia/ui';

import { TIMER_IDLE_MS, TimerStore } from './timer-store';
import { CALLABLES } from '../data/callables';

/** The global timer's store (BILL-02): elapsed and skew, start, switch, pause, idle and forgotten. */

const ORG = 'org-harbour-vine';
const UID = 'user-jordan';
const MIN = 60_000;
/** The device's clock. */
const DEVICE = Date.parse('2026-10-06T00:00:00.000Z');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { skewMs?: number; online?: boolean; role?: Role } = {}) {
  let device = DEVICE;
  const skew = options.skewMs ?? 0;
  // The fake's clock is the server's: the device's plus the skew.
  const port = new InMemoryTimerPort(() => new Date(device + skew));
  const online = signal(options.online ?? true);
  const shown: MtToastOptions[] = [];
  const answers: (string | undefined)[] = [];
  const opened: { title: string | undefined }[] = [];
  const calls: { name: string; data: unknown }[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideInMemoryFirestore(undefined, port),
      { provide: Connectivity, useValue: { online } },
      { provide: TIMER_IDLE_MS, useValue: 15 * MIN },
      { provide: ToastService, useValue: { show: (o: MtToastOptions) => void shown.push(o) } },
      {
        provide: CALLABLES,
        useValue: {
          call: async (name: string, data: unknown) => {
            calls.push({ name, data });
            await port.discard(UID);
            return { matterId: 'm-1', entryIds: ['e-1'], minutes: 24 };
          },
        },
      },
      {
        provide: DialogService,
        useValue: {
          open: (_component: unknown, config?: { data?: { title?: string } }) => {
            opened.push({ title: config?.data?.title });
            return { result: Promise.resolve(answers.shift()) };
          },
        },
      },
    ],
  });
  TestBed.inject(OrgContext).setSession({ uid: UID, orgId: ORG, role: options.role ?? 'lawyer' });
  const store = TestBed.inject(TimerStore);
  store.now = () => device;
  const tick = async () => {
    for (let i = 0; i < 3; i++) {
      await settle();
      TestBed.tick();
    }
  };
  const advance = (ms: number) => (device += ms);
  return { store, port, online, shown, answers, opened, calls, tick, advance };
}

const timer = (extra: Partial<TimerState> = {}): TimerState => ({
  orgId: ORG,
  matterId: 'm-1',
  matterNumber: 'M-2026-0001',
  startedAt: new Date(DEVICE),
  accumulatedMs: 0,
  running: true,
  narrativeDraft: '',
  lastHeartbeatAt: new Date(DEVICE),
  clientStarted: false,
  ...extra,
});

describe('TimerStore', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts a timer, counts the elapsed time, pauses and resumes', async () => {
    const { store, port, tick, advance } = setup();
    await tick();
    await store.start({ matterId: 'm-1', matterNumber: 'M-2026-0001', taskId: 't-1' });
    await tick();
    expect(store.timer()).toMatchObject({ matterId: 'm-1', taskId: 't-1', running: true });

    advance(7 * MIN + 5000);
    store.pause();
    await tick();
    expect(port.get(UID)).toMatchObject({ running: false, accumulatedMs: 7 * MIN + 5000 });
    expect(store.elapsedMs()).toBe(7 * MIN + 5000);

    advance(60 * MIN); // paused: nothing counts
    store.resume();
    await tick();
    advance(3 * MIN);
    store.toggle(null); // Shift+T pauses
    await tick();
    expect(port.get(UID)?.accumulatedMs).toBe(10 * MIN + 5000);
    store.toggle({ matterId: 'm-1', matterNumber: 'M-2026-0001' }); // and resumes
    await tick();
    expect(store.running()).toBe(true);
  });

  it('measures the device clock against the server’s, so elapsed time is the server’s', async () => {
    // The device is 5 minutes slow; the timer started on another device 30 (server) minutes ago.
    const { store, port, tick } = setup({ skewMs: 5 * MIN });
    port.seed(UID, timer({ startedAt: new Date(DEVICE + 5 * MIN - 30 * MIN) }));
    await tick();
    // The load heartbeat came back with the server's time.
    await tick();
    expect(store.offsetMs()).toBe(5 * MIN);
    expect(store.elapsedMs()).toBe(30 * MIN);
    expect(store.serverNow()).toBe(DEVICE + 5 * MIN);
  });

  it('asks before replacing a running timer: discard, then start on the new matter', async () => {
    const { store, port, tick, answers, opened, advance } = setup();
    port.seed(UID, timer());
    await tick();
    advance(24 * MIN);
    answers.push('discard');
    await store.start({ matterId: 'm-2', matterNumber: 'M-2026-0002' });
    await tick();
    expect(opened[0]?.title).toBe('Stop and save M-2026-0001 (0.4)?');
    expect(store.timer()).toMatchObject({ matterId: 'm-2', accumulatedMs: 0 });
    expect(port.writes.map((w) => w.op)).toContain('discard');
  });

  it('or stops and saves it first, with its narrative', async () => {
    const { store, port, tick, answers, calls } = setup();
    port.seed(UID, timer({ narrativeDraft: 'Drafted letter' }));
    await tick();
    answers.push('save');
    await store.start({ matterId: 'm-2', matterNumber: 'M-2026-0002' });
    await tick();
    expect(calls).toEqual([
      { name: 'time-stopTimer', data: expect.objectContaining({ narrative: 'Drafted letter', split: false }) },
    ]);
    expect(store.timer()?.matterId).toBe('m-2');
  });

  it('keeps the running timer when the question is cancelled', async () => {
    const { store, port, tick } = setup();
    port.seed(UID, timer());
    await tick();
    await store.start({ matterId: 'm-2', matterNumber: 'M-2026-0002' });
    await tick();
    expect(store.timer()?.matterId).toBe('m-1');
  });

  it('refuses a role that can’t record time', async () => {
    const { store, port, tick, shown } = setup({ role: 'readonly' });
    await tick();
    expect(store.canRecord()).toBe(false);
    await store.start({ matterId: 'm-1', matterNumber: 'M-2026-0001' });
    expect(port.get(UID)).toBeNull();
    expect(shown[0]?.title).toContain('can’t record time');
  });

  it('starts offline on the device clock, and flags it for review when the clock was over 2 minutes out', async () => {
    const { store, port, tick } = setup({ online: false, skewMs: 3 * MIN });
    await tick();
    await store.start({ matterId: 'm-1', matterNumber: 'M-2026-0001' });
    await tick();
    expect(port.get(UID)).toMatchObject({ clientStarted: true, startedAt: new Date(DEVICE), needsReview: true });
  });

  it('doesn’t flag an offline start when the clock was close', async () => {
    const { store, port, tick } = setup({ online: false, skewMs: 30_000 });
    await tick();
    await store.start({ matterId: 'm-1', matterNumber: 'M-2026-0001' });
    await tick();
    expect(port.get(UID)?.needsReview).toBe(false);
  });

  it('idle time: discard it and carry on from now', async () => {
    const { store, port, tick, answers, opened, advance } = setup();
    port.seed(UID, timer());
    await tick();
    advance(40 * MIN);
    answers.push('discard');
    await store.idle(DEVICE + 20 * MIN);
    await tick();
    expect(opened[0]?.title).toMatch(/^You were idle from /);
    expect(port.get(UID)).toMatchObject({
      running: true,
      accumulatedMs: 20 * MIN,
      startedAt: new Date(DEVICE + 40 * MIN),
    });
    advance(MIN);
    expect(timerOf(store)).toBe(21 * MIN);
  });

  it('idle time: stop at the time it began, then open the save dialog', async () => {
    const { store, port, tick, answers, opened, advance } = setup();
    port.seed(UID, timer());
    await tick();
    advance(40 * MIN);
    answers.push('stop');
    await store.idle(DEVICE + 20 * MIN);
    await tick();
    expect(port.get(UID)).toMatchObject({ running: false, accumulatedMs: 20 * MIN });
    expect(opened).toHaveLength(2); // the question, then the save dialog
  });

  it('idle time: keep it', async () => {
    const { store, port, tick, answers, advance } = setup();
    port.seed(UID, timer());
    await tick();
    advance(40 * MIN);
    answers.push('keep');
    await store.idle(DEVICE + 20 * MIN);
    await tick();
    expect(port.get(UID)).toMatchObject({ running: true, accumulatedMs: 0 });
  });

  it('shows a forgotten timer until “Keep it running”', async () => {
    const { store, port, tick } = setup();
    port.seed(UID, timer({ forgotten: { reason: 'long', at: new Date(DEVICE) } }));
    await tick();
    expect(store.forgotten()?.reason).toBe('long');
    store.dismissForgotten();
    await tick();
    expect(store.forgotten()).toBeNull();
  });

  it('keeps the narrative and discards', async () => {
    const { store, port, tick } = setup();
    port.seed(UID, timer());
    await tick();
    store.saveNarrative('Call with client');
    await tick();
    expect(port.get(UID)?.narrativeDraft).toBe('Call with client');
    await store.discard();
    await tick();
    expect(store.timer()).toBeNull();
  });
});

function timerOf(store: TimerStore): number {
  const t = store.timer();
  return t ? (t.running && t.startedAt ? t.accumulatedMs + store.now() - t.startedAt.getTime() : t.accumulatedMs) : 0;
}
