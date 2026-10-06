/*
 * `@materia/ui/charts`: `mt-bar-chart`, `mt-line-chart` and their scales (Clerk usage, AI-13; Insights).
 * A separate entry, not part of the `@materia/ui` barrel, so the charts load with the lazy pages that
 * draw them: anything the barrel reaches and a lazy page uses lands in the initial bundle.
 */
export * from './lib/charts/scales';
export * from './lib/charts/chart-base';
export * from './lib/charts/bar-chart';
export * from './lib/charts/line-chart';
