import path from 'node:path';

import { ESLint } from 'eslint';

/**
 * Proves the AI-02 rule: model SDKs may be imported only by the Clerk provider adapters, so every
 * feature goes through ClerkGateway. Each case lints a virtual file with its project's config.
 */
const root = path.resolve(import.meta.dirname, '../../..');

async function sdkErrors(project: string, file: string, source: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: path.join(root, project) });
  const [result] = await eslint.lintText(source, { filePath: path.join(root, project, file) });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

const ANTHROPIC = "import Anthropic from '@anthropic-ai/sdk';\n\nexport const probe = Anthropic;\n";

describe('model SDK imports (AI-02)', () => {
  it.each([
    ['apps/functions', 'src/clerk/gateway-probe.ts', ANTHROPIC],
    [
      'apps/functions',
      'src/system/probe.ts',
      "import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';\n\nexport const probe = AnthropicVertex;\n",
    ],
    [
      'libs/clerk',
      'src/lib/probe.ts',
      "import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';\n\nexport const probe = zodOutputFormat;\n",
    ],
    ['apps/web', 'src/app/probe.ts', "import OpenAI from 'openai';\n\nexport const probe = OpenAI;\n"],
  ])('blocks a direct SDK import in %s/%s', async (project, file, source) => {
    const errors = await sdkErrors(project, file, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ClerkGateway');
  });

  it('allows the provider adapters', async () => {
    expect(await sdkErrors('apps/functions', 'src/clerk/providers/probe.ts', ANTHROPIC)).toEqual([]);
  });
});
