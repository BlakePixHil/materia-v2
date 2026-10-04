import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { ToastService } from '@materia/ui';

import { AUTH_PORT } from './auth-port';
import { AuthState, SIGN_OUT_CLEANUP } from './auth-state';
import { ACCESS_REVOKED_SETTLE_MS, accessRevokedHandler, SessionWatcher } from './session-watcher';
import { FakeAuthPort, testSession } from './testing';
import { PAGE_LOAD } from '../orgs/org-service';

function setup() {
  const port = new FakeAuthPort();
  const cleanup = vi.fn();
  const load = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AUTH_PORT, useValue: port },
      { provide: SIGN_OUT_CLEANUP, useValue: [cleanup] },
      { provide: PAGE_LOAD, useValue: load },
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const toast = vi.spyOn(TestBed.inject(ToastService), 'show');
  const auth = TestBed.inject(AuthState);
  TestBed.inject(SessionWatcher);
  return { port, auth, cleanup, load, navigate, toast };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
}

describe('SessionWatcher', () => {
  it('cleans up and goes to sign-in when another tab signs out', async () => {
    const { port, cleanup, navigate, toast } = setup();
    await settle();
    port.emit(null);
    await settle();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/auth/sign-in');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'You signed out in another tab' }));
  });

  it('leaves a sign-out from this tab to the shell', async () => {
    const { auth, cleanup, navigate, toast } = setup();
    await settle();
    await auth.signOut();
    await settle();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('reloads on Today when someone else signs in from another tab', async () => {
    const { port, load } = setup();
    await settle();
    port.emit(testSession({ uid: 'someone-else' }));
    await settle();
    expect(load).toHaveBeenCalledWith('/today');
  });
});

describe('accessRevokedHandler', () => {
  afterEach(() => vi.useRealTimers());

  it('goes to no-access once, unless the session ended meanwhile', async () => {
    const { port, navigate } = setup();
    await settle();
    vi.useFakeTimers();
    const handle = TestBed.runInInjectionContext(accessRevokedHandler);
    handle(new Error('refused') as never);
    handle(new Error('refused') as never);
    vi.advanceTimersByTime(ACCESS_REVOKED_SETTLE_MS);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/no-access');

    navigate.mockClear();
    handle(new Error('refused') as never);
    port.emit(null);
    vi.advanceTimersByTime(ACCESS_REVOKED_SETTLE_MS);
    expect(navigate).not.toHaveBeenCalledWith('/no-access');
  });
});
