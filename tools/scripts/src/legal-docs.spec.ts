import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COMPLIANCE_DIR,
  compileLegalDocs,
  CONTENT_FILE,
  DRAFT_NOTICE,
  legalDocuments,
  main,
  parseLegalDoc,
  REGISTRY_FILE,
  TERMS_VERSION_FILE,
} from './legal-docs.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function doc(fields: Record<string, string | number>, body: string): string {
  const head = Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `---\n${head}\n---\n\n${body}\n`;
}

const meta = (key: string, title: string, order: number, extra: Record<string, string> = {}) => ({
  key,
  title,
  summary: `About ${title}.`,
  version: '0.1',
  effective: '2026-10-07',
  status: 'draft',
  order,
  ...extra,
});

const TERMS = doc(
  meta('terms', 'Terms of service', 1),
  `# Terms of service\n\n${DRAFT_NOTICE} For review.\n> A second line of the notice.\n\n## Summary\n\nSee the [DPA](dpa.md) and [our site](https://example.com).`,
);
const DPA = doc(meta('dpa', 'Data processing addendum', 2), `# Data processing addendum\n\n${DRAFT_NOTICE}\n\nBody.`);
const PIA = '# Privacy impact assessment\n\nInternal: links to [the terms](terms-of-service.md) are fine here.\n';

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'legal-docs-'));
  mkdirSync(path.join(root, COMPLIANCE_DIR), { recursive: true });
  writeFileSync(path.join(root, COMPLIANCE_DIR, 'terms-of-service.md'), TERMS);
  writeFileSync(path.join(root, COMPLIANCE_DIR, 'dpa.md'), DPA);
  writeFileSync(path.join(root, COMPLIANCE_DIR, 'pia.md'), PIA);
  for (const file of [REGISTRY_FILE, TERMS_VERSION_FILE, CONTENT_FILE]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), 'stale');
  }
  return root;
}

describe('legal-docs (SEC-01)', () => {
  it('compiles the published documents into the registry and the content module, and --check fails on drift', async () => {
    const root = workspace();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(main(['--check'], root)).rejects.toThrow(/out of date/);
    await main([], root);
    const registry = readFileSync(path.join(root, REGISTRY_FILE), 'utf8');
    expect(registry).toContain('key: "terms"');
    expect(registry).not.toContain('pia');
    // The terms' version has a module of its own, so the app's terms check loads without the registry.
    expect(registry).not.toContain('TERMS_VERSION');
    expect(readFileSync(path.join(root, TERMS_VERSION_FILE), 'utf8')).toContain('export const TERMS_VERSION = "0.1";');
    expect(registry.indexOf('"terms"')).toBeLessThan(registry.indexOf('"dpa"'));
    const content = readFileSync(path.join(root, CONTENT_FILE), 'utf8');
    // No title or draft notice (the app shows its own), links to published documents rewritten.
    expect(content).toContain('"terms": "## Summary');
    expect(content).not.toContain('Draft — not yet reviewed');
    expect(content).toContain('[DPA](/legal/dpa)');
    expect(content).toContain('[our site](https://example.com)');
    await expect(main(['--check'], root)).resolves.toBeUndefined();
    await main([], root);
    expect(log).toHaveBeenLastCalledWith('The legal documents were already compiled.');
    log.mockRestore();
  });

  it('leaves files without front-matter unpublished', () => {
    expect(parseLegalDoc('pia.md', PIA)).toBeNull();
  });

  it.each([
    ['a missing field', doc({ key: 'terms', title: 'T' }, '# T'), /missing "summary"/],
    ['an unknown field', doc({ ...meta('terms', 'T', 1), colour: 'red' }, '# T'), /unknown field "colour"/],
    ['a bad key', doc(meta('Terms', 'T', 1), `# T\n\n${DRAFT_NOTICE}`), /key "Terms"/],
    ['a bad version', doc(meta('terms', 'T', 1, { version: 'v1' }), `# T\n\n${DRAFT_NOTICE}`), /version "v1"/],
    ['a bad date', doc(meta('terms', 'T', 1, { effective: '2026-02-30' }), `# T\n\n${DRAFT_NOTICE}`), /effective/],
    ['a bad status', doc(meta('terms', 'T', 1, { status: 'review' }), `# T\n\n${DRAFT_NOTICE}`), /status/],
    ['a bad order', doc(meta('terms', 'T', 1, { order: 'first' }), `# T\n\n${DRAFT_NOTICE}`), /order/],
    ['the wrong title', doc(meta('terms', 'T', 1), `# Other\n\n${DRAFT_NOTICE}`), /must start with "# T"/],
    ['a draft without its notice', doc(meta('terms', 'T', 1), '# T\n\nBody.'), /draft starts with the draft notice/],
    ['a final with a draft notice', doc(meta('terms', 'T', 1, { status: 'final' }), `# T\n\n${DRAFT_NOTICE}`), /final/],
    ['a bad front-matter line', '---\njunk\n---\n\n# T\n', /bad front-matter line/],
  ])('refuses %s', (_name, source, error) => {
    expect(() => parseLegalDoc('terms-of-service.md', source)).toThrow(error);
  });

  it('accepts a final document without the notice', () => {
    const parsed = parseLegalDoc('terms.md', doc(meta('terms', 'T', 1, { status: 'final' }), '# T\n\nBody.'));
    expect(parsed).toMatchObject({ status: 'final', body: 'Body.', source: `${COMPLIANCE_DIR}/terms.md` });
  });

  it('refuses links to unpublished files, documents that share a key, and terms and a DPA with different versions', () => {
    const internal = doc(meta('terms', 'T', 1), `# T\n\n${DRAFT_NOTICE}\n\nSee [the PIA](pia.md).`);
    expect(() =>
      legalDocuments([
        { file: 'terms.md', content: internal },
        { file: 'dpa.md', content: DPA },
      ]),
    ).toThrow(/links to "pia.md"/);
    expect(() =>
      legalDocuments([
        { file: 'terms.md', content: TERMS },
        { file: 'dpa.md', content: DPA },
        { file: 'copy.md', content: TERMS.replace('order: 1', 'order: 3') },
      ]),
    ).toThrow(/share the key "terms"/);
    expect(() => legalDocuments([{ file: 'dpa.md', content: DPA }])).toThrow(/are required/);
    expect(() =>
      legalDocuments([
        { file: 'terms-of-service.md', content: TERMS },
        { file: 'dpa.md', content: DPA.replace('version: 0.1', 'version: 0.2') },
      ]),
    ).toThrow(/one agreement/);
  });

  it('keeps the repository’s generated files in sync with docs/compliance (run `materia-scripts legal-docs`)', () => {
    for (const { file, next } of compileLegalDocs(repoRoot))
      expect(readFileSync(path.join(repoRoot, file), 'utf8'), `${file} is out of date`).toBe(next);
  });
});
