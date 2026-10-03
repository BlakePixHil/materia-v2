import { run, usage } from './main.ts';

describe('materia-migrate', () => {
  it('lists every migration step', () => {
    for (const step of ['export', 'transform', 'load', 'verify', 'rollback']) {
      expect(usage()).toContain(step);
    }
  });

  it('exits 0 for --help, 1 for unknown steps and 2 for unimplemented steps', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(await run(['nope'])).toBe(1);
    expect(await run(['export'])).toBe(2);
  });
});
