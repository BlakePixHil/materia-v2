/**
 * Guided tours (CORE-24): a tour is data. Each step points at a feature on the page (a `data-tour`
 * attribute, or another stable selector) and says what it is for in a sentence or two.
 */
export interface TourStep {
  /**
   * Where the spotlight goes: selectors tried in order, the first one on screen wins (a phone has
   * the TabBar where a laptop has the sidebar). A step without a target shows the card centred; a
   * step whose target isn't on this screen is left out.
   */
  target?: string | readonly string[] | undefined;
  title: string;
  body: string;
  /** A shortcut shown after the body (Kbd syntax: `mod+k`, `shift+h`). */
  kbd?: string | undefined;
}

export interface Tour {
  /** Kept in `users/{uid}.prefs.tours.seen` once finished or skipped: lower-case words and hyphens. */
  id: string;
  /** The page's name, shown on each card ("Today · 2 of 5"). */
  title: string;
  /** The page paths (without the query) this tour belongs to. The welcome tour has none. */
  match?: RegExp | undefined;
  /** The first card offers Skip and "Show me around" instead of Back and Next (the welcome tour). */
  intro?: boolean | undefined;
  steps: readonly TourStep[];
}

/** How a tour ended: finished (Done) or ended early (Skip, the close button or Escape). */
export interface TourResult {
  tourId: string;
  finished: boolean;
  /** The step it ended on (0 is the first). */
  step: number;
}
