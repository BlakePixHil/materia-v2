import { TestBed } from '@angular/core/testing';
import { SwUpdate, type UnrecoverableStateEvent, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';

import { DataLifecycle } from '@materia/data-access';
import { CLIENT_COMPAT_VERSION } from '@materia/domain';
import { DialogService, ToastService } from '@materia/ui';

import { AppUpdates, FIRST_CHECK_MS, PAGE_RELOAD, UPDATE_CHECK_MS, UPDATE_COPY } from './app-updates';
import { CALLABLES } from '../data/callables';

/** A BroadcastChannel that delivers between instances in this test, like tabs of one origin. */
class FakeChannel {
  static open: FakeChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  constructor(readonly name: string) {
    FakeChannel.open.push(this);
  }
  postMessage(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
  }
}

const READY: VersionEvent = {
  type: 'VERSION_READY',
  currentVersion: { hash: 'v1' },
  latestVersion: { hash: 'v2' },
};

function setup(options: { enabled?: boolean; minClientVersion?: number; unsynced?: boolean; confirm?: boolean } = {}) {
  const versionUpdates = new Subject<VersionEvent>();
  const unrecoverable = new Subject<UnrecoverableStateEvent>();
  const sw = {
    isEnabled: options.enabled ?? true,
    versionUpdates,
    unrecoverable,
    checkForUpdate: vi.fn(async () => false),
    activateUpdate: vi.fn(async () => true),
  };
  const call = vi.fn(async () => ({ ok: true, minClientVersion: options.minClientVersion ?? CLIENT_COMPAT_VERSION }));
  const reload = vi.fn();
  const waitForSync = vi.fn(async () => undefined);
  TestBed.configureTestingModule({
    providers: [
      { provide: SwUpdate, useValue: sw },
      { provide: CALLABLES, useValue: { call } },
      { provide: PAGE_RELOAD, useValue: reload },
      {
        provide: DataLifecycle,
        useValue: { hasUnsyncedChanges: async () => options.unsynced ?? false, waitForSync },
      },
    ],
  });
  const toasts = TestBed.inject(ToastService);
  const show = vi.spyOn(toasts, 'show');
  const confirm = vi.spyOn(TestBed.inject(DialogService), 'confirm').mockResolvedValue(options.confirm ?? true);
  const updates = TestBed.inject(AppUpdates);
  return { sw, versionUpdates, unrecoverable, call, reload, waitForSync, show, confirm, updates };
}

describe('AppUpdates', () => {
  beforeEach(() => {
    FakeChannel.open = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('offers a reload once a new version is ready, and reloads every tab into it', async () => {
    const { versionUpdates, show, sw, reload, updates } = setup();
    updates.start();
    versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'v2' } });
    expect(show).not.toHaveBeenCalled();
    versionUpdates.next(READY);
    versionUpdates.next(READY);
    expect(show).toHaveBeenCalledOnce();
    const toast = show.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ title: UPDATE_COPY.ready, duration: 0, action: { label: 'Reload' } });

    toast?.action?.run();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(sw.activateUpdate).toHaveBeenCalledOnce();
    expect(FakeChannel.open[0]?.sent).toEqual([{ type: 'reload' }]);
  });

  it('reloads when another tab does, without telling the others again', async () => {
    const { reload, updates } = setup();
    updates.start();
    const channel = FakeChannel.open[0];
    channel?.onmessage?.(new MessageEvent('message', { data: { type: 'reload' } }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(channel?.sent).toEqual([]);
  });

  it('waits for offline edits to sync before reloading', async () => {
    const { reload, waitForSync, updates } = setup({ unsynced: true });
    await updates.reload();
    expect(waitForSync).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('checks once the app has settled, then every 30 minutes while the page is visible', async () => {
    vi.useFakeTimers();
    const { sw, call, updates } = setup();
    updates.start();
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(sw.checkForUpdate).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('system-ping', {});
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('skips a check while offline', async () => {
    const { sw, call, updates } = setup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await updates.check();
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('still checks the API without a service worker', async () => {
    const { sw, call, updates } = setup({ enabled: false });
    updates.start();
    await updates.check();
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledOnce();
  });

  it('asks for a reload when the API has moved past this build', async () => {
    const { confirm, reload, updates } = setup({ minClientVersion: CLIENT_COMPAT_VERSION + 1 });
    await updates.check();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: UPDATE_COPY.compatTitle, confirmLabel: 'Reload now' }),
    );
    expect(reload).toHaveBeenCalledOnce();
    // Asked once: the next check doesn't ask again.
    await updates.check();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('leaves a reload toast for someone saving their work first', async () => {
    const { show, reload, updates } = setup({ minClientVersion: CLIENT_COMPAT_VERSION + 1, confirm: false });
    await updates.check();
    expect(reload).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ title: UPDATE_COPY.compatToast, duration: 0, action: expect.anything() }),
    );
  });

  it('says nothing while the API accepts this build', async () => {
    const { confirm, updates } = setup({ minClientVersion: CLIENT_COMPAT_VERSION });
    await updates.check();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('unregisters a broken service worker and reloads', async () => {
    const unregister = vi.fn(async () => true);
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
      serviceWorker: { getRegistrations: async () => [{ unregister }] },
    });
    const { unrecoverable, reload, updates } = setup();
    updates.start();
    unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'Hash mismatch' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(unregister).toHaveBeenCalledOnce();
  });
});
