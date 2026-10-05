/*
 * `@materia/ui/suggestion`: `mt-suggestion`, a Clerk proposal card (AI-07). A separate entry, not part
 * of the `@materia/ui` barrel, so it loads with the lazy pages that show suggestions (the matter
 * Overview now; the Clerk panel and the Inbox later) instead of in the initial bundle.
 */
export * from './lib/clerk/suggestion';
