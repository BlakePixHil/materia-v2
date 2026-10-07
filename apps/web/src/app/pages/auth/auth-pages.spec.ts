import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { authErrorMessage, safeReturnUrl } from './auth-flow';
import { groupSecret } from './mfa-enrol';
import { qrPath } from './qr-code';
import { passwordStrength } from './sign-up';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AuthFlowError, type AuthSession } from '../../core/auth/auth-port';
import { AUTH_PORT } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(url: string, session: AuthSession | null, configure?: (port: FakeAuthPort) => void) {
  const port = new FakeAuthPort(session);
  configure?.(port);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: port },
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle();
  };
  const field = (label: string) => {
    const host = [...el.querySelectorAll('mt-text-field')].find((f) =>
      f.querySelector('label')?.textContent?.trim().startsWith(label),
    );
    const input = host?.querySelector('input');
    if (!input) throw new Error(`No field "${label}"`);
    return input;
  };
  const type = async (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await stable();
  };
  const button = (text: string) => {
    const found = [...el.querySelectorAll<HTMLElement>('button, a')].find((b) =>
      b.textContent?.trim().startsWith(text),
    );
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  const click = async (text: string) => {
    button(text).click();
    await stable();
  };
  const submit = async () => {
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await stable();
  };
  return {
    port,
    router,
    el,
    type,
    click,
    submit,
    button,
    stable,
    text: () => el.textContent?.replace(/\s+/g, ' ') ?? '',
  };
}

describe('helpers', () => {
  it('rates passwords by length', () => {
    expect(passwordStrength('')).toEqual({ level: 0, label: 'At least 12 characters' });
    expect(passwordStrength('short').level).toBe(1);
    expect(passwordStrength('twelve-chars').label).toBe('OK');
    expect(passwordStrength('sixteen-chars-ok').label).toBe('Good');
    expect(passwordStrength('a much longer passphrase').label).toBe('Strong');
  });

  it('groups secrets, draws QR paths and only returns to same-site paths', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(
      qrPath([
        [true, false],
        [false, true],
      ]),
    ).toBe('M0 0h1v1h-1zM1 1h1v1h-1z');
    expect(safeReturnUrl('/matters/1')).toBe('/matters/1');
    expect(safeReturnUrl('//evil.example')).toBeNull();
    expect(safeReturnUrl('https://evil.example')).toBeNull();
    expect(safeReturnUrl('/auth/sign-in')).toBeNull();
    expect(safeReturnUrl(null)).toBeNull();
  });

  it('turns failures into copy', () => {
    expect(authErrorMessage(new AuthFlowError('signup-closed'))).toContain('invitation only');
    expect(authErrorMessage({ details: { code: 'RATE_LIMITED' } })).toContain('Too many requests');
    expect(authErrorMessage(new Error('raw details'))).toBe('Something went wrong. Try again.');
  });
});

