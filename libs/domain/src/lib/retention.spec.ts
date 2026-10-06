import { describe, expect, it } from 'vitest';

import {
  archiveCutoff,
  CloseMatterInput,
  closingItemsFor,
  dueForDestruction,
  evaluateClosing,
  isMinorOn,
  unbilledWipCents,
  laterDestroyAfter,
  retentionDate,
  retentionFor,
} from './retention';
import { dateOnly } from './values/date-only';

const d = dateOnly;
const none = { upcomingDeadlines: 0, openTasks: 0, unbilledWipCents: 0 };

describe('closing checklist (CORE-19)', () => {
  it('asks everyone about unbilled WIP, and estates for the final distribution', () => {
    expect(closingItemsFor('probate')).toEqual([
      'deadlines',
      'tasks',
      'wip',
      'originals',
      'closing_letter',
      'final_distribution',
    ]);
    expect(closingItemsFor('admin')).toContain('final_distribution');
    expect(closingItemsFor('will')).toEqual(['deadlines', 'tasks', 'wip', 'originals', 'closing_letter']);
    expect(closingItemsFor('contest')).not.toContain('final_distribution');
  });

  it('is ready when everything is done', () => {
    const result = evaluateClosing('will', none, { originals: 'returned', closingLetterSent: true });
    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(result.items.every((item) => item.state === 'done')).toBe(true);
  });

  it('blocks on upcoming deadlines, open tasks and unanswered items', () => {
    const result = evaluateClosing('probate', { upcomingDeadlines: 2, openTasks: 1, unbilledWipCents: 0 }, {});
    expect(result.ready).toBe(false);
    expect(result.blocking).toEqual(['deadlines', 'tasks', 'originals', 'closing_letter', 'final_distribution']);
    expect(result.items[0]?.detail).toBe('2 deadlines still upcoming: complete, waive or supersede them first.');
    expect(result.items[1]?.detail).toBe('1 task still open.');
  });

  it('lets open tasks be bulk-cancelled, but never upcoming deadlines', () => {
    const result = evaluateClosing(
      'will',
      { upcomingDeadlines: 1, openTasks: 3, unbilledWipCents: 0 },
      { originals: 'none_held', closingLetterSent: true },
      { cancelOpenTasks: true },
    );
    expect(result.items.find((item) => item.id === 'tasks')).toMatchObject({
      state: 'done',
      detail: '3 open tasks will be cancelled.',
    });
    expect(result.blocking).toEqual(['deadlines']);
  });

  it('accepts a reason in place of the closing letter and the final distribution', () => {
    const result = evaluateClosing(
      'probate',
      none,
      { originals: 'returned' },
      {
        overrides: {
          closing_letter: 'Client collected the file in person',
          final_distribution: 'Estate had no assets',
        },
      },
    );
    expect(result.ready).toBe(true);
    expect(result.items.filter((item) => item.state === 'overridden').map((item) => item.id)).toEqual([
      'closing_letter',
      'final_distribution',
    ]);
  });

  it('blocks on unbilled time and disbursements unless a reason is given (CORE-19b)', () => {
    const answers = { originals: 'returned', closingLetterSent: true } as const;
    const wip = { ...none, unbilledWipCents: 123_45 };
    const blocked = evaluateClosing('will', wip, answers);
    expect(blocked.blocking).toEqual(['wip']);
    expect(blocked.items.find((item) => item.id === 'wip')?.detail).toBe(
      '$123.45 of time and disbursements not yet billed: bill or write it off, or give a reason.',
    );
    const overridden = evaluateClosing('will', wip, answers, { overrides: { wip: 'Written off by agreement' } });
    expect(overridden.ready).toBe(true);
    expect(overridden.items.find((item) => item.id === 'wip')).toMatchObject({
      state: 'overridden',
      detail: 'Written off by agreement',
    });
    // A reason with nothing unbilled changes nothing.
    expect(evaluateClosing('will', none, answers, { overrides: { wip: 'x' } }).items[2]?.state).toBe('done');
  });

  it('counts unbilled WIP as time plus disbursements, ignoring missing or bad values', () => {
    expect(unbilledWipCents({ wipCents: 100_00, disbursementWipCents: 25_50 })).toBe(125_50);
    expect(unbilledWipCents({ disbursementWipCents: 25_50 })).toBe(25_50);
    expect(unbilledWipCents({ wipCents: -5, disbursementWipCents: 'x' })).toBe(0);
    expect(unbilledWipCents({})).toBe(0);
  });

  it('needs a reason to close', () => {
    expect(CloseMatterInput.safeParse({ requestId: crypto.randomUUID(), matterId: 'm1', reason: '  ' }).success).toBe(
      false,
    );
    const parsed = CloseMatterInput.parse({ requestId: crypto.randomUUID(), matterId: 'm1', reason: 'Done' });
    expect(parsed.checklist).toEqual({ closingLetterSent: false, finalDistributionRecorded: false });
  });
});

