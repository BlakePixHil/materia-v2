import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { NgpCheckbox } from 'ng-primitives/checkbox';
import { NgpDescription, NgpFormField, NgpLabel } from 'ng-primitives/form-field';

import { MT_ERROR_MESSAGES, mtErrorMessage } from '../forms/error-messages';
import { MtFormControl } from '../forms/form-control';
import { MtIcon } from '../icon/icon';

/**
 * Checkbox (`mt-checkbox`) for independent on/off choices: a 16px box, then the label and an
 * optional description. `indeterminate` shows the mixed state for a parent whose children are
 * partly checked; checking it clears the mixed state. Space toggles; clicking the label does too.
 * Labels, descriptions and the error are linked by ng-primitives' form field.
 */
@Component({
  selector: 'mt-checkbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/choice.css',
    '../../generated/components/check.css',
    '../../generated/components/error.css',
  ],
  imports: [NgpCheckbox, NgpLabel, NgpDescription, MtIcon],
  hostDirectives: [NgpFormField],
  host: { style: 'display: contents' },
  template: `
    <div class="mt-choice" [attr.data-disabled]="isDisabled() ? '' : null">
      <button
        type="button"
        ngpCheckbox
        class="mt-check"
        [ngpCheckboxChecked]="checked()"
        [ngpCheckboxIndeterminate]="indeterminate()"
        [ngpCheckboxDisabled]="isDisabled()"
        (ngpCheckboxCheckedChange)="toggle($event)"
        (ngpCheckboxIndeterminateChange)="indeterminate.set($event)"
        (blur)="onTouched()"
      >
        <mt-icon [name]="indeterminate() ? 'minus' : 'check'" />
      </button>
      <span>
        <span ngpLabel>{{ label() }}</span>
        @if (description(); as text) {
          <span ngpDescription class="mt-desc">{{ text }}</span>
        }
      </span>
    </div>
    @if (errorText(); as message) {
      <p ngpDescription class="mt-error"><mt-icon name="alert" [size]="14" />{{ message }}</p>
    }
  `,
})
export class MtCheckbox extends MtFormControl<boolean> {
  readonly label = input.required<string>();
  readonly description = input<string>();
  /** The mixed state, for a parent whose children are partly checked. */
  readonly indeterminate = model(false);

  protected readonly checked = signal(false);
  private readonly defaultMessages = inject(MT_ERROR_MESSAGES);
  /** `Validators.requiredTrue` reports `required`; a checkbox words it as "tick the box". */
  protected readonly errorText = computed(() =>
    this.isInvalid()
      ? mtErrorMessage(
          this.formErrors(),
          { required: this.defaultMessages['requiredTrue'] ?? 'Tick this box to continue.' },
          this.defaultMessages,
        )
      : null,
  );

  writeValue(value: boolean | null): void {
    this.checked.set(!!value);
  }

  protected toggle(checked: boolean): void {
    this.checked.set(checked);
    this.onChange(checked);
    this.onTouched();
  }
}
