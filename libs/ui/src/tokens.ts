import type { MtTokenName } from './generated/tokens';

export * from './generated/tokens';

/** `var(--name)` for a design token, e.g. `cssVar('chart-1')` for chart colours. */
export function cssVar(name: MtTokenName): string {
  return `var(--${name})`;
}
