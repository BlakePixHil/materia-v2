import {
  defineFlag,
  FLAG_KEYS,
  flagRegistryProblems,
  FLAGS,
  isFlagKey,
  isValidFlagValue,
  remoteConfigKey,
  resolveFlag,
  staleFlags,
  type FlagDefinition,
} from './flags';

describe('resolveFlag', () => {
  it('takes the org override over Remote Config over the default', () => {
    expect(resolveFlag('litigation.enabled', {})).toEqual({ value: false, source: 'default' });
    expect(resolveFlag('litigation.enabled', { remote: { 'litigation.enabled': true } })).toEqual({
      value: true,
      source: 'remote',
    });
    expect(
      resolveFlag('litigation.enabled', {
        remote: { 'litigation.enabled': true },
        org: { 'litigation.enabled': false },
      }),
    ).toEqual({
      value: false,
      source: 'org',
    });
  });

  it('lets a local dev override win, and ignores values of the wrong type', () => {
    expect(
      resolveFlag('litigation.enabled', {
        local: { 'litigation.enabled': true },
        org: { 'litigation.enabled': false },
      }),
    ).toEqual({
      value: true,
      source: 'local',
    });
    expect(
      resolveFlag('litigation.enabled', {
        org: { 'litigation.enabled': 'yes' },
        remote: { 'litigation.enabled': true },
      }),
    ).toEqual({
      value: true,
      source: 'remote',
    });
    expect(resolveFlag('system.echo', {})).toEqual({ value: true, source: 'default' });
  });
});

describe('registry', () => {
  it('is valid: owners are ticket keys, keys are dotted camelCase, defaults match types', () => {
    expect(flagRegistryProblems()).toEqual([]);
    for (const key of [
      'clerk.enabled',
      'deadlines.ruleset.vic.v1',
      'litigation.enabled',
      'billing.invoicing',
      'integrations.microsoft',
      'mobile.voice',
      'auth.openSignup',
    ]) {
      expect(FLAG_KEYS).toContain(key);
    }
    expect(FLAG_KEYS.some((key) => key.startsWith('clerk.features.'))).toBe(true);
  });

  it('reports bad entries', () => {
    const bad: Record<string, FlagDefinition> = {
      'x.y': defineFlag({
        key: 'x.z',
        description: '',
        owner: 'someone',
        type: 'boolean',
        default: 'no' as never,
        serverEnforced: false,
        fullyOnSince: '2026/01/01',
      }),
      'Bad-Key': defineFlag({
        key: 'Bad-Key',
        description: 'ok',
        owner: 'FND-23',
        type: 'number',
        default: 1,
        serverEnforced: false,
      }),
    };
    const problems = flagRegistryProblems(bad);
    expect(problems).toEqual([
      'x.y: key "x.z" doesn\'t match its registry name',
      'x.y: owner "someone" is not a ticket key (FND-23)',
      'x.y: missing description',
      "x.y: default doesn't match type boolean",
      'x.y: fullyOnSince must be YYYY-MM-DD',
      'Bad-Key: key must be dotted camelCase',
    ]);
  });

  it('finds flags fully on for more than 90 days', () => {
    const flags: Record<string, FlagDefinition> = {
      old: defineFlag({
        key: 'old',
        description: 'd',
        owner: 'FND-1',
        type: 'boolean',
        default: true,
        serverEnforced: false,
        fullyOnSince: '2026-06-01',
      }),
      recent: defineFlag({
        key: 'recent',
        description: 'd',
        owner: 'FND-1',
        type: 'boolean',
        default: true,
        serverEnforced: false,
        fullyOnSince: '2026-09-01',
      }),
      dark: defineFlag({
        key: 'dark',
        description: 'd',
        owner: 'FND-1',
        type: 'boolean',
        default: false,
        serverEnforced: false,
      }),
    };
    expect(staleFlags('2026-10-04', 90, flags).map((f) => f.key)).toEqual(['old']);
    expect(staleFlags('2026-10-04')).toEqual([]);
  });

  it('maps keys to Remote Config parameter names and checks values', () => {
    expect(remoteConfigKey('deadlines.ruleset.vic.v1')).toBe('deadlines_ruleset_vic_v1');
    expect(isFlagKey('clerk.enabled')).toBe(true);
    expect(isFlagKey('nope')).toBe(false);
    expect(isValidFlagValue('clerk.enabled', true)).toBe(true);
    expect(isValidFlagValue('clerk.enabled', 'true')).toBe(false);
    expect(FLAGS['system.echo'].serverEnforced).toBe(true);
  });
});
