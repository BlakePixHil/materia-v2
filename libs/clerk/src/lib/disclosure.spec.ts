import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { disclosureVersion, generateDisclosureModule } from './disclosure';

const DISCLOSURE_DIR = path.join(import.meta.dirname, '../../disclosure');
const GENERATED = path.join(import.meta.dirname, '../../../domain/src/lib/clerk-disclosure.generated.ts');

describe('the Clerk data-use disclosure (AI-13)', () => {
  it('is compiled into @materia/domain, in sync (run `materia-scripts clerk-prompts`)', () => {
    const files = readdirSync(DISCLOSURE_DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({ name: file.slice(0, -3), content: readFileSync(path.join(DISCLOSURE_DIR, file), 'utf8') }));
    expect(readFileSync(GENERATED, 'utf8')).toBe(generateDisclosureModule(files));
  });

  it('covers the provider, region, retention, what is sent and privilege', () => {
    const latest = readdirSync(DISCLOSURE_DIR)
      .filter((file) => file.endsWith('.md'))
      .sort((a, b) => disclosureVersion(b.slice(0, -3)) - disclosureVersion(a.slice(0, -3)))[0] as string;
    const text = readFileSync(path.join(DISCLOSURE_DIR, latest), 'utf8');
    for (const topic of ['Anthropic', 'outside Australia', 'What is sent', 'How long it is kept', 'Privilege'])
      expect(text).toContain(topic);
  });

  it('numbers versions from 1 with no gaps', () => {
    expect(() => generateDisclosureModule([{ name: 'disclosure@2', content: 'x' }])).toThrow(/missing 1/);
    expect(() => generateDisclosureModule([{ name: 'disclosure-v1', content: 'x' }])).toThrow(/disclosure@<version>/);
    expect(
      generateDisclosureModule([
        { name: 'disclosure@1', content: 'a' },
        { name: 'disclosure@2', content: 'b' },
      ]),
    ).toContain('CLERK_DISCLOSURE_VERSION = 2;');
  });
});
