/** Where the spotlight and the card go (CORE-24). Pure functions, so placement is unit-tested. */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Placement = 'below' | 'above' | 'right' | 'left' | 'over';

/** Room around the feature inside the spotlight. */
export const SPOT_PAD = 6;
/** Between the spotlight and the card. */
export const CARD_GAP = 12;
/** Kept clear at the screen's edges. */
export const EDGE = 12;
/** Under this width the card docks to the top or bottom edge instead of sitting beside the feature. */
export const PHONE_MAX = 767;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The spotlight around a feature: padded, and cut to the screen when the feature is bigger. */
export function spotFor(rect: Box, viewport: Size, pad = SPOT_PAD): Box {
  const top = Math.max(rect.top - pad, EDGE / 2);
  const left = Math.max(rect.left - pad, EDGE / 2);
  const bottom = Math.min(rect.top + rect.height + pad, viewport.height - EDGE / 2);
  const right = Math.min(rect.left + rect.width + pad, viewport.width - EDGE / 2);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * The card's corner beside the spotlight: below it if it fits, else above, right, left, and
 * otherwise over its lower part (a feature that fills the screen). Never off screen.
 */
export function placeCard(spot: Box, card: Size, viewport: Size): { top: number; left: number; placement: Placement } {
  const maxLeft = Math.max(EDGE, viewport.width - EDGE - card.width);
  const maxTop = Math.max(EDGE, viewport.height - EDGE - card.height);
  const centredLeft = clamp(spot.left + spot.width / 2 - card.width / 2, EDGE, maxLeft);
  const centredTop = clamp(spot.top + spot.height / 2 - card.height / 2, EDGE, maxTop);
  const below = spot.top + spot.height + CARD_GAP;
  if (below + card.height <= viewport.height - EDGE) return { top: below, left: centredLeft, placement: 'below' };
  const above = spot.top - CARD_GAP - card.height;
  if (above >= EDGE) return { top: above, left: centredLeft, placement: 'above' };
  const right = spot.left + spot.width + CARD_GAP;
  if (right + card.width <= viewport.width - EDGE) return { top: centredTop, left: right, placement: 'right' };
  const left = spot.left - CARD_GAP - card.width;
  if (left >= EDGE) return { top: centredTop, left, placement: 'left' };
  return { top: maxTop, left: centredLeft, placement: 'over' };
}

/** On a phone: the card docks away from the feature, to the top when the feature is low on screen. */
export function dockFor(spot: Box | null, viewport: Size): 'top' | 'bottom' {
  return spot && spot.top + spot.height / 2 > viewport.height / 2 ? 'top' : 'bottom';
}

/** Whether a box lies wholly on screen. */
export function onScreen(rect: Box, viewport: Size): boolean {
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.top + rect.height <= viewport.height &&
    rect.left + rect.width <= viewport.width
  );
}

/**
 * An element's box. Hosts with `display: contents` have none of their own, so theirs is the
 * union of their children's. Null when nothing of it is rendered (hidden, or not laid out).
 */
export function elementBox(element: Element, depth = 3): Box | null {
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style?.visibility === 'hidden'
      ? null
      : { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }
  if (depth <= 0) return null;
  const boxes = [...element.children].map((child) => elementBox(child, depth - 1)).filter((box): box is Box => !!box);
  if (!boxes.length) return null;
  const top = Math.min(...boxes.map((b) => b.top));
  const left = Math.min(...boxes.map((b) => b.left));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  return { top, left, width: right - left, height: bottom - top };
}

/** The first of a step's selectors whose element is rendered. */
export function findTarget(root: ParentNode, target: string | readonly string[] | undefined): Element | null {
  if (!target) return null;
  for (const selector of typeof target === 'string' ? [target] : target) {
    for (const element of root.querySelectorAll(selector)) if (elementBox(element)) return element;
  }
  return null;
}
