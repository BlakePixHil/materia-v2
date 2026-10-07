import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { OrgContext, TENANCY_PORT, type SessionSecurity } from '@materia/data-access';
import { resolveSecurity, type OrgSecurity } from '@materia/domain';
import { DialogService } from '@materia/ui';

import { AUTH_PORT, type AuthSession } from './auth-port';
import { AuthState } from './auth-state';
import { mfaGuard } from './guards';
import { ActivityHolds, IDLE_BROADCAST, IDLE_CHANNEL, IdleTimeout } from './idle-timeout';
import { forgetCachedSession, readCachedSecurity, saveCachedSecurity } from './session-cache';
import { POLICY_WAIT_MS, SESSION_NOW, SessionPolicy } from './session-policy';
import { FakeAuthPort, testSession } from './testing';
import { FakeTenancyPort } from '../orgs/testing';

const NOW = new Date('2026-10-06T00:00:00.000Z').getTime();
const MINUTE = 60_000;
const DAY = 86_400_000;

/** BroadcastChannels that reach each other in this process, as tabs' would. */
class FakeChannels {
  private readonly open = new Set<FakeChannel>();
  readonly sent: unknown[] = [];

  create = (name: string): BroadcastChannel => new FakeChannel(name, this) as unknown as BroadcastChannel;

  add(channel: FakeChannel): void {
    this.open.add(channel);
  }

  remove(channel: FakeChannel): void {
    this.open.delete(channel);
  }

  deliver(from: FakeChannel | null, data: unknown): void {
    this.sent.push(data);
    for (const channel of this.open) {
      if (channel !== from) channel.onmessage?.({ data } as MessageEvent);
    }
  }
}

class FakeChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(
    readonly name: string,
    private readonly hub: FakeChannels,
  ) {
    hub.add(this);
  }
  postMessage(data: unknown): void {
    this.hub.deliver(this, data);
  }
  close(): void {
    this.hub.remove(this);
  }
}

interface Setup {
  session?: AuthSession;
  /** Starts from the cached session (MAT-177), as a returning person's tab does. */
  cached?: boolean;
  security?: Partial<OrgSecurity> | null;
  validAfter?: Date | null;
}

function security(raw: Partial<OrgSecurity> | null, validAfter: Date | null = null): SessionSecurity | null {
  if (raw === null) return null;
  return { policy: resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60, ...raw }), validAfter };
}

function setup(options: Setup = {}) {
  const clock = { now: NOW };
  const auth = new FakeAuthPort(options.session ?? testSession({ authTime: NOW - MINUTE }));
  if (options.cached) auth.cached = auth.session;
  const tenancy = new FakeTenancyPort();
  tenancy.security_ = options.security === undefined ? undefined : security(options.security, options.validAfter);
  const channels = new FakeChannels();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AUTH_PORT, useValue: auth },
      { provide: SESSION_NOW, useValue: () => clock.now },
      { provide: IDLE_BROADCAST, useValue: channels.create },
      { provide: TENANCY_PORT, useValue: tenancy },
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const state = TestBed.inject(AuthState);
  const context = TestBed.inject(OrgContext);
  const policy = TestBed.inject(SessionPolicy);
  const signIn = (session: AuthSession | null) =>
    context.setSession(session ? { uid: session.uid, orgId: session.claims.orgId ?? null, role: null } : null);
  return { clock, auth, tenancy, channels, router, navigate, state, context, policy, signIn };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('SessionPolicy (SEC-04)', () => {
  it('requires MFA once the grace period is over, and shows the deadline until then', async () => {
    const enforceAfter = new Date(NOW + DAY);
    const t = setup({ security: { mfaRequired: true, mfaEnforceAfter: enforceAfter } });
    await settle();
    t.signIn(t.auth.session);
    await settle();
    expect(t.policy.mfaEnforced()).toBe(false);
    expect(t.policy.mfaGraceUntil()).toEqual(enforceAfter);
    expect(t.state.mfaRequired()).toBe(false);

    t.tenancy.emitSecurity(security({ mfaRequired: true, mfaEnforceAfter: new Date(NOW - 1) }));
    await settle();
    expect(t.policy.mfaEnforced()).toBe(true);
    expect(t.policy.mfaGraceUntil()).toBeNull();
    expect(t.state.mfaRequired()).toBe(true);
    // Mid-session, so the guards won't run: straight to set-up.
    expect(t.navigate).toHaveBeenCalledWith('/auth/mfa/enrol');
  });

  it('makes the MFA guard wait for the policy, then send a member without MFA to set it up', async () => {
    const t = setup();
    await settle();
    t.signIn(t.auth.session);
    await settle();
    const decision = TestBed.runInInjectionContext(() => mfaGuard({} as never, { url: '/today' } as never));
    t.tenancy.emitSecurity(security({ mfaRequired: true }));
    const result = await (decision as Promise<unknown>);
    expect(String(result)).toContain('/auth/mfa/enrol');
  });

  it('decides from the policy this device saw last until the live one arrives (MAT-177)', async () => {
    const enforced: SessionSecurity = {
      policy: resolveSecurity({ mfaRequired: true, sessionIdleMinutes: 60, mfaEnforceAfter: new Date(NOW - 1) }),
      validAfter: null,
    };
    saveCachedSecurity('user-jordan', 'org-harbour-vine', enforced);
    try {
      const t = setup({ cached: true });
      await settle();
      const decision = await TestBed.runInInjectionContext(() => mfaGuard({} as never, { url: '/today' } as never));
      expect(String(decision)).toContain('/auth/mfa/enrol');

      t.tenancy.emitSecurity(security({}));
      await settle();
      expect(t.state.mfaRequired()).toBe(false);
      expect(readCachedSecurity('user-jordan', 'org-harbour-vine')?.policy.mfaRequired).toBe(false);
    } finally {
      forgetCachedSession();
    }
  });

  it('lets the guards go on when the policy never arrives', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.signIn(t.auth.session);
      TestBed.tick();
      let done = false;
      void t.policy.whenLoaded().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(POLICY_WAIT_MS);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['revoked', { validAfter: new Date(NOW) }, testSession({ authTime: NOW - MINUTE })],
    ['expired', {}, testSession({ authTime: NOW - 15 * DAY })],
    [
      'mfa',
      { security: { mfaRequired: true } },
      testSession({ authTime: NOW, mfaEnrolled: true, secondFactor: false }),
    ],
  ] as const)('signs out a %s sign-in and says why', async (reason, extra, session) => {
    const t = setup({ session, security: {}, ...extra });
    await settle();
    t.signIn(t.auth.session);
    await settle();
    expect(t.navigate).toHaveBeenCalledWith(`/auth/signed-out?reason=${reason}`);
    expect(t.auth.session).toBeNull();
  });

  it('pauses the checks while this tab signs out everywhere else', async () => {
    const t = setup({ security: {} });
    await settle();
    t.signIn(t.auth.session);
    await settle();
    await t.policy.withChecksPaused(async () => {
      t.tenancy.emitSecurity(security({}, new Date(NOW)));
      await settle();
      expect(t.policy.endReason()).toBeNull();
      expect(t.navigate).not.toHaveBeenCalled();
    });
  });
});

