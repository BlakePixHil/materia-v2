/**
 * Keeping a denormalised `search` field (ADR-013, CORE-15): triggers compute the tokens from the
 * document they just read and write them only when they changed, so their own write is a no-op
 * next time (no loop).
 */
export function searchPatch(current: Record<string, unknown>, tokens: readonly string[]): { search?: string[] } {
  const stored = current['search'];
  const same =
    Array.isArray(stored) && stored.length === tokens.length && stored.every((token, i) => token === tokens[i]);
  return same ? {} : { search: [...tokens] };
}
