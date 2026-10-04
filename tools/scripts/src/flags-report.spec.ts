import { buildFlagReport, main } from './flags-report.ts';
import { parseArgs } from './platform-admin.ts';

describe('flags-report', () => {
  it('lists every flag and passes for the real registry', async () => {
    const report = buildFlagReport('2026-10-04');
    expect(report.problems).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.lines[0]).toMatch(/^Feature flags \(\d+\):$/);
    expect(report.lines.some((line) => line.includes('litigation.enabled') && line.includes('LIT-01'))).toBe(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(main(['--today=2026-10-04'])).resolves.toBeUndefined();
    log.mockRestore();
  });

  it('reports stale flags as warnings and fails on registry problems', async () => {
    const flag = {
      key: 'old.flag',
      description: 'd',
      owner: 'FND-1',
      type: 'boolean',
      default: true,
      serverEnforced: false,
      fullyOnSince: '2026-01-01',
    };
    const domain = {
      FLAGS: { 'old.flag': flag },
      flagRegistryProblems: () => ['old.flag: owner "x" is not a ticket key (FND-23)'],
      staleFlags: () => [flag],
    } as never;
    const report = buildFlagReport('2026-10-04', domain);
    expect(report.stale).toEqual([{ key: 'old.flag', owner: 'FND-1', fullyOnSince: '2026-01-01' }]);
    expect(report.problems).toHaveLength(1);
    expect(report.lines[1]).toContain('fully on since 2026-01-01');
  });
});

describe('platform-admin', () => {
  it('needs a project and a uid', () => {
    expect(parseArgs(['--project', 'demo-materia', '--uid', 'u1'])).toEqual({
      project: 'demo-materia',
      uid: 'u1',
      revoke: false,
    });
    expect(parseArgs(['--project', 'p', '--uid', 'u', '--revoke']).revoke).toBe(true);
    expect(() => parseArgs(['--uid', 'u1'])).toThrow(/Usage/);
  });
});
