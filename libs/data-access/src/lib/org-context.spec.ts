import { TestBed } from '@angular/core/testing';

import { DomainError } from '@materia/domain';

import { ListenerRegistry } from './listener-registry';
import { OrgContext } from './org-context';

describe('OrgContext', () => {
  it('starts without a session and tracks the person, org and role', () => {
    const context = TestBed.inject(OrgContext);
    expect(context.hasOrg()).toBe(false);
    expect(() => context.requireOrgId()).toThrow(DomainError);
    expect(() => context.requireUid()).toThrow(DomainError);

    context.setSession({ uid: 'u1', orgId: 'org-test-1', role: 'lawyer' });
    expect(context.orgId()).toBe('org-test-1');
    expect(context.uid()).toBe('u1');
    expect(context.role()).toBe('lawyer');
    expect(context.requireOrgId()).toBe('org-test-1');
    expect(context.requireUid()).toBe('u1');

    context.setSession(null);
    expect(context.hasOrg()).toBe(false);
    expect(context.session()).toBeNull();
  });

  it('stops every listener when the org or the person changes, but not on a role change', () => {
    const context = TestBed.inject(OrgContext);
    const registry = TestBed.inject(ListenerRegistry);
    context.setSession({ uid: 'u1', orgId: 'org-a', role: 'lawyer' });
    const first = context.generation();
    const stop = vi.fn();
    registry.add(stop);

    context.setSession({ uid: 'u1', orgId: 'org-a', role: 'admin' });
    expect(stop).not.toHaveBeenCalled();
    expect(context.role()).toBe('admin');
    expect(context.generation()).toBe(first);

    context.setSession({ uid: 'u1', orgId: 'org-b', role: 'admin' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.active()).toBe(0);
    expect(context.generation()).toBe(first + 1);

    registry.add(stop);
    context.setSession(null);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(context.generation()).toBe(first + 2);
  });
});