describe('retention (CORE-19)', () => {
  const base = { type: 'probate' as const, closedOn: d('2026-10-05'), hasMinor: false, legalHold: false };

  it('keeps a matter for the org’s retention years (7 by default) after closing', () => {
    expect(retentionFor(base)).toEqual({ destroyAfter: '2033-10-05', holds: [] });
    expect(retentionFor({ ...base, retentionYears: 10 }).destroyAfter).toBe('2036-10-05');
    expect(retentionFor({ ...base, retentionYears: 0 }).destroyAfter).toBe('2033-10-05');
  });

  it('clamps 29 February to 28 February', () => {
    expect(retentionDate(d('2028-02-29'), 7)).toBe('2035-02-28');
  });

  it('never sets a date for a legal hold, a minor, or a will or POA with originals in custody', () => {
    expect(retentionFor({ ...base, legalHold: true })).toEqual({ destroyAfter: null, holds: ['legal_hold'] });
    expect(retentionFor({ ...base, hasMinor: true })).toEqual({ destroyAfter: null, holds: ['minor'] });
    expect(retentionFor({ ...base, type: 'will', originals: 'safe_custody' })).toEqual({
      destroyAfter: null,
      holds: ['originals_in_custody'],
    });
    expect(retentionFor({ ...base, type: 'poa', originals: 'safe_custody', hasMinor: true }).holds).toEqual([
      'originals_in_custody',
      'minor',
    ]);
    // Originals in custody keep a will or POA only; a probate file's originals don't.
    expect(retentionFor({ ...base, originals: 'safe_custody' }).destroyAfter).toBe('2033-10-05');
    expect(retentionFor({ ...base, type: 'will', originals: 'returned' }).destroyAfter).toBe('2033-10-05');
  });

  it('tells minors by their 18th birthday', () => {
    expect(isMinorOn(d('2008-10-06'), d('2026-10-05'))).toBe(true);
    expect(isMinorOn(d('2008-10-05'), d('2026-10-05'))).toBe(false);
  });

  it('moves destroyAfter only later when the policy changes', () => {
    expect(laterDestroyAfter(d('2033-10-05'), d('2036-10-05'))).toBe('2036-10-05');
    expect(laterDestroyAfter(d('2033-10-05'), d('2031-10-05'))).toBeNull();
    expect(laterDestroyAfter(d('2033-10-05'), d('2033-10-05'))).toBeNull();
    expect(laterDestroyAfter(undefined, d('2036-10-05'))).toBeNull();
  });

  it('archives 90 days after closing', () => {
    expect(archiveCutoff(d('2026-10-05'))).toBe('2026-07-07');
  });

  it('finds matters due for destruction: closed or archived, past the date, not held, not destroyed', () => {
    const today = d('2033-10-06');
    const due = { status: 'closed', destroyAfter: '2033-10-05' };
    expect(dueForDestruction(due, today)).toBe(true);
    expect(dueForDestruction({ ...due, status: 'archived' }, today)).toBe(true);
    expect(dueForDestruction(due, d('2033-10-05'))).toBe(false);
    expect(dueForDestruction({ ...due, status: 'open' }, today)).toBe(false);
    expect(dueForDestruction({ ...due, legalHold: { on: true } }, today)).toBe(false);
    expect(dueForDestruction({ ...due, legalHold: { on: false } }, today)).toBe(true);
    expect(dueForDestruction({ ...due, destroyedAt: new Date() }, today)).toBe(false);
    expect(dueForDestruction({ status: 'closed', destroyAfter: null }, today)).toBe(false);
  });
});
