import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { MT_ICONS, type MtIconName, type MtIconNode } from '../../generated/icons';

export type MtIconSize = 14 | 16 | 20;

/** Stroke width from the brand book: Lucide on a 24px grid with a 1.6 stroke. */
export const MT_ICON_STROKE = 1.6;

const SIZE_ATTR: Record<MtIconSize, string | null> = { 14: 'sm', 16: null, 20: 'lg' };

/**
 * A Lucide icon at a design-system size. `name` is a Materia icon name (`'matters'`, `'court'`, …)
 * or any Lucide icon node from the data-only `lucide` package (`import { House } from 'lucide'`).
 * Decorative unless `label` is set.
 *
 * The SVG is rendered here rather than through an Angular icon library: those ship every icon as
 * a compiled component, which made builds slow and memory-hungry.
 */
@Component({
  selector: 'mt-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `<svg
    xmlns="http://www.w3.org/2000/svg"
    class="mt-i"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    [attr.width]="size()"
    [attr.height]="size()"
    [attr.stroke-width]="stroke"
    [attr.data-size]="sizeAttr()"
    [attr.role]="label() ? 'img' : null"
    [attr.aria-hidden]="label() ? null : 'true'"
  >
    @if (label(); as text) {
      <svg:title>{{ text }}</svg:title>
    }
    @for (node of nodes(); track $index) {
      @let a = node[1];
      @switch (node[0]) {
        @case ('path') {
          <svg:path [attr.d]="a['d']" />
        }
        @case ('circle') {
          <svg:circle [attr.cx]="a['cx']" [attr.cy]="a['cy']" [attr.r]="a['r']" />
        }
        @case ('rect') {
          <svg:rect
            [attr.x]="a['x']"
            [attr.y]="a['y']"
            [attr.width]="a['width']"
            [attr.height]="a['height']"
            [attr.rx]="a['rx']"
            [attr.ry]="a['ry']"
          />
        }
        @case ('line') {
          <svg:line [attr.x1]="a['x1']" [attr.y1]="a['y1']" [attr.x2]="a['x2']" [attr.y2]="a['y2']" />
        }
        @case ('polyline') {
          <svg:polyline [attr.points]="a['points']" />
        }
        @case ('polygon') {
          <svg:polygon [attr.points]="a['points']" />
        }
        @case ('ellipse') {
          <svg:ellipse [attr.cx]="a['cx']" [attr.cy]="a['cy']" [attr.rx]="a['rx']" [attr.ry]="a['ry']" />
        }
      }
    }
  </svg>`,
})
export class MtIcon {
  readonly name = input.required<MtIconName | MtIconNode>();
  readonly size = input<MtIconSize>(16);
  /** Accessible name; omit for decorative icons next to a text label. */
  readonly label = input<string>();

  protected readonly stroke = MT_ICON_STROKE;
  protected readonly nodes = computed<MtIconNode>(() => {
    const name = this.name();
    return typeof name === 'string' ? MT_ICONS[name] : name;
  });
  protected readonly sizeAttr = computed(() => SIZE_ATTR[this.size()]);
}
