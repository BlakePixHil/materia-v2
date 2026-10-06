import { run, usage } from './main.ts';

describe('materia-migrate', () => {
  it('lists every migration step', () => {
    for (const step of ['audit', 'check-profile', 'export', 'transform', 'load', 'verify', 'rollback']) {
      expect(usage()).toContain(step);
    }
  });

  it('exits 0 for --help, 1 for unknown steps and 2 for unimplemented steps', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['--help'])).toBe(0);
    expect(await run(['nope'])).toBe(1);
    expect(await run(['export'])).toBe(2);
    expect(await run(['audit', '--help'])).toBe(0);
    expect(await run(['check-profile', '--help'])).toBe(0);
    vi.restoreAllMocks();
  });
});
