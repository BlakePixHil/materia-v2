/**
 * The first Firestore answer after a full page load (`goto`, a reload, or the fresh page after an
 * org switch), or the first answer to a new query: the app boots, restores the session and opens
 * its listeners. Playwright's default 5 s isn't enough in CI while the other specs keep the
 * emulators busy; every later assertion on the same page keeps the default.
 */
export const FIRST_LOAD = { timeout: 20_000 };

/**
 * The answer to the first call of a callable in an emulator run, for `page.waitForResponse`. The
 * Functions emulator starts that function's worker (loading the whole functions bundle) before it
 * runs, and on a busy CI runner that adds seconds (templates.spec's upgrade: 8 s from the CORS
 * preflight to the response, on a runner slow enough that the page took seconds more to send it).
 * Wait for the response itself rather than a longer UI wait, so a slow server and a missing
 * confirmation fail differently; the UI check after it keeps the default.
 */
export const FIRST_CALL = { timeout: 45_000 };