describe('sign in', () => {
  it('asks for the email, then the password, and lands on Today', async () => {
    const page = await open('/auth/sign-in', null);
    await page.type('Work email', 'lawyer@harbourvine.example');
    await page.submit();
    expect(page.text()).toContain('lawyer@harbourvine.example');
    await page.type('Password', 'wrong');
    await page.submit();
    expect(page.text()).toContain('That email and password don’t match');
    await page.type('Password', 'password');
    await page.submit();
    expect(page.router.url).toBe('/today');
    expect(page.port.persistence).toBe('local');
  });

  it('uses session persistence on a shared computer and honours returnUrl', async () => {
    const page = await open('/auth/sign-in?returnUrl=%2Fmatters', null);
    await page.type('Work email', 'lawyer@harbourvine.example');
    await page.submit();
    await page.type('Password', 'password');
    page.el.querySelector<HTMLButtonElement>('mt-checkbox button')?.click();
    await page.stable();
    await page.submit();
    expect(page.port.persistence).toBe('session');
    expect(page.router.url).toBe('/matters');
  });

  it('goes to the MFA challenge when the account has an authenticator', async () => {
    const page = await open('/auth/sign-in', null, (port) => (port.mfaOnSignIn = true));
    await page.type('Work email', 'lawyer@harbourvine.example');
    await page.submit();
    await page.type('Password', 'password');
    await page.submit();
    expect(page.router.url).toBe('/auth/mfa');
    await page.type('6-digit code', '000000');
    await page.submit();
    expect(page.text()).toContain('That code isn’t right');
    await page.type('6-digit code', '123 456');
    await page.submit();
    expect(page.router.url).toBe('/today');
  });

  it('offers linking when Google finds an existing password account', async () => {
    const page = await open('/auth/sign-in', null, (port) => {
      port.nextError = new AuthFlowError('account-exists', { email: 'lawyer@harbourvine.example' });
      port.pending = { email: 'lawyer@harbourvine.example', method: 'Google' };
    });
    await page.click('Continue with Google');
    expect(page.text()).toContain('Sign in with your password to link Google to it');
    expect(page.text()).toContain('lawyer@harbourvine.example');
    await page.type('Password', 'password');
    await page.submit();
    expect(page.router.url).toBe('/today');
  });

  it('signs in with Google and sends people without an org to onboarding', async () => {
    const page = await open('/auth/sign-in', null);
    page.port.signInWithGoogle = async () => {
      page.port.emit(testSession({ providerIds: ['google.com'], claims: {} }));
      return { kind: 'signedIn' };
    };
    await page.click('Continue with Google');
    expect(page.router.url).toBe('/onboarding');
  });

  it('after a recovery, sends the person to set up a new authenticator', async () => {
    const page = await open('/auth/sign-in?reenrol=1', null);
    expect(page.text()).toContain('Your authenticator was removed');
    await page.type('Work email', 'lawyer@harbourvine.example');
    await page.submit();
    await page.type('Password', 'password');
    await page.submit();
    expect(page.router.url).toBe('/auth/mfa/enrol');
  });
});

describe('sign up and verification', () => {
  it('shows strength, validates length and goes on to verify the email', async () => {
    const page = await open('/auth/sign-up?email=invited%40example.test', null);
    expect((page.el.querySelector('mt-text-field input[type="email"]') as HTMLInputElement).value).toBe(
      'invited@example.test',
    );
    await page.type('Full name', 'Alex Example');
    await page.type('Password', 'short');
    expect(page.text()).toContain('At least 12 characters');
    await page.submit();
    expect(page.router.url).toContain('/auth/sign-up');
    await page.type('Password', 'a much longer passphrase');
    expect(page.text()).toContain('Strong');
    await page.submit();
    expect(page.router.url).toBe('/auth/verify-email');
    expect(page.text()).toContain('invited@example.test');
  });

  it('explains invitation-only sign-up', async () => {
    const page = await open('/auth/sign-up', null, (port) => (port.nextError = new AuthFlowError('signup-closed')));
    await page.type('Full name', 'Alex Example');
    await page.type('Work email', 'stranger@example.test');
    await page.type('Password', 'a much longer passphrase');
    await page.submit();
    expect(page.text()).toContain('Sign-up is by invitation only');
  });

  it('checks verification and resends with a cooldown', async () => {
    const page = await open('/auth/verify-email', testSession({ emailVerified: false }));
    await page.click('I’ve confirmed my email');
    expect(page.text()).toContain('We haven’t seen the confirmation yet');
    await page.click('Send the link again');
    expect(page.text()).toContain('Sent. Check your inbox');
    expect(page.text()).toMatch(/Send again in \d+s/);
    page.port.session = testSession();
    await page.click('I’ve confirmed my email');
    expect(page.router.url).toBe('/today');
  });

  it('can switch to a different account', async () => {
    const page = await open('/auth/verify-email', testSession({ emailVerified: false }));
    await page.click('Use a different account');
    expect(page.router.url).toBe('/auth/sign-in');
  });
});

