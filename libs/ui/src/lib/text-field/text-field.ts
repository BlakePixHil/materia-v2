import { ChangeDetectionStrategy, Component, input, signal, ViewEncapsulation } from '@angular/core';
import { NgpDescription, NgpFormField, NgpLabel } from 'ng-primitives/form-field';
import { NgpInput } from 'ng-primitives/input';
import { NgpHover } from 'ng-primitives/interactions';

import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtLabelledControl } from '../forms/form-control';
import { MtIcon } from '../icon/icon';

export type MtTextFieldType = 'text' | 'email' | 'tel' | 'url' | 'password' | 'number' | 'search';

/**
 * Labelled single-line input (`mt-text-field`): label → control → helper or error. Works with
 * `formControlName`, `[formControl]` and `ngModel`. Once the control is touched and invalid, the
 * first validation error shows under the control (`errorMessages` overrides the copy) and is linked
 * to the input with `aria-describedby`; ng-primitives sets `aria-invalid`.
 *
 * Slots: `[mtPrefix]` and `[mtSuffix]` inside the control, or the `iconStart` and `suffix` inputs.
 */
@Component({
  selector: 'mt-text-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/field.css',
    '../../generated/components/label.css',
    '../../generated/components/input.css',
    '../../generated/components/help.css',
    '../../generated/components/error.css',
  ],
  imports: [NgpLabel, NgpDescription, NgpInput, NgpHover, MtIcon],
  hostDirectives: [NgpFormField],
  host: { class: 'mt-field' },
  template: `
    @if (label(); as text) {
      <!-- ngpLabel sets "for" to the input's id at runtime. -->
      <!-- eslint-disable-next-line @angular-eslint/template/label-has-associated-control -->
      <label ngpLabel class="mt-label">
        {{ text }}
        @if (optional()) {
          <span class="mt-opt">Optional</span>
        }
      </label>
    }
    <span
      ngpHover
      class="mt-input"
      [attr.data-size]="size() === 'sm' ? 'sm' : null"
      [attr.data-invalid]="showInvalid() ? '' : null"
      [attr.data-disabled]="isDisabled() ? '' : null"
    >
      @if (iconStart(); as icon) {
        <mt-icon [name]="icon" />
      }
      <ng-content select="[mtPrefix]" />
      <input
        ngpInput
        [type]="type()"
        [value]="value()"
        [disabled]="isDisabled()"
        [attr.placeholder]="placeholder() || null"
        [attr.autocomplete]="autocomplete() || null"
        [attr.inputmode]="inputmode() || null"
        [attr.aria-required]="required() ? 'true' : null"
        (input)="handleInput($event)"
        (blur)="onTouched()"
      />
      @if (suffix(); as text) {
        <span class="suffix">{{ text }}</span>
      }
      <ng-content select="[mtSuffix]" />
    </span>
    @if (errorText(); as message) {
      <p ngpDescription class="mt-error"><mt-icon name="alert" [size]="14" />{{ message }}</p>
    } @else if (description(); as text) {
      <p ngpDescription class="mt-help">{{ text }}</p>
    }
  `,
})
export class MtTextField extends MtLabelledControl<string> {
  readonly type = input<MtTextFieldType>('text');
  readonly placeholder = input<string>();
  readonly autocomplete = input<string>();
  readonly inputmode = input<string>();
  readonly iconStart = input<MtIconName | MtIconNode>();
  /** Unit after the value, for example `AUD`. */
  readonly suffix = input<string>();
  readonly size = input<'sm' | 'md'>('md');
  protected readonly value = signal('');

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }

  protected handleInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.value.set(value);
    this.onChange(value);
  }
}
