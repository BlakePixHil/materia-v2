import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  generatePromptModule,
  getPrompt,
  parsePrompt,
  PromptError,
  prompts,
  promptsFrom,
  renderPrompt,
} from './prompts';

const PROMPTS_DIR = path.join(import.meta.dirname, '../../prompts');

const prompt = (meta: string, body = '# System\n\nYou are Clerk. {{a}}\n\n# User\n\nHi {{b}}.') =>
  `---\n${meta}\n---\n\n${body}\n`;
const META = 'id: demo\nversion: 1.2.0\neffort: medium\nmaxTokens: 2048';

describe('prompt registry', () => {
  it('parses front-matter and the system and user sections', () => {
    const parsed = parsePrompt(
      'demo@1.2.0',
      prompt(`${META}\ntools: [searchMatter, getDeadlines]\noutputSchema: hello`),
    );
    expect(parsed.ref).toBe('demo@1.2.0');
    expect(parsed.meta).toEqual({
      id: 'demo',
      version: '1.2.0',
      effort: 'medium',
      maxTokens: 2048,
      outputSchema: 'hello',
      tools: ['searchMatter', 'getDeadlines'],
    });
    expect(parsed.system).toBe('You are Clerk. {{a}}');
    expect(parsed.user).toBe('Hi {{b}}.');
  });

  it.each([
    ['no front-matter', 'demo@1.2.0', '# System\nx\n# User\ny', /missing front-matter/],
    ['a bad version', 'demo@1.2', prompt('id: demo\nversion: 1.2\neffort: low\nmaxTokens: 10'), /version/],
    ['a name that does not match', 'demo@9.9.9', prompt(META), /must be demo@1\.2\.0\.md/],
    ['an unknown output schema', 'demo@1.2.0', prompt(`${META}\noutputSchema: nope`), /unknown outputSchema/],
    ['an unknown field', 'demo@1.2.0', prompt(`${META}\ntemperature: 1`), /temperature/],
    ['a bad line', 'demo@1.2.0', prompt(`${META}\njunk`), /bad front-matter line/],
    ['missing sections', 'demo@1.2.0', prompt(META, 'Just text'), /# System/],
  ])('rejects %s', (_label, name, source, message) => {
    expect(() => parsePrompt(name, source)).toThrow(message);
  });

  it('renders with strict variable checking', () => {
    const all = promptsFrom({ 'demo@1.2.0': prompt(META) });
    const rendered = renderPrompt('demo@1.2.0', { a: 'Be brief.', b: 7 }, all);
    expect([rendered.system, rendered.user]).toEqual(['You are Clerk. Be brief.', 'Hi 7.']);
    expect(rendered.variables.sort()).toEqual(['a', 'b']);
    expect(() => renderPrompt('demo@1.2.0', { a: 'x' }, all)).toThrow(/missing variable "b"/);
    expect(() => renderPrompt('demo@1.2.0', { a: 'x', b: 'y', c: 'z' }, all)).toThrow(/unused variable\(s\) c/);
    expect(() => renderPrompt('demo@1.2.0', { a: 'x', b: { nested: true } as never }, all)).toThrow(PromptError);
  });

  it('resolves a bare id to its latest version', () => {
    const all = promptsFrom({
      'demo@1.2.0': prompt(META),
      'demo@1.10.0': prompt(META.replace('1.2.0', '1.10.0')),
      'demo@0.9.1': prompt(META.replace('1.2.0', '0.9.1')),
    });
    expect(getPrompt('demo', all).ref).toBe('demo@1.10.0');
    expect(() => getPrompt('demo@2.0.0', all)).toThrow(/Unknown prompt/);
    expect(() => getPrompt('other', all)).toThrow(/Unknown prompt/);
  });

  it('bundles every prompt file, in sync with libs/clerk/prompts (run `materia-scripts clerk-prompts`)', () => {
    const files = readdirSync(PROMPTS_DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({ name: file.slice(0, -3), content: readFileSync(path.join(PROMPTS_DIR, file), 'utf8') }));
    const generated = readFileSync(path.join(import.meta.dirname, 'prompt-sources.generated.ts'), 'utf8');
    expect(generated).toBe(generatePromptModule(files));
    expect([...prompts().keys()].sort()).toEqual(files.map((f) => f.name).sort());
  });

  it('ships the hello prompt used for the gateway smoke test', () => {
    const hello = renderPrompt('hello', { name: 'Avery', promptRef: 'hello@1.0.0' });
    expect(hello.ref).toBe('hello@1.0.0');
    expect(hello.meta).toMatchObject({ effort: 'low', outputSchema: 'hello' });
    expect(hello.user).toContain('Avery');
  });
});
