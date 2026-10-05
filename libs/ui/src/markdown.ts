/*
 * `@materia/ui/markdown`: the safe Markdown subset (`parseMarkdown`), its renderers for notes
 * (`mt-markdown`, CORE-13) and Clerk answers (`mt-clerk-message`). It's a separate entry, not part of
 * the `@materia/ui` barrel, so the parser loads with the lazy pages that render Markdown: anything
 * the barrel reaches and a lazy page uses lands in the initial bundle.
 */
export * from './lib/clerk/markdown';
export * from './lib/clerk/clerk-message';
export * from './lib/markdown/markdown-view';
