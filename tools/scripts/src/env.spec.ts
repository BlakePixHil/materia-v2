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
    expect(renderEnvironment('dev', parseTerraformOutputs(outputs))).toBe(file);
  });
});
