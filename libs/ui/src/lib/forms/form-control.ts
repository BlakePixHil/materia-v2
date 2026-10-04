import { booleanAttribute, computed, DestroyRef, Directive, type DoCheck, inject, input, signal } from '@angular/core';
import { type ControlValueAccessor, NgControl, type ValidationErrors } from '@angular/forms';
import type { Subscription } from 'rxjs';

import { MT_ERROR_MESSAGES, mtErrorMessage, type MtErrorMessage } from './error-messages';

/**
 * Angular forms plumbing shared by the mt-* form controls (FND-08).
 *
 * The control injects the `NgControl` on its own host (`formControlName`, `[formControl]` or
 * `ngModel`) and registers itself as that control's value accessor, instead of providing
 * `NG_VALUE_ACCESSOR`. That way it can also read the control's state: `isInvalid` turns on once the
 * control is invalid and touched (the same rule ng-primitives uses for `aria-invalid`), and
 * `isDisabled` follows both the `disabled` input and `FormControl.disable()`.
 */
@Directive()
export abstract class MtFormControl<T> implements ControlValueAccessor, DoCheck {
  /** Disables the control when it isn't bound to a form control (forms use `disable()`). */
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly ngControl = inject(NgControl, { self: true, optional: true });
  private readonly formDisabled = signal(false);
  private readonly formInvalid = signal(false);
  /** The bound control's current validation errors. */
  protected readonly formErrors = signal<ValidationErrors | null>(null);

  readonly isDisabled = computed(() => this.disabled() || this.formDisabled());
  readonly isInvalid = computed(() => this.formInvalid());

  protected onChange: (value: T) => void = () => undefined;
  protected onTouched: () => void = () => undefined;
  private subscription?: Subscription;

  constructor() {
    if (this.ngControl) this.ngControl.valueAccessor = this;
    inject(DestroyRef).onDestroy(() => this.subscription?.unsubscribe());
  }

  abstract writeValue(value: T | null): void;

  registerOnChange(fn: (value: T) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.formDisabled.set(disabled);
  }

  /**
   * Reads the control's state. Runs whenever the parent view is checked (for example after
   * `markAllAsTouched()` in a submit handler), and the control's `events` cover changes from outside,
   * such as async validators.
   */
  ngDoCheck(): void {
    const control = this.ngControl?.control;
    if (!control) return;
    if (!this.subscription) this.subscription = control.events.subscribe(() => this.syncState());
    this.syncState();
  }

  private syncState(): void {
    const control = this.ngControl?.control;
    if (!control) return;
    this.formInvalid.set(control.invalid && control.touched);
    this.formErrors.set(control.errors);
  }
}

/**
 * A form control with a label, helper text and a validation error under it (TextField, Textarea,
 * Select). The error is the explicit `error` input, or else the first validation error once the
 * control is touched and invalid, worded by `errorMessages` or the `MT_ERROR_MESSAGES` defaults.
 */
@Directive()
export abstract class MtLabelledControl<T> extends MtFormControl<T> {
  readonly label = input<string>();
  /** Helper text: where the value comes from, or its format. Replaced by the error when invalid. */
  readonly description = input<string>();
  /** An error to show regardless of validation (for example from the server). */
  readonly error = input<string>();
  /** Copy per validator key, overriding the defaults (`{ required: 'Enter the date of death.' }`). */
  readonly errorMessages = input<Readonly<Record<string, MtErrorMessage>>>({});
  /** Marks the label "Optional". */
  readonly optional = input(false, { transform: booleanAttribute });
  /** Announces the field as required (validation stays with the form control). */
  readonly required = input(false, { transform: booleanAttribute });

  private readonly defaultMessages = inject(MT_ERROR_MESSAGES);

  protected readonly errorText = computed(
    () =>
      this.error() ||
      (this.isInvalid() ? mtErrorMessage(this.formErrors(), this.errorMessages(), this.defaultMessages) : null),
  );
  protected readonly showInvalid = computed(() => this.isInvalid() || !!this.error());
}
