/**
 * The Matters page's layout (CORE-04), remembered on this device. Kept free of imports: the
 * `/matters` route reads it to reopen the board, so it ships with the app's routes.
 */

/** List or board: the Matters page's layout, remembered on this device. */
export type MattersLayout = 'list' | 'board';

/** Where the Matters page remembers its layout and the board's swimlanes (cleared at sign-out). */
export const LAYOUT_KEY = 'materia.matters.layout';
export const SWIMLANES_KEY = 'materia.matters.swimlanes';

export function readLayout(): MattersLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

export function writeLayout(layout: MattersLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Not remembered (private window); the list stands next time.
  }
}

export function readSwimlanes(): boolean {
  try {
    return localStorage.getItem(SWIMLANES_KEY) === 'responsible';
  } catch {
    return false;
  }
}

export function writeSwimlanes(on: boolean): void {
  try {
    if (on) localStorage.setItem(SWIMLANES_KEY, 'responsible');
    else localStorage.removeItem(SWIMLANES_KEY);
  } catch {
    // Not remembered.
  }
}
