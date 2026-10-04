import { parseTerraformOutputs, renderEnvironment } from './env.ts';

// Shape of `terraform output -json`. Values are fictional.
const outputs = JSON.stringify({
  project_id: { sensitive: false, type: 'string', value: 'materia-v2-dev' },
  web_app_config: {
    sensitive: false,
    type: 'string',
    value: JSON.stringify({
      projectId: 'materia-v2-dev',
      appId: '1:000000000000:web:0000000000000000',
      apiKey: 'test-api-key',
      authDomain: 'materia-v2-dev.firebaseapp.com',
      storageBucket: 'materia-v2-dev-files',
      messagingSenderId: '000000000000',
      measurementId: null,
    }),
  },
});

describe('env script', () => {
  it('parses the web config from terraform outputs', () => {
    expect(parseTerraformOutputs(outputs)).toEqual({
      projectId: 'materia-v2-dev',
      appId: '1:000000000000:web:0000000000000000',
      apiKey: 'test-api-key',
      authDomain: 'materia-v2-dev.firebaseapp.com',
      storageBucket: 'materia-v2-dev-files',
      messagingSenderId: '000000000000',
    });
  });

  it('rejects outputs without a complete web config', () => {
    expect(() => parseTerraformOutputs('{}')).toThrow('web_app_config');
    const broken = JSON.stringify({ web_app_config: { value: JSON.stringify({ projectId: 'x' }) } });
    expect(() => parseTerraformOutputs(broken)).toThrow('web_app_config.appId is missing');
  });

  it('renders a deterministic Angular environment file', () => {
    const file = renderEnvironment('dev', parseTerraformOutputs(outputs));
    expect(file).toContain("name: 'dev',");
    expect(file).toContain('"projectId": "materia-v2-dev"');
    expect(file).not.toContain('measurementId');
    expect(file).toContain("appCheckSiteKey: '");
    expect(renderEnvironment('staging', parseTerraformOutputs(outputs))).not.toContain('appCheckSiteKey');
    expect(renderEnvironment('dev', parseTerraformOutputs(outputs))).toBe(file);
  });
});

describe('env main', () => {
  it('writes the environment file from a saved terraform output', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { main } = await import('./env.ts');
    const dir = mkdtempSync(path.join(tmpdir(), 'materia-env-'));
    const from = path.join(dir, 'out.json');
    writeFileSync(from, outputs);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--env', 'dev', '--from', from, '--out-dir', dir]);

    expect(readFileSync(path.join(dir, 'environment.dev.ts'), 'utf8')).toContain("name: 'dev',");
    log.mockRestore();
    await expect(main(['--env', 'qa'])).rejects.toThrow('--env must be one of');
  });

  it('accepts the raw web_app_config JSON (a CI variable) and rejects an empty one', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { main } = await import('./env.ts');
    const dir = mkdtempSync(path.join(tmpdir(), 'materia-env-'));
    const raw = (JSON.parse(outputs) as { web_app_config: { value: string } }).web_app_config.value;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--env', 'prod', '--web-config', raw, '--out-dir', dir]);

    expect(readFileSync(path.join(dir, 'environment.prod.ts'), 'utf8')).toContain('"apiKey": "test-api-key"');
    log.mockRestore();
    await expect(main(['--env', 'prod', '--web-config', ' ', '--out-dir', dir])).rejects.toThrow(
      '--web-config is empty',
    );
  });
});
