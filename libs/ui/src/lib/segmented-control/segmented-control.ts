import { ChangeDetectionStrategy, Component, computed, input, signal, ViewEncapsulation } from '@angular/core';
import { NgpToggleGroup, NgpToggleGroupItem } from 'ng-primitives/toggle-group';

import { MtFormControl } from '../forms/form-control';
import type { MtOption } from '../forms/options';
import { MtIcon } from '../icon/icon';

/**
 * Segmented control (`mt-segmented-control`): switch the layout of the same data (List, Board,
 * Timeline). Two to four one-word items, single select; one item is always selected. Arrow keys move
 * between items. `label` names the group for screen readers.
 */
@Component({
  selector: 'mt-segmented-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/seg.css',
  imports: [NgpToggleGroup, NgpToggleGroupItem, MtIcon],
  host: { style: 'display: contents' },
  template: `
    <div
      ngpToggleGroup
      class="mt-seg"
      ngpToggleGroupType="single"
      [ngpToggleGroupAllowDeselection]="false"
      [ngpToggleGroupValue]="selection()"
      [ngpToggleGroupDisabled]="isDisabled()"
      [attr.aria-label]="label()"
      (ngpToggleGroupValueChange)="select($event)"
      (focusout)="onTouched()"
    >
      @for (option of options(); track option.value) {
        <button
          type="button"
          ngpToggleGroupItem
          class="mt-seg-item"
          [ngpToggleGroupItemValue]="option.value"
          [ngpToggleGroupItemDisabled]="!!option.disabled"
        >
          @if (option.icon; as icon) {
            <mt-icon [name]="icon" [size]="14" />
          }
          {{ option.label }}
        </button>
      }
    </div>
  `,
})
export class MtSegmentedControl<T = string> extends MtFormControl<T | null> {
  readonly options = input.required<readonly MtOption<T>[]>();
  /** Accessible name for the group ("Matters view"). */
  readonly label = input.required<string>();

  protected readonly value = signal<T | null>(null);
  protected readonly selection = computed(() => {
    const value = this.value();
    return value === null ? [] : [value];
  });

  writeValue(value: T | null): void {
    this.value.set(value ?? null);
  }

  protected select(values: T[]): void {
    const value = values[0] ?? null;
    if (value === null) return;
    this.value.set(value);
    this.onChange(value);
  }
}
