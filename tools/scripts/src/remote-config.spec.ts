import {
  applyFlags,
  buildReport,
  getTemplate,
  parseArgs,
  parseDesired,
  parseValue,
  renderReport,
  run,
  WRITABLE_PROJECT,
  type RcTemplate,
  type RunDeps,
  type Side,
} from './remote-config.ts';

/** The Remote Config report and dev publishing (FND-23a) against an in-memory Remote Config API. */

type Stored = Omit<RcTemplate, 'etag'>;

function fakeRemoteConfig(initial: Partial<Record<'firebase' | 'firebase-server', Stored>>) {
  const store = new Map<string, { template: Stored; etag: number }>();
  for (const [namespace, template] of Object.entries(initial)) store.set(namespace, { template, etag: 1 });
  const puts: { namespace: string; ifMatch: string; validateOnly: boolean; body: Stored }[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const namespace = url.pathname.split('/')[5] as string;
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer t0ken');
    const entry = store.get(namespace);
    if ((init.method ?? 'GET') === 'GET') {
      if (!entry) return new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 });
      return Response.json(
        { ...entry.template, version: { versionNumber: String(entry.etag), updateTime: '2026-10-07T04:00:00Z' } },
        { headers: { etag: `etag-${entry.etag}` } },
      );
    }
    const body = JSON.parse(String(init.body)) as Stored;
    const ifMatch = headers['if-match'] as string;
    const validateOnly = url.searchParams.get('validateOnly') === 'true';
    puts.push({ namespace, ifMatch, validateOnly, body });
    if (ifMatch !== '*' && ifMatch !== `etag-${entry?.etag}`) return new Response('ETag mismatch', { status: 409 });
    const etag = (entry?.etag ?? 0) + 1;
    if (!validateOnly) store.set(namespace, { template: body, etag });
    return Response.json(body, { headers: { etag: `etag-${validateOnly ? (entry?.etag ?? 0) : etag}` } });
  }) as typeof globalThis.fetch;
  return { fetch, store, puts };
}

function deps(fake: ReturnType<typeof fakeRemoteConfig>, file = '{"flags":{}}'): RunDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    fetch: fake.fetch,
    token: async () => 't0ken',
    readFile: async () => file,
    orgOverrides: async () => [{ orgId: 'org-1', flags: { 'estate.register': true } }],
    log: (line) => lines.push(line),
    lines,
  };
}

const bool = (value: string) => ({ defaultValue: { value }, valueType: 'BOOLEAN' });
const empty: RcTemplate = { etag: '*' };

describe('remote-config report', () => {
  it('shows every registry flag in both templates, what the app gets, and mismatches', () => {
    const client: RcTemplate = {
      etag: 'e1',
      parameters: {
        clerk_features_chat: bool('true'),
        clerk_features_intakePrefill: bool('true'),
        old_flag: bool('true'),
      },
      parameterGroups: { billing: { parameters: { billing_invoicing: bool('true') } } },
    };
    const server: RcTemplate = {
      etag: 'e2',
      parameters: {
        billing_invoicing: bool('true'),
        estate_register: { ...bool('false'), conditionalValues: { beta: { value: 'true' } } },
        templates_system: { defaultValue: { useInAppDefault: true }, valueType: 'BOOLEAN' },
      },
    };
    const report = buildReport({ client, server }, [{ orgId: 'org-1', flags: { 'estate.register': true } }]);
    const row = (key: string) => report.rows.find((r) => r.key === key);

    expect(report.rows.length).toBeGreaterThan(20);
    expect(row('clerk.features.chat')).toMatchObject({
      client: 'true',
      server: undefined,
      web: true,
      callable: false,
      notes: ['⚠️ client true but server false'],
    });
    expect(row('billing.invoicing')).toMatchObject({
      client: 'true',
      server: 'true',
      web: true,
      callable: true,
      notes: [],
    });
    expect(row('clerk.features.intakePrefill')).toMatchObject({ web: true, callable: undefined, notes: [] });
    expect(row('estate.register')?.notes).toEqual(['server has conditional values (beta)']);
    expect(row('templates.system')).toMatchObject({ server: undefined, callable: false });
    expect(row('system.echo')).toMatchObject({ client: undefined, web: true, callable: true });
    expect(report.unknown).toEqual([{ side: 'client', name: 'old_flag' }]);

    const markdown = renderReport('materia-v2-dev', { client, server }, report);
    expect(markdown).toContain(
      '| `clerk.features.chat` | AI-06 | false | true | — | **true** | **false** | ⚠️ client true but server false |',
    );
    expect(markdown).toContain('| `clerk.features.intakePrefill` |');
    expect(markdown).toContain('client only');
    expect(markdown).toContain('- client: `old_flag`');
    expect(markdown).toContain('- `org-1`: `estate.register`=true');
    expect(markdown).toContain('client template not published yet; server template not published yet');
  });

  it('says when org overrides could not be read', () => {
    const markdown = renderReport(
      'p',
      { client: empty, server: empty },
      buildReport({ client: empty, server: empty }, undefined),
    );
    expect(markdown).toContain('Not read');
    expect(
      renderReport('p', { client: empty, server: empty }, buildReport({ client: empty, server: empty }, [])),
    ).toContain('None.');
  });

  it('reads values the way the SDKs do', () => {
    expect(parseValue('boolean', 'TRUE')).toBe(true);
    expect(parseValue('boolean', 'on')).toBe(true);
    expect(parseValue('boolean', 'nope')).toBe(false);
    expect(parseValue('number', '12')).toBe(12);
    expect(parseValue('number', 'x')).toBe(0);
    expect(parseValue('string', 'a')).toBe('a');
  });
});

