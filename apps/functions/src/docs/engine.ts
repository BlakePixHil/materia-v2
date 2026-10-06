import Docxtemplater from 'docxtemplater';

import {
  checkMergeTags,
  formatMergeValue,
  isBlankValue,
  missingMarker,
  parseMergeTag,
  resolveMergeTag,
  templateFields,
  valueAt,
  type DocTemplateProblem,
  type TemplateTag,
} from '@materia/domain';

import { fontWarnings, NotDocxError, openDocx, paragraphStyles, templateFonts } from './docx';
import { markdownToWordml } from './markdown';

/**
 * The docx merge engine (INT-06, ADR-047): docxtemplater core with our own tag parser, so a tag is a
 * catalogue path with formatters (`{deceased.dateOfDeath|date}`), never an expression. Loops and
 * conditions are docxtemplater's (`{#executors}…{/executors}`, `{^client.email}…{/client.email}`);
 * `{@body}` takes Markdown, converted to Word paragraphs. A field with no value prints
 * `[[missing: client.address]]` and is reported.
 */

type Part = { type?: string; value?: string; module?: string; subparsed?: Part[] };

/** The tags of every part (body, headers, footers), with the loops each sits in. */
function collectTags(doc: Docxtemplater): TemplateTag[] {
  const tags: TemplateTag[] = [];
  const walk = (parts: readonly Part[], scope: readonly string[]) => {
    for (const part of parts) {
      if (part.type !== 'placeholder' || part.value === undefined) continue;
      const kind = part.module === 'loop' ? 'section' : part.module === 'rawxml' ? 'block' : 'value';
      tags.push({ value: part.value, kind, scope });
      if (part.subparsed) walk(part.subparsed, [...scope, part.value]);
    }
  };
  const compiled = (doc as unknown as { compiled: Record<string, { postparsed: Part[] }> }).compiled;
  for (const name of Object.keys(compiled).sort()) walk(compiled[name]?.postparsed ?? [], []);
  return tags;
}

interface XtError {
  properties?: { id?: string; xtag?: string; explanation?: string; errors?: XtError[] };
}

/** docxtemplater's syntax errors as problems that name the tag. */
function syntaxProblems(error: unknown): DocTemplateProblem[] {
  const errors = (error as XtError).properties?.errors ?? [error as XtError];
  return errors.map((e) => {
    const id = e.properties?.id ?? '';
    const xtag = e.properties?.xtag ?? '';
    const messages: Record<string, string> = {
      unclosed_tag: `The tag {${xtag} has no closing brace.`,
      unopened_tag: `The tag ${xtag}} has no opening brace.`,
      duplicate_open_tag: `The tag {{${xtag} has two opening braces.`,
      duplicate_close_tag: `The tag ${xtag}}} has two closing braces.`,
      unclosed_loop: `{#${xtag}} is never closed. Add {/${xtag}} where it should end.`,
      unopened_loop: `{/${xtag}} closes a section that was never opened. Add {#${xtag}} where it should start.`,
      closing_tag_does_not_match_opening_tag: `A section is closed with the wrong name near {/${xtag}}.`,
      raw_xml_tag_should_be_only_text_in_paragraph: `{@${xtag}} must be on a paragraph of its own.`,
      raw_tag_outerxml_invalid: `{@${xtag}} must be on a paragraph of its own.`,
    };
    return {
      tag: xtag ? `{${xtag}}` : 'the template',
      code: 'syntax' as const,
      message: messages[id] ?? e.properties?.explanation ?? 'The template has a tag Materia can’t read.',
    };
  });
}

export interface InspectedTemplate {
  tags: TemplateTag[];
  fields: string[];
  problems: DocTemplateProblem[];
  warnings: string[];
}

// errorLogging off: problems are returned, never written to the console (no PII in logs).
const OPTIONS = { paragraphLoop: true, linebreaks: true, errorLogging: false } as const;

/** Reads a template without merging it: its tags, the fields they use, problems and warnings. */
export function inspectTemplate(data: Uint8Array): InspectedTemplate {
  let zip;
  try {
    zip = openDocx(data);
  } catch (error) {
    if (!(error instanceof NotDocxError)) throw error;
    const problem = { tag: 'the file', code: 'syntax' as const, message: 'This isn’t a Word document (.docx).' };
    return { tags: [], fields: [], problems: [problem], warnings: [] };
  }
  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, { ...OPTIONS, parser: () => ({ get: () => undefined }) });
  } catch (error) {
    return { tags: [], fields: [], problems: syntaxProblems(error), warnings: [] };
  }
  const tags = collectTags(doc);
  const problems = dedupe(checkMergeTags(tags));
  return { tags, fields: templateFields(tags), problems, warnings: fontWarnings(templateFonts(zip)) };
}

const dedupe = (problems: DocTemplateProblem[]) => {
  const seen = new Set<string>();
  return problems.filter((p) => (seen.has(p.message) ? false : (seen.add(p.message), true)));
};

export interface MergeResult {
  output: Buffer;
  /** Fields with no value, as full paths, in the order they were met. */
  missing: string[];
}

/** A template that failed to merge (its tags were checked at upload, so this is rare). */
export class TemplateMergeError extends Error {
  constructor(readonly problems: DocTemplateProblem[]) {
    super('The template could not be merged');
    this.name = 'TemplateMergeError';
  }
}

/** Fills a template with merge data. Unknown tags print as missing rather than failing. */
export function mergeTemplate(data: Uint8Array, mergeData: Record<string, unknown>): MergeResult {
  let zip;
  try {
    zip = openDocx(data);
  } catch {
    throw new TemplateMergeError([{ tag: 'the file', code: 'syntax', message: 'This isn’t a Word document (.docx).' }]);
  }
  const styles = paragraphStyles(zip);
  const missing: string[] = [];
  const report = (path: string) => {
    if (!missing.includes(path)) missing.push(path);
  };
  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, {
      ...OPTIONS,
      parser: (tag: string, meta?: { tag?: Part; scopePath?: string[] }) => {
        const { path, filters } = parseMergeTag(tag);
        const kind = meta?.tag?.module;
        const field = resolveMergeTag(path, meta?.scopePath ?? []).field;
        return {
          get(scope: unknown) {
            if (path === '.' || path === 'this') return scope;
            const value = valueAt(scope, path);
            if (isBlankValue(value)) return undefined;
            if (kind === 'loop') return value;
            if (kind === 'rawxml') return typeof value === 'string' ? markdownToWordml(value, { styles }) : undefined;
            const formatted = formatMergeValue(value, field, filters);
            return typeof formatted === 'string' || typeof formatted === 'number' ? String(formatted) : undefined;
          },
        };
      },
      nullGetter: (part: Part, scopeManager?: { scopePath?: string[] }) => {
        // An empty section is skipped; an empty body leaves a paragraph to type into.
        if (part.module === 'loop') return '';
        if (part.module === 'rawxml') return '<w:p/>';
        const resolved = resolveMergeTag(parseMergeTag(part.value ?? '').path, scopeManager?.scopePath ?? []);
        if (resolved.field?.optional) return '';
        report(resolved.path);
        return missingMarker(resolved.path);
      },
    });
    doc.render(mergeData);
  } catch (error) {
    throw new TemplateMergeError(syntaxProblems(error));
  }
  return { output: doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }), missing };
}
