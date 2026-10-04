/**
 * The quick-add parser (CORE-08), on its own so it loads lazily: it brings chrono-node, which must
 * stay out of the initial bundle. Only `task-quick-add.ts` imports this file, dynamically.
 */
export { parseQuickAdd } from '@materia/domain/quick-add';
