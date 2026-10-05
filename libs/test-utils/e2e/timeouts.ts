/**
 * The first Firestore answer after a full page load (`goto`, a reload, or the fresh page after an
 * org switch), or the first answer to a new query: the app boots, restores the session and opens
 * its listeners. Playwright's default 5 s isn't enough in CI while the other specs keep the
 * emulators busy; every later assertion on the same page keeps the default.
 */
export const FIRST_LOAD = { timeout: 20_000 };
