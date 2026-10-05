/**
 * Untrusted framing (AI-03): everything from the practice's files reaches the model inside tags
 * the base system prompt names as data. Text inside can't close or open those tags, so a document
 * can't pretend its content ended and instructions began.
 */

/** The tags the system prompt treats as data (`<context_notice>` is Materia's own). */
export const UNTRUSTED_TAGS = ['matter_facts', 'matter_note', 'document', 'excerpt', 'org_metrics'] as const;
const FRAMING_TAGS = [...UNTRUSTED_TAGS, 'context_notice'];

const TAG_PATTERN = new RegExp(`<(\\/?)(${FRAMING_TAGS.join('|')})(?=[\\s>/])`, 'gi');

/** Neutralises any framing tag inside untrusted text (`</document>` becomes `&lt;/document>`). */
export function escapeFraming(text: string): string {
  return text.replace(TAG_PATTERN, '&lt;$1$2');
}

/** An attribute value: no quotes, angle brackets or line breaks. */
function attr(value: string | number | boolean): string {
  return String(value).replace(/["<>\r\n]/g, ' ');
}

export function openTag(
  tag: (typeof UNTRUSTED_TAGS)[number] | 'context_notice',
  attrs: Record<string, string | number | boolean | undefined> = {},
): string {
  const rendered = Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${attr(value as string | number | boolean)}"`)
    .join('');
  return `<${tag}${rendered}>`;
}

/** Wraps already-escaped text in a tag. */
export function wrap(
  tag: (typeof UNTRUSTED_TAGS)[number] | 'context_notice',
  body: string,
  attrs: Record<string, string | number | boolean | undefined> = {},
): string {
  return `${openTag(tag, attrs)}\n${body}\n</${tag}>`;
}

/**
 * JSON for the model: compact, and with `<` escaped as `<` (still valid JSON), so a value
 * can't contain a tag at all.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Cuts text to `max` characters with a visible marker that says how much was left out. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const omitted = text.length - max;
  return {
    text: `${text.slice(0, max)}\n[… truncated: ${omitted.toLocaleString('en-AU')} more characters]`,
    truncated: true,
  };
}
