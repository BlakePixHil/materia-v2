import { TestBed } from '@angular/core/testing';

import { OrgContext } from './org-context';

describe('OrgContext', () => {
  it('starts without an org and tracks the active org', () => {
    const context = TestBed.inject(OrgContext);
    expect(context.hasOrg()).toBe(false);

    context.setOrg('org-test-1');
    expect(context.orgId()).toBe('org-test-1');
    expect(context.hasOrg()).toBe(true);

    context.setOrg(null);
    expect(context.hasOrg()).toBe(false);
  });
});
