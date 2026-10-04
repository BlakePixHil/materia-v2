import { ChangeDetectionStrategy, Component, computed, inject, input, signal, ViewEncapsulation } from '@angular/core';
import { NgpDescription, NgpFormField, NgpLabel } from 'ng-primitives/form-field';
import { NgpRadioGroup, NgpRadioItem } from 'ng-primitives/radio';

import { MT_ERROR_MESSAGES, mtErrorMessage } from '../forms/error-messages';
import { MtFormControl } from '../forms/form-control';
import type { MtOption } from '../forms/options';
import { MtIcon } from '../icon/icon';

let nextId = 0;

/**
 * ChoiceCard group (`mt-choice-cards`): pick one of a few big options, each a card with an icon, a title
 * and a line of explanation ("Where are your matters now?"). Behaves as a radio group: arrow keys move
 * and select, Tab moves in and out. Works with forms like any control.
 */
@Component({
  selector: 'mt-choice-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/label.css',
    '../../generated/components/choice.css',
    '../../generated/components/error.css',
    '../../generated/components/layout.css',
  ],
  imports: [NgpRadioGroup, NgpRadioItem, NgpLabel, NgpDescription, MtIcon],
  hostDirectives: [NgpFormField],
  host: { style: 'display: contents' },
  template: `
    <div
      ngpRadioGroup
      class="mt-col"
      [ngpRadioGroupValue]="value()"
      ngpRadioGroupOrientation="vertical"
      [ngpRadioGroupDisabled]="isDisabled()"
      (ngpRadioGroupValueChange)="select($event)"
      (focusout)="onTouched()"
    >
      @if (label(); as text) {
        <span ngpLabel class="mt-label">{{ text }}</span>
      }
      @for (option of options(); track option.value) {
        <div
          ngpRadioItem
          class="mt-choice-card"
          [ngpRadioItemValue]="option.value"
          [ngpRadioItemDisabled]="!!option.disabled"
          [attr.data-selected]="option.value === value() ? '' : null"
          [attr.aria-labelledby]="itemId + '-' + $index"
          [attr.aria-describedby]="option.description ? itemId + '-' + $index + '-d' : null"
        >
          @if (option.icon; as icon) {
            <span class="glyph" aria-hidden="true"><mt-icon [name]="icon" [size]="20" /></span>
          }
          <div>
            <div class="tt" [id]="itemId + '-' + $index">{{ option.label }}</div>
            @if (option.description; as text) {
              <div class="ts" [id]="itemId + '-' + $index + '-d'">{{ text }}</div>
            }
          </div>
        </div>
      }
    </div>
    @if (errorText(); as message) {
      <p ngpDescription class="mt-error"><mt-icon name="alert" [size]="14" />{{ message }}</p>
    }
  `,
})
export class MtChoiceCards<T = string> extends MtFormControl<T | null> {
  readonly options = input.required<readonly MtOption<T>[]>();
  readonly label = input<string>();

  protected readonly value = signal<T | null>(null);
  protected readonly itemId = `mt-choice-card-${++nextId}`;
  private readonly defaultMessages = inject(MT_ERROR_MESSAGES);
  protected readonly errorText = computed(() =>
    this.isInvalid() ? mtErrorMessage(this.formErrors(), {}, this.defaultMessages) : null,
  );

  writeValue(value: T | null): void {
    this.value.set(value ?? null);
  }

  protected select(value: T | null): void {
    this.value.set(value);
    this.onChange(value);
  }
}
