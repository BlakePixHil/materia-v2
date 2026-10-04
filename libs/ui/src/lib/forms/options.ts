import type { MtIconName, MtIconNode } from '../../generated/icons';

/** One choice in a RadioGroup, SegmentedControl or Select. */
export interface MtOption<T = string> {
  value: T;
  label: string;
  /** Secondary text (RadioGroup). */
  description?: string;
  icon?: MtIconName | MtIconNode;
  disabled?: boolean;
}

/** A labelled group of options (Select). */
export interface MtOptionGroup<T = string> {
  label: string;
  options: readonly MtOption<T>[];
}

export function isOptionGroup<T>(item: MtOption<T> | MtOptionGroup<T>): item is MtOptionGroup<T> {
  return 'options' in item;
}

/** Flattens groups into one list, in display order. */
export function flattenOptions<T>(items: readonly (MtOption<T> | MtOptionGroup<T>)[]): MtOption<T>[] {
  return items.flatMap((item) => (isOptionGroup(item) ? [...item.options] : [item]));
}
