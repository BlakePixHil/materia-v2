import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type LucideIcon, LucideDynamicIcon } from '@lucide/angular';

import { MT_ICONS, type MtIconName } from '../../generated/icons';

export type MtIconSize = 14 | 16 | 20;

/** Stroke width from the brand book: Lucide on a 24px grid with a 1.6 stroke. */
export const MT_ICON_STROKE = 1.6;

const SIZE_ATTR: Record<MtIconSize, string | null> = { 14: 'sm', 16: null, 20: 'lg' };

/**
 * A Lucide icon at a design-system size. `name` is a Materia icon name (`'matters'`, `'court'`, …)
 * or any Lucide icon component (`LucideHouse`). Decorative unless `label` is set.
 */
@Component({
  selector: 'mt-icon',
  imports: [LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `<svg
    class="mt-i"
    [lucideIcon]="icon()"
    [size]="size()"
    [strokeWidth]="stroke"
    [title]="label()"
    [attr.data-size]="sizeAttr()"
    [attr.role]="label() ? 'img' : null"
  ></svg>`,
})
export class MtIcon {
  readonly name = input.required<MtIconName | LucideIcon>();
  readonly size = input<MtIconSize>(16);
  /** Accessible name; omit for decorative icons next to a text label. */
  readonly label = input<string>();

  protected readonly stroke = MT_ICON_STROKE;
  protected readonly icon = computed(() => {
    const name = this.name();
    return typeof name === 'string' ? MT_ICONS[name] : name;
  });
  protected readonly sizeAttr = computed(() => SIZE_ATTR[this.size()]);
}
