/**
 * Raw markup for the design system's custom glyphs (design/system/icons.py). The Angular
 * StatusIcon and PriorityIcon components come in a later ticket; these are the sources they render.
 */
export { MT_STATUS_GLYPHS, type MtStatusKind } from '../generated/icons';

/**
 * PriorityIcon is three CSS bars (`.mt-priority[data-level]`), not an SVG: low fills one bar,
 * medium two, high three, and urgent is a red square with "!".
 */
export const MT_PRIORITY_LEVELS = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type MtPriorityLevel = (typeof MT_PRIORITY_LEVELS)[number];
