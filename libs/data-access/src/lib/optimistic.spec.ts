import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { optimistic } from './optimistic';
import { OrgContext } from './org-context';
import { can } from './permissions';

describe('optimistic', () => {
  it('applies the change at once and keeps it when the action succeeds', async () => {
    const items = signal(['a', 'b']);
    let seen: string[] = [];
    const result = await optimistic(
      items,
      (list) => list.filter((i) => i !== 'a'),
      async () => {
        seen = items();
        return 'done';
      },
    );
    expect(seen).toEqual(['b']);
    expect(result).toBe('done');
    expect(items()).toEqual(['b']);
  });

  it('rolls back and rethrows a DomainError when the action fails', async () => {
    const items = signal(['a', 'b']);
    await expect(
      optimistic(
        items,
        (list) => [...list, 'c'],
        async () => {
          throw { code: 'functions/failed-precondition', details: { code: 'LAST_OWNER' } };
        },
      ),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
    expect(items()).toEqual(['a', 'b']);
  });

  it('takes a custom rollback', async () => {
    const count = signal(1);
    await optimistic(
      count,
      (n) => n + 1,
      () => Promise.reject(new Error('x')),
      (current) => current - 1,
    ).catch(() => undefined);
    expect(count()).toBe(1);
  });
});

describe('can', () => {
  it('follows the current role through the domain matrix', () => {
    const context = TestBed.inject(OrgContext);
    const privileged = signal(false);
    const [manage, view] = TestBed.runInInjectionContext(() => [
      can('members.manage'),
      can('matter.view', () => ({ privileged: privileged() })),
    ]);
    expect(manage()).toBe(false);
    expect(view()).toBe(false);

    context.setSession({ uid: 'u', orgId: 'o', role: 'paralegal' });
    expect(manage()).toBe(false);
    expect(view()).toBe(true);
    privileged.set(true);
    expect(view()).toBe(false);

    context.setSession({ uid: 'u', orgId: 'o', role: 'owner' });
    expect(manage()).toBe(true);
    expect(view()).toBe(true);
  });
});
