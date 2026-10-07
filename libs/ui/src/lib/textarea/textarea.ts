import {
  afterRenderEffect,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  input,
  numberAttribute,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { NgpDescription, NgpFormField, NgpLabel } from 'ng-primitives/form-field';
import { NgpHover } from 'ng-primitives/interactions';
import { NgpTextarea } from 'ng-primitives/textarea';

import { MtLabelledControl } from '../forms/form-control';
import { MtIcon } from '../icon/icon';

/** Line height of `.mt-input` (20px); the design system grows a textarea to 12 lines, then scrolls. */
const LINE_HEIGHT = 20;
const MAX_LINES = 12;

/**
 * Multi-line text (`mt-textarea`) for file notes, instructions and prompts. Grows with its content
 * up to 12 lines, then scrolls (`autoGrow`, on by default). With `maxLength`, a character count
 * shows under the control. Same forms integration and states as TextField.
 */
@Component({
  selector: 'mt-textarea',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/field.css',
    '../../generated/components/label.css',
    '../../generated/components/input.css',
    '../../generated/components/textarea.css',
    '../../generated/components/help.css',
    '../../generated/components/error.css',
  ],
  imports: [NgpLabel, NgpDescription, NgpTextarea, NgpHover, MtIcon],
  hostDirectives: [NgpFormField],
  host: { class: 'mt-field' },
  template: `
    @if (label(); as text) {
      <!-- ngpLabel sets "for" to the input's id at runtime. -->
      <!-- eslint-disable-next-line @angular-eslint/template/label-has-associated-control -->
      <label ngpLabel class="mt-label" [class.mt-sr]="labelHidden()">
        {{ text }}
        @if (optional()) {
          <span class="mt-opt">Optional</span>
        }
      </label>
    }
    <span
      ngpHover
      class="mt-input mt-textarea"
      [attr.data-invalid]="showInvalid() ? '' : null"
      [attr.data-disabled]="isDisabled() ? '' : null"
    >
      <textarea
        #textarea
        ngpTextarea
        [rows]="rows()"
        [value]="value()"
        [disabled]="isDisabled()"
        [attr.placeholder]="placeholder() || null"
        [attr.maxlength]="maxLength() ?? null"
        [attr.aria-required]="required() ? 'true' : null"
        (input)="handleInput($event)"
        (blur)="onTouched()"
      ></textarea>
    </span>
    @if (errorText(); as message) {
      <p ngpDescription class="mt-error"><mt-icon name="alert" [size]="14" />{{ message }}</p>
    } @else if (description(); as text) {
      <p ngpDescription class="mt-help">{{ text }}</p>
    }
    @if (maxLength(); as max) {
      <p ngpDescription class="mt-help" aria-live="polite">{{ count() }} of {{ max }} characters</p>
    }
  `,
})
export class MtTextarea extends MtLabelledControl<string> {
  readonly placeholder = input<string>();
  readonly rows = input(3, { transform: numberAttribute });
  /** Grow with the content up to 12 lines (default on). */
  readonly autoGrow = input(true, { transform: booleanAttribute });
  /** Limit and count characters. */
  readonly maxLength = input<number | undefined, unknown>(undefined, {
    transform: (v: unknown) => (v === undefined || v === null || v === '' ? undefined : numberAttribute(v)),
  });

  protected readonly value = signal('');
  protected readonly count = computed(() => this.value().length);
  private readonly textarea = viewChild.required<ElementRef<HTMLTextAreaElement>>('textarea');

  constructor() {
    super();
    afterRenderEffect(() => {
      this.value();
      const element = this.textarea().nativeElement;
      if (!this.autoGrow()) {
        element.style.removeProperty('height');
        return;
      }
      element.style.height = 'auto';
      const max = LINE_HEIGHT * MAX_LINES;
      element.style.height = `${Math.min(element.scrollHeight, max)}px`;
    });
  }

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }

  protected handleInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.value.set(value);
    this.onChange(value);
  }
}
