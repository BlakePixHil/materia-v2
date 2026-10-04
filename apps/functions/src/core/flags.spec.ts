import type { Firestore } from 'firebase-admin/firestore';

import { clearFlagCaches, FLAG_CACHE_MS, flagValue, isEnabled, requireFlag, setRemoteFlagLoader } from './flags';
import { setOrgOverrideDefinition } from '../flags/set-org-override';

/** Fake Firestore: org documents with `flags`, counting reads, recording updates and audit entries. */
function world(orgs: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const updates: unknown[][] = [];
  const created: { path: string; data: Record<string, unknown> }[] = [];
  const db = {
    collection: (path: string) => ({
      doc: () => ({ create: async (data: Record<string, unknown>) => void created.push({ path, data }) }),
    }),
    doc: (path: string) => ({
      get: async () => {
        reads.push(path);
        const data = orgs[path];
        return { exists: !!data, get: (field: string) => data?.[field] };
      },
      update: async (...args: unknown[]) => void updates.push(args),
    }),
  } as unknown as Firestore;
  let now = 1_000_000;
  const clock = { now: () => new Date(now) };
  return { db, reads, updates, created, clock, advance: (ms: number) => (now += ms) };
}

describe('server flags', () => {
  it('resolves org override > Remote Config > default, caching both for a minute', async () => {
    const remote = vi.fn(async () => ({ 'litigation.enabled': true, 'billing.invoicing': true }));
    setRemoteFlagLoader(remote);
    const w = world({ 'orgs/org-a': { flags: { 'billing.invoicing': false } } });
    const ctx = { orgId: 'org-a', db: w.db, clock: w.clock };
    expect(await flagValue(ctx, 'litigation.enabled')).toBe(true);
    expect(await flagValue(ctx, 'billing.invoicing')).toBe(false);
    expect(await flagValue(ctx, 'mobile.voice')).toBe(false);
    expect(await isEnabled({ db: w.db, clock: w.clock }, 'billing.invoicing')).toBe(true);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(w.reads).toEqual(['orgs/org-a']);
    w.advance(FLAG_CACHE_MS + 1);
    await flagValue(ctx, 'litigation.enabled');
    expect(remote).toHaveBeenCalledTimes(2);
    expect(w.reads).toHaveLength(2);
    clearFlagCaches();
    await flagValue(ctx, 'litigation.enabled');
    expect(remote).toHaveBeenCalledTimes(3);
  });

  it('falls back to defaults when Remote Config is down', async () => {
    setRemoteFlagLoader(() => Promise.reject(new Error('unavailable')));
    const w = world({});
    expect(await flagValue({ orgId: 'org-missing', db: w.db, clock: w.clock }, 'system.echo')).toBe(true);
  });

  it('requireFlag throws FEATURE_DISABLED when off', async () => {
    setRemoteFlagLoader(async () => ({}));
    const w = world({ 'orgs/org-a': { flags: {} } });
    await expect(requireFlag({ orgId: 'org-a', db: w.db, clock: w.clock }, 'litigation.enabled')).rejects.toMatchObject(
      {
        code: 'FEATURE_DISABLED',
        details: { flag: 'litigation.enabled' },
      },
    );
    await expect(requireFlag({ orgId: 'org-a', db: w.db, clock: w.clock }, 'system.echo')).resolves.toBeUndefined();
  });
});

describe('flags-setOrgOverride', () => {
  const ctx = (w: ReturnType<typeof world>, token: Record<string, unknown> | null, input: unknown) =>
    ({ input, uid: 'admin-1', token, db: w.db, clock: w.clock, requestId: 'r', log: {}, auth: {} }) as never;

  it('is for platform admins only', async () => {
    const w = world({ 'orgs/org-a': {} });
    await expect(
      setOrgOverrideDefinition.handler(
        ctx(w, { role: 'owner' }, { orgId: 'org-a', key: 'litigation.enabled', value: true }),
      ),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      setOrgOverrideDefinition.handler(ctx(w, null, { orgId: 'org-a', key: 'litigation.enabled', value: true })),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('sets and clears an override with a FieldPath (flag keys contain dots)', async () => {
    const w = world({ 'orgs/org-a': {} });
    const admin = { platformAdmin: true };
    expect(
      await setOrgOverrideDefinition.handler(ctx(w, admin, { orgId: 'org-a', key: 'litigation.enabled', value: true })),
    ).toEqual({ ok: true });
    await setOrgOverrideDefinition.handler(ctx(w, admin, { orgId: 'org-a', key: 'litigation.enabled', value: null }));
    const [set, clear] = w.updates;
    expect(String(set?.[0])).toBe('flags.`litigation.enabled`');
    expect(set?.[1]).toBe(true);
    expect(set?.slice(2, 3)).toEqual(['updatedAt']);
    expect(set?.at(-1)).toBe('admin-1');
    expect((clear?.[1] as { constructor: { name: string } }).constructor.name).toContain('DeleteTransform');
    // The org document is outside the audit trigger, so each change is audited in that org.
    expect(w.created.map((c) => [c.path, c.data['action'], c.data['summary'], c.data['data']])).toEqual([
      [
        'orgs/org-a/audit',
        'flag.override_set',
        'Override for litigation.enabled set',
        { key: 'litigation.enabled', value: true },
      ],
      [
        'orgs/org-a/audit',
        'flag.override_cleared',
        'Override for litigation.enabled cleared',
        { key: 'litigation.enabled', value: null },
      ],
    ]);
    expect(w.created[0]?.data['actor']).toEqual({ uid: 'admin-1' });
  });

  it('rejects wrong value types and unknown orgs', async () => {
    const w = world({ 'orgs/org-a': {} });
    const admin = { platformAdmin: true };
    await expect(
      setOrgOverrideDefinition.handler(ctx(w, admin, { orgId: 'org-a', key: 'litigation.enabled', value: 'yes' })),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      setOrgOverrideDefinition.handler(ctx(w, admin, { orgId: 'org-x', key: 'litigation.enabled', value: true })),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(setOrgOverrideDefinition.input.safeParse({ orgId: 'org-a', key: 'nope', value: true }).success).toBe(false);
  });
});
