import { ChangeDetectionStrategy, Component, input, signal, ViewEncapsulation } from '@angular/core';
import { NgpDescription, NgpFormField, NgpLabel } from 'ng-primitives/form-field';
import { NgpSwitch, NgpSwitchThumb } from 'ng-primitives/switch';

import { MtFormControl } from '../forms/form-control';

/**
 * Switch (`mt-switch`) for settings that take effect immediately (Clerk suggestions, calendar
 * sync). Inside a form that is saved with a button, use a Checkbox instead. Space and Enter toggle.
 */
@Component({
  selector: 'mt-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/choice.css',
    '../../generated/components/switch.css',
    '../../generated/components/check.css',
  ],
  imports: [NgpSwitch, NgpSwitchThumb, NgpLabel, NgpDescription],
  hostDirectives: [NgpFormField],
  host: { style: 'display: contents' },
  template: `
    <div class="mt-choice" [attr.data-disabled]="isDisabled() ? '' : null">
      <button
        type="button"
        ngpSwitch
        class="mt-switch"
        [ngpSwitchChecked]="checked()"
        [ngpSwitchDisabled]="isDisabled()"
        (ngpSwitchCheckedChange)="toggle($event)"
        (blur)="onTouched()"
      >
        <span ngpSwitchThumb class="mt-switch-thumb"></span>
      </button>
      <span>
        <span ngpLabel>{{ label() }}</span>
        @if (description(); as text) {
          <span ngpDescription class="mt-desc">{{ text }}</span>
        }
      </span>
    </div>
  `,
})
export class MtSwitch extends MtFormControl<boolean> {
  readonly label = input.required<string>();
  readonly description = input<string>();

  protected readonly checked = signal(false);

  writeValue(value: boolean | null): void {
    this.checked.set(!!value);
  }

  protected toggle(checked: boolean): void {
    this.checked.set(checked);
    this.onChange(checked);
    this.onTouched();
  }
}
