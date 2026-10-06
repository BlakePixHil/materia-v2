import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

/**
 * Component styles that can't apply in the running app. Two ways it has happened:
 *
 * 1. Emulated encapsulation scopes every selector to the template's elements (`[_ngcontent-…]`),
 *    so a rule on the component's own host class (`host: { class: 'mt-timer' }` with
 *    `.mt-timer { … }`) or its own selector (`mt-fee-dialog .grid`) never matches. Use `:host`, or
 *    `ViewEncapsulation.None` with the host class (the libs/ui convention).
 * 2. A design-system class from `libs/ui/src/generated/components/*.css` (`mt-card`, `mt-menu`…)
 *    used in a template whose component doesn't load that stylesheet. Angular adds a component's
 *    styles only once it renders, so the class is styled only after some other component that
 *    loads the file has rendered: a fresh load of that page shows it unstyled.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const generated = path.join(root, 'libs/ui/src/generated/components');

interface ComponentInfo {
  file: string;
  selector: string;
  emulated: boolean;
  hostClasses: string[];
  template: string;
  inlineCss: string;
  /** Basenames of the generated stylesheets it loads through `styleUrls`. */
  generatedSheets: Set<string>;
  /** Its own CSS (inline styles and local style files). */
  ownCss: string;
}

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'apps/web/src/**/*.ts', 'libs/ui/src/**/*.ts'], { cwd: root })
    .toString()
    .trim()
    .split('\n')
    .filter((file) => !file.endsWith('.spec.ts') && !file.endsWith('.stories.ts'));
}

function text(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return null;
}

function texts(node: ts.Expression | undefined): string[] {
  if (!node) return [];
  const items = ts.isArrayLiteralExpression(node) ? [...node.elements] : [node];
  return items.map(text).filter((value): value is string => value !== null);
}

function components(): ComponentInfo[] {
  const found: ComponentInfo[] = [];
  for (const file of sourceFiles()) {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isDecorator(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText() === 'Component'
      ) {
        const config = node.expression.arguments[0];
        if (config && ts.isObjectLiteralExpression(config)) found.push(componentInfo(file, config));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function componentInfo(file: string, config: ts.ObjectLiteralExpression): ComponentInfo {
  const prop = (name: string) =>
    config.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === name,
    )?.initializer;
  const hostClasses: string[] = [];
  const host = prop('host');
  if (host && ts.isObjectLiteralExpression(host)) {
    for (const entry of host.properties) {
      if (!ts.isPropertyAssignment(entry)) continue;
      const key = entry.name.getText().replace(/['"]/g, '');
      if (key === 'class') hostClasses.push(...(text(entry.initializer) ?? '').split(/\s+/).filter(Boolean));
      const bound = /^\[class\.([\w-]+)\]$/.exec(key);
      if (bound?.[1]) hostClasses.push(bound[1]);
    }
  }
  const inlineCss = texts(prop('styles')).join('\n');
  const generatedSheets = new Set<string>();
  let ownCss = inlineCss;
  for (const url of texts(prop('styleUrls') ?? prop('styleUrl'))) {
    if (url.includes('generated/components/')) generatedSheets.add(path.basename(url));
    else ownCss += '\n' + readFileSync(path.join(root, path.dirname(file), url), 'utf8');
  }
  return {
    file,
    selector: text(prop('selector')) ?? '',
    emulated: !/ViewEncapsulation\.(None|ShadowDom)/.test(prop('encapsulation')?.getText() ?? ''),
    hostClasses,
    template: text(prop('template')) ?? '',
    inlineCss,
    generatedSheets,
    ownCss,
  };
}

/** Every selector in a stylesheet (rules inside @media and @supports included). */
function selectors(css: string): string[] {
  const out: string[] = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const selector = part.trim();
      if (selector && !selector.startsWith('@') && !/^(from|to|\d+%)$/.test(selector)) out.push(selector);
    }
  }
  return out;
}

const escape = (value: string) => value.replace(/[-[\]]/g, '\\$&');

/** The generated stylesheets that define each class, and those the web app loads globally. */
function designClasses(): { owners: Map<string, Set<string>>; global: Set<string>; globalCss: string } {
  const owners = new Map<string, Set<string>>();
  for (const sheet of readdirSync(generated)) {
    if (sheet === 'bundle.css' || !sheet.endsWith('.css')) continue;
    const css = readFileSync(path.join(generated, sheet), 'utf8');
    for (const selector of selectors(css)) {
      for (const match of selector.matchAll(/\.(mt-[\w-]+)/g)) {
        const name = match[1] ?? '';
        owners.set(name, (owners.get(name) ?? new Set()).add(sheet));
      }
    }
  }
  const project = JSON.parse(readFileSync(path.join(root, 'apps/web/project.json'), 'utf8')) as {
    targets: { build: { options: { styles: string[] } } };
  };
  const styles = project.targets.build.options.styles;
  const global = new Set(styles.filter((s) => s.includes('generated/components/')).map((s) => path.basename(s)));
  const globalCss = styles
    .filter((s) => !s.includes('generated/components/'))
    .map((s) => readFileSync(path.join(root, s), 'utf8'))
    .join('\n');
  return { owners, global, globalCss };
}

describe('component styles', () => {
  const all = components();

  it('finds the components', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('never targets its own host from emulated styles (they would never match)', () => {
    const problems: string[] = [];
    for (const component of all.filter((c) => c.emulated)) {
      for (const selector of selectors(component.ownCss)) {
        if (selector.startsWith(':host') || selector.includes('::ng-deep')) continue;
        const first = selector.split(/[\s>+~]/)[0] ?? '';
        const own = [
          ...component.hostClasses.map((c) => new RegExp(`^\\.${escape(c)}(?![\\w-])`)),
          ...(component.selector ? [new RegExp(`^${escape(component.selector)}(?![\\w-])`)] : []),
        ];
        if (own.some((pattern) => pattern.test(first))) problems.push(`${component.file}: ${selector}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('loads the design-system stylesheet for every design class its template uses', () => {
    const { owners, global, globalCss } = designClasses();
    const problems: string[] = [];
    for (const component of all) {
      const used = new Set<string>();
      for (const match of component.template.matchAll(/\bclass="([^"]*)"/g)) {
        for (const name of (match[1] ?? '').split(/\s+/)) if (name.startsWith('mt-')) used.add(name);
      }
      for (const match of component.template.matchAll(/\[class\.(mt-[\w-]+)\]/g)) used.add(match[1] ?? '');
      for (const name of used) {
        const sheets = owners.get(name);
        if (!sheets) continue;
        if ([...sheets].some((sheet) => component.generatedSheets.has(sheet) || global.has(sheet))) continue;
        if (new RegExp(`\\.${escape(name)}(?![\\w-])`).test(component.ownCss + globalCss)) continue;
        problems.push(`${component.file}: .${name} needs ${[...sheets].join(' or ')}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
