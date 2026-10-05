import { describe, expect, it } from 'vitest';

import { DEFAULT_NOTIFICATION_PREFS, resolveChannels } from './notifications';
import {
  initialsFrom,
  lockedChannels,
  notificationMatrix,
  ProfileInput,
  readUserPrefs,
  setKindChannel,
  squareCrop,
} from './profile';

describe('ProfileInput', () => {
  const valid = {
    firstName: ' Priya ',
    lastName: 'Fictional',
    displayName: 'Priya Fictional',
    title: 'Senior Associate',
    admissionNo: 'VIC 12345',
    initials: 'pf',
    colour: '#346CFC',
  };

  it('trims names and upper-cases initials', () => {
    const parsed = ProfileInput.parse(valid);
    expect(parsed.firstName).toBe('Priya');
    expect(parsed.initials).toBe('PF');
  });

  it('allows no initials override, and refuses more than three letters', () => {
    expect(ProfileInput.safeParse({ ...valid, initials: '' }).success).toBe(true);
    expect(ProfileInput.safeParse({ ...valid, initials: 'ABCD' }).success).toBe(false);
  });

  it('needs a first name and a display name', () => {
    expect(ProfileInput.safeParse({ ...valid, firstName: '  ' }).success).toBe(false);
    expect(ProfileInput.safeParse({ ...valid, displayName: '' }).success).toBe(false);
  });
});

describe('initialsFrom', () => {
  it('takes the first and last word', () => {
    expect(initialsFrom('Priya van der Fictional')).toBe('PF');
    expect(initialsFrom('Casey')).toBe('CA');
    expect(initialsFrom('  ')).toBe('?');
  });
});

describe('squareCrop', () => {
  it('centres the largest square at zoom 1', () => {
    expect(squareCrop(4000, 3000)).toEqual({ x: 500, y: 0, size: 3000 });
  });

  it('zooms in around the centre and pans to the edges without leaving the image', () => {
    expect(squareCrop(4000, 3000, 2)).toEqual({ x: 1250, y: 750, size: 1500 });
    expect(squareCrop(4000, 3000, 2, -1, 1)).toEqual({ x: 0, y: 1500, size: 1500 });
    expect(squareCrop(4000, 3000, 2, 5, -5)).toEqual({ x: 2500, y: 0, size: 1500 });
  });
});

describe('readUserPrefs', () => {
  it('fills defaults for a missing or half-written document', () => {
    expect(readUserPrefs(undefined)).toEqual({
      theme: 'system',
      density: 'comfortable',
      shortcuts: true,
      notifications: DEFAULT_NOTIFICATION_PREFS,
      startPage: 'today',
    });
    expect(
      readUserPrefs({ theme: 'neon', density: 'compact', startPage: 'matters', timezone: 'Australia/Perth' }),
    ).toMatchObject({
      theme: 'system',
      density: 'compact',
      startPage: 'matters',
      timezone: 'Australia/Perth',
    });
  });
});

describe('the notification matrix', () => {
  it('shows each kind’s defaults, with deadline escalation email and in-app locked on', () => {
    const rows = notificationMatrix(DEFAULT_NOTIFICATION_PREFS);
    const mention = rows.find((r) => r.kind === 'mention');
    expect(mention?.cells.map((c) => [c.channel, c.on, c.locked])).toEqual([
      ['inapp', true, false],
      ['email', true, false],
      ['push', false, false],
    ]);
    const escalation = rows.find((r) => r.kind === 'deadline_escalation');
    expect(escalation?.cells.filter((c) => c.locked).map((c) => c.channel)).toEqual(['inapp', 'email']);
    expect(lockedChannels('mention')).toEqual([]);
  });

  it('marks a channel switched off for everything, except locked cells', () => {
    const rows = notificationMatrix({ ...DEFAULT_NOTIFICATION_PREFS, email: false });
    expect(rows.find((r) => r.kind === 'mention')?.cells[1]?.masterOff).toBe(true);
    expect(rows.find((r) => r.kind === 'deadline_escalation')?.cells[1]?.masterOff).toBe(false);
  });

  it('stores only choices that differ from the default', () => {
    const off = setKindChannel(DEFAULT_NOTIFICATION_PREFS, 'mention', 'email', false);
    expect(off.kinds).toEqual({ mention: { email: false } });
    const back = setKindChannel(off, 'mention', 'email', true);
    expect(back.kinds).toBeUndefined();
    const push = setKindChannel(back, 'mention', 'push', true);
    expect(push.kinds).toEqual({ mention: { push: true } });
  });

  it('can’t turn a locked channel off, and the server still emails if one is stored off', () => {
    const prefs = setKindChannel(DEFAULT_NOTIFICATION_PREFS, 'deadline_escalation', 'email', false);
    expect(prefs).toBe(DEFAULT_NOTIFICATION_PREFS);
    const tampered = {
      ...DEFAULT_NOTIFICATION_PREFS,
      email: false,
      kinds: { deadline_escalation: { email: false, inapp: false } },
    };
    expect(resolveChannels({ kind: 'deadline_escalation', priority: 'critical', prefs: tampered })).toEqual(
      expect.arrayContaining(['inapp', 'email']),
    );
  });
});
