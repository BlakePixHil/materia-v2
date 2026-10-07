import * as z from 'zod';

import { DocIdSchema } from './schemas/common';

/*
 * Pinned matters (CORE-23): each person keeps up to ten matters in the sidebar's "Pinned" section,
 * in the order they pinned them. They live on `users/{uid}.pinnedMatterIds`, keyed by org, because
 * a person can belong to several practices and a matter id only means something in its own.
 */

/** How many matters one person can pin in one org. */
export const MAX_PINNED_MATTERS = 10;

/** `users/{uid}.pinnedMatterIds`: per org, the pinned matter ids in pinning order. */
export const PinnedMatterIdsSchema = z.record(DocIdSchema, z.array(DocIdSchema).max(MAX_PINNED_MATTERS));
export type PinnedMatterIds = z.infer<typeof PinnedMatterIdsSchema>;

/** One org's pins, as stored (a value that isn't a list of ids reads as none). */
export function pinsInOrg(stored: unknown, orgId: string): string[] {
  if (!stored || typeof stored !== 'object') return [];
  const ids = (stored as Record<string, unknown>)[orgId];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

/** What pinning or unpinning leaves: the org's next list, or `full` when there's no room. */
export type PinChange = { ids: string[] } | { full: true };

/**
 * Pins (`pin: true`) or unpins a matter. Ids in `gone` (matters the person can no longer read, or
 * that were deleted or destroyed) are pruned on the way; a new pin goes last. Pinning what's already
 * pinned, or unpinning what isn't, still prunes.
 */
export function changePins(
  current: readonly string[],
  matterId: string,
  pin: boolean,
  gone: ReadonlySet<string> = new Set(),
): PinChange {
  const kept = [...new Set(current)].filter((id) => !gone.has(id));
  if (!pin) return { ids: kept.filter((id) => id !== matterId) };
  if (kept.includes(matterId)) return { ids: kept };
  if (kept.length >= MAX_PINNED_MATTERS) return { full: true };
  return { ids: [...kept, matterId] };
}

/**
 * The stored map with one org's pins replaced (an empty list drops the org). Other orgs' entries
 * are copied as they are: the rules let a person change only their current org's pins.
 */
export function withPins(stored: unknown, orgId: string, ids: readonly string[]): PinnedMatterIds {
  const current = stored && typeof stored === 'object' ? (stored as PinnedMatterIds) : {};
  const others = Object.fromEntries(Object.entries(current).filter(([key]) => key !== orgId));
  return ids.length ? { ...others, [orgId]: [...ids] } : others;
}
