import { ChangeDetectionStrategy, Component, computed, inject, input, signal, ViewEncapsulation } from '@angular/core';
import type { NgpOrientation } from 'ng-primitives/common';
import { NgpDescription, NgpFormField, NgpLabel } from 'ng-primitives/form-field';
import { NgpRadioGroup, NgpRadioItem } from 'ng-primitives/radio';

import { MT_ERROR_MESSAGES, mtErrorMessage } from '../forms/error-messages';
import { MtFormControl } from '../forms/form-control';
import type { MtOption } from '../forms/options';
import { MtIcon } from '../icon/icon';

let nextId = 0;

/**
 * Radio group (`mt-radio-group`): pick exactly one of two to five visible options. Use a Select
 * for more than five. The `label` is the group's visible legend. Arrow keys move and select within
 * the group; Tab moves in and out of it.
 */
@Component({
  selector: 'mt-radio-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/label.css',
    '../../generated/components/choice.css',
    '../../generated/components/check.css',
    '../../generated/components/radio.css',
    '../../generated/components/error.css',
  ],
  imports: [NgpRadioGroup, NgpRadioItem, NgpLabel, NgpDescription, MtIcon],
  // The form field links the group's label and error; the options are named by plain ids, because
  // nested form fields don't work and radio items don't bind ARIA attributes themselves.
  hostDirectives: [NgpFormField],
  host: { style: 'display: contents' },
  template: `
    <div
      ngpRadioGroup
      [class.mt-col]="orientation() === 'vertical'"
      [class.mt-row]="orientation() === 'horizontal'"
      [ngpRadioGroupValue]="value()"
      [ngpRadioGroupOrientation]="orientation()"
      [ngpRadioGroupDisabled]="isDisabled()"
      (ngpRadioGroupValueChange)="select($event)"
      (focusout)="onTouched()"
    >
      @if (label(); as text) {
        <span ngpLabel class="mt-label">{{ text }}</span>
      }
      @for (option of options(); track option.value) {
        <label class="mt-choice" [attr.data-disabled]="isDisabled() || option.disabled ? '' : null">
          <button
            type="button"
            ngpRadioItem
            class="mt-radio"
            [ngpRadioItemValue]="option.value"
            [ngpRadioItemDisabled]="!!option.disabled"
            [attr.aria-labelledby]="itemId + '-' + $index"
            [attr.aria-describedby]="option.description ? itemId + '-' + $index + '-d' : null"
          ></button>
          <span>
            <span [id]="itemId + '-' + $index">{{ option.label }}</span>
            @if (option.description; as text) {
              <span class="mt-desc" [id]="itemId + '-' + $index + '-d'">{{ text }}</span>
            }
          </span>
        </label>
      }
    </div>
    @if (errorText(); as message) {
      <p ngpDescription class="mt-error"><mt-icon name="alert" [size]="14" />{{ message }}</p>
    }
  `,
})
export class MtRadioGroup<T = string> extends MtFormControl<T | null> {
  readonly options = input.required<readonly MtOption<T>[]>();
  /** The group's visible legend ("Who is applying?"). */
  readonly label = input<string>();
  readonly orientation = input<NgpOrientation>('vertical');

  protected readonly value = signal<T | null>(null);
  protected readonly itemId = `mt-radio-${++nextId}`;
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
