import { ACTIONS, can, PERMISSIONS, permissionsTable, ROLES } from './permissions';

describe('permissions', () => {
  it('lets owners do everything and readonly users only view', () => {
    for (const action of ACTIONS) expect(can('owner', action)).toBe(true);
    expect(ACTIONS.filter((action) => can('readonly', action))).toEqual(['matter.view']);
  });

  it('never shows privileged material to readonly or paralegal users', () => {
    expect(can('readonly', 'matter.view', { privileged: true })).toBe(false);
    expect(can('paralegal', 'matter.view', { privileged: true })).toBe(false);
    expect(can('lawyer', 'matter.view', { privileged: true })).toBe(true);
    expect(can('paralegal', 'matter.view')).toBe(true);
  });

  it('reserves voids, members and exports for owners and admins', () => {
    for (const action of ['billing.void', 'members.manage', 'export.includePrivileged'] as const) {
      expect(ROLES.filter((role) => can(role, action))).toEqual(['owner', 'admin']);
    }
    // Lawyers and above issue and send invoices (BILL-07).
    expect(ROLES.filter((role) => can(role, 'billing.issue'))).toEqual(['owner', 'admin', 'lawyer']);
    expect(PERMISSIONS['org.delete']).toEqual(['owner']);
  });

  it('renders the README table', () => {
    const table = permissionsTable();
    expect(table.split('\n')).toHaveLength(ACTIONS.length + 2);
    expect(table).toContain('| `org.delete` | ✓ |  |  |  |  |');
  });
});