describe('remote-config apply', () => {
  it('sets values in place (grouped parameters stay grouped, conditions are kept), adds and removes', () => {
    const template: RcTemplate = {
      etag: 'e1',
      parameters: {
        estate_register: { ...bool('false'), description: 'Mine', conditionalValues: { beta: { value: 'true' } } },
        litigation_enabled: bool('true'),
      },
      parameterGroups: {
        billing: { parameters: { billing_invoicing: bool('false'), billing_feeBudgets: bool('true') } },
      },
    };
    const { template: next, changes } = applyFlags(template, {
      'estate.register': true,
      'billing.invoicing': true,
      'clerk.features.chat': true,
      'litigation.enabled': null,
      'conflicts.enforced': null,
      'billing.feeBudgets': null,
    });
    expect(changes).toEqual([
      'estate_register: false → true',
      'billing_invoicing: false → true',
      'clerk_features_chat: unset → true',
      'litigation_enabled: removed (was true; the registry default applies)',
      'billing_feeBudgets: removed (was true; the registry default applies)',
    ]);
    expect(Object.keys(next.parameterGroups?.['billing']?.parameters ?? {})).toEqual(['billing_invoicing']);
    expect(next.parameters?.['estate_register']).toEqual({
      defaultValue: { value: 'true' },
      valueType: 'BOOLEAN',
      description: 'Mine',
      conditionalValues: { beta: { value: 'true' } },
    });
    expect(next.parameterGroups?.['billing']?.parameters?.['billing_invoicing']?.defaultValue).toEqual({
      value: 'true',
    });
    expect(next.parameters?.['billing_invoicing']).toBeUndefined();
    expect(next.parameters?.['clerk_features_chat']).toMatchObject({
      valueType: 'BOOLEAN',
      description: expect.stringContaining('chat'),
    });
    expect(next.parameters?.['litigation_enabled']).toBeUndefined();
    // The input is untouched.
    expect(template.parameters?.['litigation_enabled']).toBeDefined();
    expect(applyFlags(next, { 'estate.register': true }).changes).toEqual([]);
  });

  it('accepts only registry flags with the right type', () => {
    expect(parseDesired({ flags: { 'clerk.features.chat': true, 'estate.register': null } })).toEqual({
      'clerk.features.chat': true,
      'estate.register': null,
    });
    expect(() => parseDesired({ flags: { 'no.such': true, 'clerk.features.chat': 'yes' } })).toThrow(
      /no\.such: not a flag[\s\S]*clerk\.features\.chat: must be a boolean/,
    );
    expect(() => parseDesired({})).toThrow(/must be \{ "flags"/);
    expect(() => parseDesired([])).toThrow(/must be \{ "flags"/);
  });

  it('publishes both templates with their ETags, then reports what is live', async () => {
    const fake = fakeRemoteConfig({ firebase: { parameters: { estate_register: bool('true') } } });
    const d = deps(fake, JSON.stringify({ flags: { 'clerk.features.chat': true, 'estate.register': true } }));
    const markdown = await run({ project: WRITABLE_PROJECT, apply: 'infra/remote-config/dev.json', dryRun: false }, d);

    expect(fake.puts.map((p) => [p.namespace, p.ifMatch, p.validateOnly])).toEqual([
      ['firebase', 'etag-1', false],
      ['firebase-server', '*', false],
    ]);
    expect(fake.puts[0]?.body).not.toHaveProperty('version');
    expect(fake.puts[0]?.body).not.toHaveProperty('etag');
    expect(fake.store.get('firebase-server')?.template.parameters).toMatchObject({
      clerk_features_chat: bool('true'),
      estate_register: bool('true'),
    });
    expect(d.lines).toEqual([
      'client template: clerk_features_chat: unset → true',
      'client template: published.',
      'server template: clerk_features_chat: unset → true',
      'server template: estate_register: unset → true',
      'server template: published.',
    ]);
    expect(markdown).toContain('| `clerk.features.chat` | AI-06 | false | true | true | **true** | **true** |  |');

    // Applying again changes nothing.
    const again = deps(fake, JSON.stringify({ flags: { 'clerk.features.chat': true } }));
    await run({ project: WRITABLE_PROJECT, apply: 'f.json', dryRun: false }, again);
    expect(fake.puts).toHaveLength(2);
    expect(again.lines).toEqual([
      'client template: already matches f.json.',
      'server template: already matches f.json.',
    ]);
  });

  it('only validates on a dry run', async () => {
    const fake = fakeRemoteConfig({ firebase: {}, 'firebase-server': {} });
    const d = deps(fake, JSON.stringify({ flags: { 'clerk.features.chat': true } }));
    const markdown = await run({ project: WRITABLE_PROJECT, apply: 'f.json', dryRun: true }, d);
    expect(fake.puts.every((p) => p.validateOnly)).toBe(true);
    expect(fake.store.get('firebase')?.template.parameters).toBeUndefined();
    expect(d.lines).toContain('client template: dry run, Remote Config validated the change; nothing published.');
    expect(markdown).toContain('| `clerk.features.chat` | AI-06 | false | — | — |');
  });

  it('fails the publish when the template changed since it was read', async () => {
    const fake = fakeRemoteConfig({ firebase: {} });
    const d = deps(fake, JSON.stringify({ flags: { 'clerk.features.chat': true } }));
    const original = fake.fetch;
    let gets = 0;
    d.fetch = (async (input, init) => {
      const response = await original(input, init);
      // Someone publishes in the console right after this read.
      if ((init?.method ?? 'GET') === 'GET' && gets++ === 0) fake.store.set('firebase', { template: {}, etag: 7 });
      return response;
    }) as typeof fetch;
    await expect(run({ project: WRITABLE_PROJECT, apply: 'f.json', dryRun: false }, d)).rejects.toThrow(
      /Publishing the client template: HTTP 409/,
    );
  });

  it('reports read errors', async () => {
    const d = deps(fakeRemoteConfig({}));
    d.fetch = (async () => new Response('denied', { status: 403 })) as typeof fetch;
    await expect(getTemplate(d, 'p', 'client' satisfies Side)).rejects.toThrow(
      'Reading the client template: HTTP 403 denied',
    );
  });
});

describe('remote-config args', () => {
  it('reads anywhere but writes only dev', () => {
    expect(parseArgs(['--project', 'materia-v2-prod'])).toEqual({
      project: 'materia-v2-prod',
      apply: undefined,
      dryRun: false,
    });
    expect(parseArgs(['--project', WRITABLE_PROJECT, '--apply', 'f.json', '--dry-run'])).toEqual({
      project: WRITABLE_PROJECT,
      apply: 'f.json',
      dryRun: true,
    });
    expect(() => parseArgs(['--project', 'materia-v2-prod', '--apply', 'f.json'])).toThrow(
      /only writes materia-v2-dev/,
    );
    expect(() => parseArgs(['--apply', 'f.json'])).toThrow(/Usage/);
    expect(() => parseArgs(['--project', WRITABLE_PROJECT, '--apply'])).toThrow(/Usage/);
  });
});
