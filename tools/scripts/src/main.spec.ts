import { buildPrompt, toMarkdown } from './clerk-bench.ts';
import { run, usage } from './main.ts';

describe('materia-scripts', () => {
  it('lists the available commands', () => {
    expect(usage()).toContain('clerk-bench');
  });

  it('returns 0 for --help and 1 for an unknown command', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(await run(['no-such-command'])).toBe(1);
  });
});

describe('clerk-bench', () => {
  it('builds a fictional prompt of roughly the requested size', () => {
    const prompt = buildPrompt(1000, 'test');
    expect(prompt.startsWith('Benchmark run test. All names and facts below are fictional.')).toBe(true);
    expect(prompt.length).toBeGreaterThanOrEqual(4000);
    expect(prompt.length).toBeLessThan(4300);
  });

  it('renders a results table with medians', () => {
    const table = toMarkdown('fake', 'fake', [
      {
        run: 1,
        ttftMs: 100,
        totalMs: 1000,
        inputTokens: 10,
        outputTokens: 5,
        tokensPerSecond: 5,
        stopReason: 'end_turn',
      },
      {
        run: 2,
        ttftMs: 300,
        totalMs: 3000,
        inputTokens: 10,
        outputTokens: 5,
        tokensPerSecond: 7,
        stopReason: 'end_turn',
      },
    ]);
    expect(table).toContain('| **Median** | **200** | 2000 | | | **6** | |');
  });
});

describe('materia-scripts dispatch', () => {
  it('runs a command and reports its failures as exit code 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['clerk-bench', '--provider', 'fake', '--runs', '1'])).toBe(0);
    expect(await run(['env', '--env', 'qa'])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--env must be one of'));
    log.mockRestore();
    error.mockRestore();
  });
});