describe('IdleTimeout (SEC-04)', () => {
  async function tabs() {
    const t = setup({ security: { sessionIdleMinutes: 15 } });
    const idle = TestBed.inject(IdleTimeout);
    const dialogs = TestBed.inject(DialogService);
    const open = vi.spyOn(dialogs, 'open');
    await settle();
    t.signIn(t.auth.session);
    await settle();
    // The other tab, as it would post on the shared channel.
    const other = t.channels.create(IDLE_CHANNEL);
    const received: unknown[] = [];
    other.onmessage = (event) => received.push(event.data);
    return { ...t, idle, open, other, received };
  }

  it('warns a minute before the limit and signs every tab out at it', async () => {
    const t = await tabs();
    t.clock.now += 14 * MINUTE;
    t.idle.tick();
    expect(t.idle.secondsLeft()).toBe(60);
    await vi.waitFor(() => expect(t.open).toHaveBeenCalledOnce());
    await settle();
    expect(document.body.querySelector('[data-idle-countdown]')?.textContent).toContain('60 seconds');

    t.clock.now += MINUTE;
    t.idle.tick();
    await settle();
    expect(t.received).toContainEqual({ type: 'idle-sign-out' });
    expect(t.navigate).toHaveBeenCalledWith('/auth/signed-out?reason=idle');
    expect(t.idle.secondsLeft()).toBeNull();
  });

  it('counts activity in any tab, and signs out when another tab did', async () => {
    const t = await tabs();
    t.clock.now += 10 * MINUTE;
    t.other.postMessage({ type: 'activity', at: t.clock.now });
    t.clock.now += 10 * MINUTE;
    t.idle.tick();
    expect(t.idle.secondsLeft()).toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown'));
    expect(t.received).toContainEqual({ type: 'activity', at: t.clock.now });

    t.other.postMessage({ type: 'idle-sign-out' });
    await settle();
    expect(t.navigate).toHaveBeenCalledWith('/auth/signed-out?reason=idle');
  });

  it('waits while an upload or recording runs', async () => {
    const t = await tabs();
    const release = TestBed.inject(ActivityHolds).hold();
    t.clock.now += 30 * MINUTE;
    t.idle.tick();
    expect(t.idle.secondsLeft()).toBeNull();
    release();
    t.clock.now += 14 * MINUTE + 30_000;
    t.idle.tick();
    expect(t.idle.secondsLeft()).toBe(30);
    t.idle.activity(t.clock.now);
    expect(t.idle.secondsLeft()).toBeNull();
    expect(t.navigate).not.toHaveBeenCalled();
  });
});
