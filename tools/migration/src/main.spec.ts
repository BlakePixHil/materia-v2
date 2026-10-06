import { run, usage } from './main.ts';

describe('materia-migrate', () => {
  it('lists every migration step', () => {
    for (const step of [
      'audit',
      'check-profile',
      'export',
      'transform',
      'auth-import',
      'copy-files',
      'load',
      'verify',
      'rollback',
      'delta',
    ]) {
      expect(usage()).toContain(step);
    }
  });

  it('exits 0 for --help, 1 for unknown steps and 2 for unimplemented steps', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['--help'])).toBe(0);
    expect(await run(['nope'])).toBe(1);
    expect(await run(['load'])).toBe(2);
    expect(await run(['export', '--help'])).toBe(0);
    expect(await run(['audit', '--help'])).toBe(0);
    expect(await run(['check-profile', '--help'])).toBe(0);
    expect(await run(['auth-import', '--help'])).toBe(0);
    expect(await run(['copy-files', '--help'])).toBe(0);
    expect(await run(['transform', '--help'])).toBe(0);
    for (const step of ['load', 'verify', 'rollback', 'delta']) expect(await run([step, '--help'])).toBe(0);
    vi.restoreAllMocks();
  });
});
