import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  diffOutputs,
  main,
  renderIconsTs,
  renderTokensTs,
  splitBundle,
  svgToNodes,
  transformTokensCss,
  writeOutputs,
  type SyncOutput,
} from './sync-design.ts';

const BUNDLE = `/*
 * header
 */

/* ---------- base ---------- */
html, body { background: var(--bg-surface); }
.mt-i { width: var(--icon); }

/* ---------- layout helpers ---------- */
.mt-row { display: flex; }

/* ---------- Button ---------- */
.mt-btn { height: var(--h); }
.mt-btn[data-size="sm"] { --h: 28px; } .mt-btn .mt-i { margin: 0; }

/* ---------- Icon button ---------- */
.mt-ibtn { width: 32px; }

/* ---------- motion ---------- */
@keyframes mt-spin { to { transform: rotate(360deg); } }
`;

describe('sync-design', () => {
  it('rewrites font URLs to /fonts/ and replaces the header', () => {
    const css = `/* materia tokens v2. do not edit. */\n:root { --x: 1px; }\n@font-face { src: url("../system/project/fonts/Geist-Variable.woff2"); }\n`;
    const out = transformTokensCss(css);
    expect(out).toMatch(/^\/\* generated — do not edit\./);
    expect(out).toContain('url("/fonts/Geist-Variable.woff2")');
    expect(out).not.toContain('materia tokens v2');
  });

  it('splits the bundle by mt- prefix, keeping global sections whole', () => {
    const files = splitBundle(BUNDLE);
    expect([...files.keys()]).toEqual(['base.css', 'btn.css', 'ibtn.css', 'layout.css']);
    const body = (name: string) => (files.get(name) ?? '').split('\n').slice(1).filter(Boolean);
    expect(body('base.css')).toEqual([
      'html, body { background: var(--bg-surface); }',
      '.mt-i { width: var(--icon); }',
      '@keyframes mt-spin { to { transform: rotate(360deg); } }',
    ]);
    expect(body('btn.css')).toHaveLength(2);
    expect(body('layout.css')).toEqual(['.mt-row { display: flex; }']);
    expect(files.get('btn.css')).toMatch(/^\/\* generated — do not edit\. Source: .*\(mt-btn\)/);
  });

  it('parses icon markup into Lucide nodes and rejects anything it cannot round-trip', () => {
    expect(svgToNodes('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')).toEqual([
      ['circle', { cx: '11', cy: '11', r: '8' }],
      ['path', { d: 'm21 21-4.3-4.3' }],
    ]);
    expect(svgToNodes('<line x1="3" x2="21" y1="22" y2="22"/>')).toEqual([
      ['line', { x1: '3', x2: '21', y1: '22', y2: '22' }],
    ]);
    expect(() => svgToNodes('<g><path d="M0 0"/></g>')).toThrow(/Unsupported SVG markup/);
  });

  it('renders typed token and icon modules', () => {
    const tokens = renderTokensTs({
      color: {
        tokens: [{ name: 'bg-canvas', value: { light: '{slate-50}', dark: '{slate-975}' }, usage: 'App background.' }],
      },
      type: { families: { sans: 'Geist' }, groups: [] },
      spacing: { tokens: [{ name: 'space-4', value: '4px', usage: 'Gap.' }] },
      radius: { tokens: [] },
      shadow: { tokens: [] },
      size: { tokens: [] },
    });
    expect(tokens).toContain('export const MT_TOKENS = {');
    expect(tokens).toContain('"bg-canvas"');
    expect(tokens).toContain('export type MtTokenName');

    const icons = renderIconsTs({
      icons: { search: '<circle cx="11" cy="11" r="8"/>' },
      status: { draft: '<svg class="mt-status"></svg>' },
    });
    expect(icons).toContain('"name": "mt-search"');
    expect(icons).toContain('satisfies Record<string, LucideIconData>');
    expect(icons).toContain('export type MtStatusKind');
  });

  it('reports changed and stale files, and writes them', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sync-design-'));
    mkdirSync(path.join(root, 'out'), { recursive: true });
    writeFileSync(path.join(root, 'out/old.css'), 'stale');
    writeFileSync(path.join(root, 'out/same.css'), 'same');
    const out: SyncOutput = {
      files: new Map<string, string | Buffer>([
        ['out/same.css', 'same'],
        ['out/new.css', 'new'],
        ['fonts/a.woff2', Buffer.from([1, 2, 3])],
      ]),
      ownedDirs: ['out', 'missing'],
    };
    expect(diffOutputs(root, out)).toEqual(['fonts/a.woff2', 'out/new.css', 'out/old.css (stale)']);
    writeOutputs(root, out);
    expect(diffOutputs(root, out)).toEqual([]);
    expect(readFileSync(path.join(root, 'out/new.css'), 'utf8')).toBe('new');
  });

  it('the repository outputs are in sync with design/ (needs python3)', async () => {
    const cwd = process.cwd();
    process.chdir(path.resolve(import.meta.dirname, '../../..'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(main(['--check'])).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith('Design outputs are in sync.');
    } finally {
      log.mockRestore();
      process.chdir(cwd);
    }
  });
});
