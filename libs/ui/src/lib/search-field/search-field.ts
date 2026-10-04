import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  input,
  numberAttribute,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { NgpInput } from 'ng-primitives/input';
import { NgpHover } from 'ng-primitives/interactions';

import { MtFormControl } from '../forms/form-control';
import { MtIcon } from '../icon/icon';
import { MtIconButton } from '../icon-button/icon-button';
import { ariaKeyShortcuts, MT_KEYBOARD_PLATFORM, MtKbd } from '../kbd/kbd';

/**
 * Search field (`mt-search-field`). `variant="global"` is the sidebar search and command-palette
 * trigger (sunken, small, with the ⌘K hint); `variant="filter"` sits above long lists.
 *
 * `queryChange` emits the query after the user stops typing (`debounce`, 200ms by default); the
 * clear button and Escape clear it at once. Also works as a form control.
 */
@Component({
  selector: 'mt-search-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/input.css', '../../generated/components/search.css'],
  imports: [NgpInput, NgpHover, MtIcon, MtIconButton, MtKbd],
  host: { style: 'display: contents' },
  template: `
    <span
      ngpHover
      class="mt-input"
      [class.mt-search]="variant() === 'global'"
      [attr.data-size]="variant() === 'global' ? 'sm' : null"
      [attr.data-disabled]="isDisabled() ? '' : null"
    >
      <mt-icon [name]="variant() === 'global' ? 'search' : 'filter'" />
      <input
        #input
        ngpInput
        type="text"
        role="searchbox"
        [value]="value()"
        [disabled]="isDisabled()"
        [attr.aria-label]="label()"
        [attr.placeholder]="placeholder()"
        [attr.aria-keyshortcuts]="ariaShortcut()"
        (input)="handleInput($event)"
        (keydown.escape)="clear($event)"
        (blur)="onTouched()"
      />
      @if (value()) {
        <button mtIconButton icon="x" size="sm" label="Clear search" [tooltip]="false" (click)="clear()"></button>
      } @else if (shortcut(); as keys) {
        <mt-kbd [keys]="keys" aria-hidden="true" />
      }
    </span>
  `,
})
export class MtSearchField extends MtFormControl<string> {
  /** Accessible name, since the field has no visible label ("Search matters"). */
  readonly label = input.required<string>();
  readonly placeholder = input('Search…');
  readonly variant = input<'global' | 'filter'>('filter');
  /** Shortcut hint shown while the field is empty, for example `mod+k`. */
  readonly shortcut = input<string>();
  /** Milliseconds to wait after typing stops before emitting `search`. */
  readonly debounce = input(200, { transform: numberAttribute });
  /** The query, after the debounce (immediately when cleared). */
  readonly queryChange = output<string>();

  protected readonly value = signal('');
  private readonly platform = inject(MT_KEYBOARD_PLATFORM);
  protected readonly ariaShortcut = computed(() => {
    const keys = this.shortcut();
    return keys ? ariaKeyShortcuts(keys, this.platform) : null;
  });
  private readonly inputEl = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }

  /** Moves focus to the input (for example from a ⌘K handler). */
  focus(): void {
    this.inputEl().nativeElement.focus();
  }

  protected handleInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.value.set(value);
    this.onChange(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.queryChange.emit(value), this.debounce());
  }

  protected clear(event?: Event): void {
    if (!this.value()) return;
    event?.preventDefault();
    clearTimeout(this.timer);
    this.value.set('');
    this.onChange('');
    this.queryChange.emit('');
    this.focus();
  }
}
