/** The lazily loaded parser module (`quick-add-parser.ts`). */
export type QuickAddParser = typeof import('./quick-add-parser');

/**
 * The parser brings chrono-node, so it loads in its own chunk: preloaded when a task list opens (so
 * quick-add still understands tokens after going offline), and retried if the fetch failed.
 */
let parser: Promise<QuickAddParser> | null = null;
export function loadQuickAddParser(): Promise<QuickAddParser> {
  parser ??= import('./quick-add-parser').catch((error: unknown) => {
    parser = null;
    throw error;
  });
  return parser;
}
