import path from 'node:path';

import { ESLint } from 'eslint';

/**
 * Proves the module boundaries in eslint.config.mjs are enforced (FND-02). Each case lints a
 * virtual file inside a real project, using that project's ESLint config.
 */
const root = path.resolve(import.meta.dirname, '../../..');

async function boundaryErrors(project: string, source: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: path.join(root, project) });
  const [result] = await eslint.lintText(source, { filePath: path.join(root, project, 'src/lib/boundary-probe.ts') });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === '@nx/enforce-module-boundaries')
    .map((message) => message.message);
}

// The first lint builds the Nx project graph, which takes several seconds when the other projects'
// tests run alongside (`nx run-many`), so the cases get more than vitest's default 5 s.
describe('module boundaries', { timeout: 30_000 }, () => {
  it('rejects libs/ui importing @materia/data-access', async () => {
    const errors = await boundaryErrors(
      'libs/ui',
      "import { OrgContext } from '@materia/data-access';\n\nexport const probe = OrgContext;\n",
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('allows libs/ui importing @materia/domain', async () => {
    const errors = await boundaryErrors(
      'libs/ui',
      "import { CURRENCY } from '@materia/domain';\n\nexport const probe = CURRENCY;\n",
    );
    expect(errors).toEqual([]);
  });

  it('rejects Angular imports in the pure domain lib', async () => {
    const errors = await boundaryErrors(
      'libs/domain',
      "import { signal } from '@angular/core';\n\nexport const probe = signal(1);\n",
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects web-scoped libs in functions-scoped code', async () => {
    const errors = await boundaryErrors(
      'libs/clerk',
      "import { OrgContext } from '@materia/data-access';\n\nexport const probe = OrgContext;\n",
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
