/*
 * `@materia/domain/quick-add` (CORE-08): the tasks quick-add parser. A separate entry point because
 * it brings chrono-node: import it from lazily loaded routes only, never from the app shell.
 */
export * from './quick-add';