describe('passwords and email links', () => {
  it('sends a reset link without revealing whether the account exists', async () => {
    const page = await open('/auth/forgot-password', null);
    await page.type('Work email', 'anyone@example.test');
    await page.submit();
    expect(page.text()).toContain('If there’s an account for anyone@example.test');
  });

  it('confirms an email from the link', async () => {
    const page = await open('/auth/action?mode=verifyEmail&oobCode=verify-code', testSession({ emailVerified: false }));
    expect(page.text()).toContain('Email confirmed');
    await page.click('Continue');
    expect(page.router.url).toBe('/today');
  });

  it('sets a new password from the link', async () => {
    const page = await open('/auth/action?mode=resetPassword&oobCode=reset-code', null);
    expect(page.text()).toContain('For lawyer@harbourvine.example');
    await page.type('New password', 'a much longer passphrase');
    await page.submit();
    expect(page.text()).toContain('Password changed');
  });

  it('explains broken links', async () => {
    expect((await open('/auth/action?mode=resetPassword&oobCode=old', null)).text()).toContain('This link has expired');
    TestBed.resetTestingModule();
    expect((await open('/auth/action?mode=verifyEmail', null)).text()).toContain(
      'This link is incomplete or not supported',
    );
  });
});

describe('MFA enrolment and recovery', () => {
  it('scans, confirms, then shows recovery codes to save', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `CODE${i}-ABCDE`);
    const page = await open(
      '/auth/mfa/enrol',
      testSession(),
      (port) => (port.callResults['auth-generateRecoveryCodes'] = { codes }),
    );
    await page.stable();
    expect(page.text()).toContain('JBSW Y3DP EHPK 3PXP');
    expect(page.el.querySelector('mt-qr-code')).not.toBeNull();
    await page.type('6-digit code', '111111');
    await page.submit();
    expect(page.text()).toContain('That code isn’t right');
    await page.type('6-digit code', '123456');
    await page.submit();
    expect(page.el.querySelectorAll('ol[aria-label="Recovery codes"] li')).toHaveLength(10);
    expect((page.button('Continue') as HTMLButtonElement).disabled).toBe(true);
    page.el.querySelector<HTMLButtonElement>('mt-checkbox button')?.click();
    await page.stable();
    await page.click('Continue');
    expect(page.router.url).toBe('/today');
    expect(page.port.session?.mfaEnrolled).toBe(true);
  });

  it('asks for the password first when the sign-in is old', async () => {
    const page = await open('/auth/mfa/enrol', testSession({ authTime: Date.now() - 60 * 60_000 }));
    await page.stable();
    expect(page.text()).toContain('Confirm it’s you');
    await page.type('Password', 'nope');
    await page.submit();
    expect(page.text()).toContain('That email and password don’t match');
    await page.type('Password', 'password');
    await page.submit();
    expect(page.text()).toContain('Set up your authenticator');
    expect(page.port.popupsPrepared).toBe(0);
  });

  it('gets the Google pop-up ready when a Google account must sign in again', async () => {
    const page = await open(
      '/auth/mfa/enrol',
      testSession({ providerIds: ['google.com'], authTime: Date.now() - 60 * 60_000 }),
    );
    await page.stable();
    expect(page.text()).toContain('Sign in with Google again');
    expect(page.port.popupsPrepared).toBe(1);
  });

  it('uses a recovery code, signs out and asks to sign in again', async () => {
    const page = await open('/auth/recover', null);
    await page.type('Work email', 'lawyer@harbourvine.example');
    await page.type('Recovery code', 'ABCDE-FGHJK');
    await page.submit();
    expect(page.port.calls).toEqual([
      { name: 'auth-useRecoveryCode', data: { email: 'lawyer@harbourvine.example', code: 'ABCDE-FGHJK' } },
    ]);
    expect(page.router.url).toBe('/auth/sign-in?reenrol=1');
  });

  it('shows recovery failures', async () => {
    const page = await open('/auth/recover', null, (port) => (port.nextError = new AuthFlowError('invalid-code')));
    await page.type('Work email', 'lawyer@harbourvine.example');
    await page.type('Recovery code', 'ABCDE-FGHJK');
    await page.submit();
    expect(page.text()).toContain('That code isn’t right');
  });
});
