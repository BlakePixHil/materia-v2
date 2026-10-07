import {
  pageProblems,
  parsePhoneCheckArgs,
  phoneReport,
  type PhonePage,
  type SwitchShape,
  switchProblems,
} from './demo-phone-check.ts';

const SWITCH: SwitchShape = {
  label: 'Unread only',
  checked: false,
  target: 44,
  track: 31,
  clip: 'padding-box',
  thumbInTrack: true,
  labelOffCentre: 0.5,
};

const page = (extra: Partial<PhonePage> = {}): PhonePage => ({
  path: '/inbox',
  underTopBar: [],
  overflowX: 0,
  switches: [SWITCH],
  ...extra,
});

describe('demo-phone-check', () => {
  it('checks the Inbox and Preferences as the demo owner unless told otherwise', () => {
    expect(parsePhoneCheckArgs(['--project', 'materia-v2-dev'])).toEqual({
      project: 'materia-v2-dev',
      paths: ['/inbox', '/settings/preferences'],
      account: 'owner',
      url: undefined,
      dryRun: false,
    });
    expect(parsePhoneCheckArgs(['--paths', '/today, /matters', '--account', 'lawyer', '--dry-run'])).toMatchObject({
      paths: ['/today', '/matters'],
      account: 'lawyer',
      dryRun: true,
    });
  });

  it('refuses a bad path or account', () => {
    expect(() => parsePhoneCheckArgs(['--paths', 'inbox'])).toThrow(/app paths/);
    expect(() => parsePhoneCheckArgs(['--paths', ','])).toThrow(/at least one/);
    expect(() => parsePhoneCheckArgs(['--account', 'partner'])).toThrow(/--account is one of/);
  });

  it('passes an iOS-sized switch, and a switch whose label is for screen readers only', () => {
    expect(switchProblems(SWITCH)).toEqual([]);
    expect(switchProblems({ ...SWITCH, checked: true, track: 32, labelOffCentre: null })).toEqual([]);
  });

  it('names what is wrong with a switch, as #306 found them', () => {
    // The track filled the whole target, the label sat at the top, and on it the colour filled the clear border.
    expect(switchProblems({ ...SWITCH, track: 44, labelOffCentre: 12, clip: 'border-box' })).toEqual([
      'track 44px, not 30–32px',
      'its colour fills the clear border (border-box)',
      'label 12px off centre',
    ]);
    expect(switchProblems({ ...SWITCH, target: 18, track: 18, thumbInTrack: false })).toEqual([
      'target 18px, under 44px',
      'track 18px, not 30–32px',
      'thumb outside the track',
    ]);
  });

  it('fails a page with content under the top bar or wider than the screen', () => {
    expect(pageProblems(page())).toEqual([]);
    expect(
      pageProblems(page({ underTopBar: ['div.toolbar at 32px', 'button.mt-chip at 42px'], overflowX: 82 })),
    ).toEqual(['2 element(s) under the top bar, first div.toolbar at 32px', '82px wider than the screen']);
  });

  it('reports a row per page and lists each problem', () => {
    const report = phoneReport(
      [page(), page({ path: '/settings/preferences', switches: [{ ...SWITCH, label: 'Email', track: 44 }] })],
      'Phone check',
    );
    expect(report).toContain('| /inbox | 0 | 0px | 1 of 1 (44/31px off) | Pass |');
    expect(report).toContain('| /settings/preferences | 0 | 0px | 0 of 1 (44/44px off) | Fail |');
    expect(report).toContain('- /settings/preferences: switch “Email” (off): track 44px, not 30–32px');
    expect(phoneReport([page()], 'Phone check')).toContain('No problems found.');
  });
});
