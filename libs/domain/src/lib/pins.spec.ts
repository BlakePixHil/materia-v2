import { describe, expect, it } from 'vitest';

import { changePins, MAX_PINNED_MATTERS, PinnedMatterIdsSchema, pinsInOrg, withPins } from './pins';
import { User } from './schemas/tenancy';

const ten = Array.from({ length: MAX_PINNED_MATTERS }, (_, i) => `m${i + 1}`);

describe('pinsInOrg', () => {
  it('reads one org’s ids and ignores anything else', () => {
    const stored = { org1: ['m1', 'm2'], org2: ['m9'] };
    expect(pinsInOrg(stored, 'org1')).toEqual(['m1', 'm2']);
    expect(pinsInOrg(stored, 'org3')).toEqual([]);
    expect(pinsInOrg(undefined, 'org1')).toEqual([]);
    expect(pinsInOrg('nonsense', 'org1')).toEqual([]);
    expect(pinsInOrg({ org1: 'm1' }, 'org1')).toEqual([]);
    expect(pinsInOrg({ org1: ['m1', 7, '', null] }, 'org1')).toEqual(['m1']);
  });
});

describe('changePins', () => {
  it('pins a matter last and unpins it', () => {
    expect(changePins(['m1'], 'm2', true)).toEqual({ ids: ['m1', 'm2'] });
    expect(changePins(['m1', 'm2'], 'm1', false)).toEqual({ ids: ['m2'] });
  });

  it('keeps the order when the matter is already pinned, and unpinning what isn’t pinned changes nothing', () => {
    expect(changePins(['m2', 'm1'], 'm2', true)).toEqual({ ids: ['m2', 'm1'] });
    expect(changePins(['m1'], 'm3', false)).toEqual({ ids: ['m1'] });
  });

  it('prunes matters that are gone, and duplicates', () => {
    const gone = new Set(['m2']);
    expect(changePins(['m1', 'm2', 'm1'], 'm3', true, gone)).toEqual({ ids: ['m1', 'm3'] });
    expect(changePins(['m1', 'm2'], 'm1', false, gone)).toEqual({ ids: [] });
  });

  it('refuses an eleventh pin, unless pruning makes room', () => {
    expect(changePins(ten, 'm11', true)).toEqual({ full: true });
    expect(changePins(ten, 'm11', true, new Set(['m4']))).toEqual({
      ids: [...ten.filter((id) => id !== 'm4'), 'm11'],
    });
    expect(changePins(ten, 'm3', true)).toEqual({ ids: ten });
  });
});

describe('withPins', () => {
  it('replaces one org’s list and copies the others as they are', () => {
    const stored = { org1: ['m1'], org2: ['m9'] };
    expect(withPins(stored, 'org1', ['m1', 'm2'])).toEqual({ org1: ['m1', 'm2'], org2: ['m9'] });
    expect(withPins(stored, 'org1', [])).toEqual({ org2: ['m9'] });
    expect(withPins(undefined, 'org1', ['m1'])).toEqual({ org1: ['m1'] });
    expect(stored).toEqual({ org1: ['m1'], org2: ['m9'] });
  });
});

describe('the stored shape', () => {
  it('allows up to ten per org on users/{uid}', () => {
    expect(PinnedMatterIdsSchema.safeParse({ org1: ten }).success).toBe(true);
    expect(PinnedMatterIdsSchema.safeParse({ org1: [...ten, 'm11'] }).success).toBe(false);
    expect(PinnedMatterIdsSchema.safeParse({ org1: [''] }).success).toBe(false);
    expect(User.update.safeParse({ pinnedMatterIds: { org1: ['m1'] } }).success).toBe(true);
  });
});
