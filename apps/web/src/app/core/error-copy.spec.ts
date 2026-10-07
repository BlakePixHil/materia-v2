import { offlineError } from '@materia/data-access';
import { DomainError, ERROR_CODES } from '@materia/domain';

import {
  CLERK_BUDGET_COPY,
  CLERK_DISABLED_COPY,
  CLERK_KEY_MISSING_COPY,
  ERROR_COPY,
  errorCodeOf,
  errorCopy,
  NEEDS_CONNECTION_COPY,
  shouldRefreshTokenAndRetry,
  TERMS_OUTDATED_COPY,
} from './error-copy';

describe('error copy', () => {
  it('has copy for every error code', () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual(Object.keys(ERROR_CODES).sort());
    for (const text of Object.values(ERROR_COPY)) expect(text.length).toBeGreaterThan(10);
  });

  it('reads the code from a callable error and never shows the server message', () => {
    const error = {
      code: 'functions/permission-denied',
      message: 'Role readonly cannot call system-echo',
      details: { code: 'PERMISSION_DENIED' },
    };
    expect(errorCodeOf(error)).toBe('PERMISSION_DENIED');
    expect(errorCopy(error)).toBe(ERROR_COPY.PERMISSION_DENIED);
    expect(errorCopy(error)).not.toContain('system-echo');
  });

  it('says a callable that never left the browser needs a connection (MOB-01)', () => {
    expect(errorCopy(offlineError())).toBe(NEEDS_CONNECTION_COPY.long);
    expect(errorCopy(new DomainError('UNAVAILABLE'))).toBe(ERROR_COPY.UNAVAILABLE);
  });

  it('falls back to INTERNAL for unknown errors', () => {
    expect(errorCodeOf(new Error('boom'))).toBe('INTERNAL');
    expect(errorCodeOf(null)).toBe('INTERNAL');
    expect(errorCodeOf({ details: { code: 'MADE_UP' } })).toBe('INTERNAL');
  });

  it('asks for a reload when the terms changed while the page was open (SEC-01)', () => {
    expect(
      errorCopy(new DomainError('FAILED_PRECONDITION', 'old terms', { reason: 'terms_outdated', current: '0.2' })),
    ).toBe(TERMS_OUTDATED_COPY);
    expect(errorCopy({ details: { code: 'FAILED_PRECONDITION', reason: 'terms_outdated' } })).toBe(TERMS_OUTDATED_COPY);
    expect(errorCopy(new DomainError('FAILED_PRECONDITION', 'other', { reason: 'other' }))).toBe(
      ERROR_COPY.FAILED_PRECONDITION,
    );
  });

  it('flags a stale org claim for a token refresh and one retry', () => {
    expect(shouldRefreshTokenAndRetry({ details: { code: 'ORG_CLAIM_MISMATCH' } })).toBe(true);
    expect(shouldRefreshTokenAndRetry({ details: { code: 'PERMISSION_DENIED' } })).toBe(false);
  });

  it('says how to turn Clerk on when the practice has no Anthropic key (AI-02a)', () => {
    expect(errorCopy({ details: { code: 'CLERK_DISABLED', switch: 'org.byok.missing' } })).toBe(CLERK_KEY_MISSING_COPY);
    expect(errorCopy(new DomainError('CLERK_DISABLED', 'off', { switch: 'org.byok.missing' }))).toBe(
      CLERK_KEY_MISSING_COPY,
    );
    expect(errorCopy({ details: { code: 'CLERK_KEY_INVALID' } })).toContain('Settings → Clerk and AI');
  });

  describe('says which Clerk switch is off and who can change it (AI-13)', () => {
    const off = (flag?: string) =>
      errorCopy(new DomainError('CLERK_DISABLED', 'Clerk is switched off', flag ? { switch: flag } : undefined));

    it('points owners and admins to the disclosure, the practice switch and each feature', () => {
      expect(off('org.settings.clerk.acknowledgement')).toBe(CLERK_DISABLED_COPY.acknowledgement);
      expect(off('org.settings.clerk.acknowledgement')).toContain(
        'An owner or admin needs to read and accept the Clerk disclosure in Settings → Clerk and AI',
      );
      expect(off('org.settings.clerk.enabled')).toBe(CLERK_DISABLED_COPY.practice);
      expect(off('org.settings.clerk.features.chat')).toBe(
        'Your practice has turned off “Ask Clerk”. An owner or admin can turn it back on in Settings → Clerk and AI.',
      );
      expect(off('org.settings.clerk.features.willExtract')).toContain('“Read wills”');
      // A feature the web doesn't know yet still says where to look.
      expect(off('org.settings.clerk.features.voice')).toBe(CLERK_DISABLED_COPY.feature);
    });

    it('says Materia’s kill switches aren’t a practice setting, so an On switch in Settings isn’t wrong', () => {
      expect(off('clerk.enabled')).toBe(CLERK_DISABLED_COPY.killSwitch);
      expect(off('clerk.enabled')).toContain('not in Settings → Clerk and AI');
      expect(off('clerk.features.chat')).toBe(CLERK_DISABLED_COPY.featureKillSwitch);
      // The chat panel passes a stored answer's code and switch as a plain object.
      expect(errorCopy({ details: { code: 'CLERK_DISABLED', switch: 'clerk.features.drafting' } })).toBe(
        CLERK_DISABLED_COPY.featureKillSwitch,
      );
    });

    it('falls back to the general copy without a switch it recognises', () => {
      expect(off()).toBe(ERROR_COPY.CLERK_DISABLED);
      expect(off('something.new')).toBe(ERROR_COPY.CLERK_DISABLED);
      expect(errorCopy({ details: { code: 'CLERK_DISABLED', switch: undefined } })).toBe(ERROR_COPY.CLERK_DISABLED);
    });
  });

  it('tells the spend limit from the monthly allowance, and the daily request limit from the window (AI-13)', () => {
    const spend = new DomainError('CLERK_BUDGET_EXCEEDED', 'Monthly Clerk spend limit reached', {
      period: 'clerk-2026-10',
      spend: true,
    });
    expect(errorCopy(spend)).toBe(CLERK_BUDGET_COPY.spend);
    expect(errorCopy(spend)).toContain('can raise it in Settings → Clerk and AI');
    const tokens = new DomainError('CLERK_BUDGET_EXCEEDED', 'Monthly Clerk budget used', { period: 'clerk-2026-10' });
    expect(errorCopy(tokens)).toBe(CLERK_BUDGET_COPY.tokens);
    expect(errorCopy(tokens)).toContain('used this month’s Clerk allowance');
    // A stored chat answer keeps only the code.
    expect(errorCopy({ details: { code: 'CLERK_BUDGET_EXCEEDED' } })).toBe(ERROR_COPY.CLERK_BUDGET_EXCEEDED);
    expect(ERROR_COPY.CLERK_BUDGET_EXCEEDED).toContain('spend limit in Settings → Clerk and AI');

    expect(errorCopy(new DomainError('CLERK_RATE_LIMITED', 'Daily Clerk request limit reached', { daily: 40 }))).toBe(
      'You’ve used today’s Clerk requests: your practice allows 40 requests a day for each person. Try again tomorrow, or ask an owner or admin to raise the limit in Settings → Clerk and AI.',
    );
    expect(
      errorCopy(new DomainError('CLERK_RATE_LIMITED', 'Daily Clerk request limit reached', { daily: 1 })),
    ).toContain('allows 1 request a day');
    expect(errorCopy(new DomainError('CLERK_RATE_LIMITED', 'Too many Clerk requests', { windowMinutes: 10 }))).toBe(
      ERROR_COPY.CLERK_RATE_LIMITED,
    );
  });
});
