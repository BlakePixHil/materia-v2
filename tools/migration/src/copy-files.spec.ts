import { copyFilesCommand } from './copy-files.ts';

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await copyFilesCommand(
    argv,
    (line) => void out.push(line),
    (line) => void err.push(line),
    env,
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('materia-migrate copy-files', () => {
  it('prints its usage', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('materia-migrate copy-files --run <runId> --env dev|prod');
  });

  it('refuses bad arguments before touching anything', async () => {
    const cases: [string[], RegExp][] = [
      [['--env', 'dev'], /Usage/],
      [['--run', 'r1'], /Usage/],
      [['--run', 'r1', '--env', 'staging'], /--env dev, --env prod or --env emulator/],
      [['--run', '../r1', '--env', 'dev'], /may hold only letters/],
      [['--run', 'r1', '--env', 'dev', '--concurrency', '0'], /from 1 to 32/],
      [['--run', 'r1', '--env', 'dev', '--concurrency', '2.5'], /from 1 to 32/],
      [
        ['--run', 'r1', '--env', 'dev', '--files-bucket', 'matt-r-1fe15.firebasestorage.app'],
        /only a materia-v2 files bucket/,
      ],
      [
        ['--run', 'r1', '--env', 'dev', '--files-bucket', 'materia-v2-prod-files'],
        /not dev's \(materia-v2-dev-files\)/,
      ],
      [['--run', 'r1', '--env', 'emulator'], /FIREBASE_STORAGE_EMULATOR_HOST is not set/],
      [['--run', 'r1', '--env', 'emulator', '--scanner-url', 'https://x'], /fake scanner/],
      [['--run', 'r1', '--nope'], /Unknown option/],
    ];
    for (const [argv, message] of cases) {
      const { code, err } = await run(argv);
      expect({ argv, code }).toEqual({ argv, code: 1 });
      expect(err).toMatch(message);
    }
  });
});
