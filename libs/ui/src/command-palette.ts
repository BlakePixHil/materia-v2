/*
 * `@materia/ui/command-palette`: `mt-command-palette` and its overlay (FND-09, CORE-15). A separate
 * entry, not part of the `@materia/ui` barrel, so the palette loads with the lazily loaded ⌘K
 * dialog instead of in the initial bundle.
 */
export * from './lib/command-palette/command-palette';
