import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  Directive,
  inject,
  input,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { NgpDescription, NgpFormField, NgpLabel } from 'ng-primitives/form-field';
import { NgpHover } from 'ng-primitives/interactions';
import {
  injectSelectState,
  NgpNativeSelect,
  NgpSelect,
  NgpSelectDropdown,
  NgpSelectOption,
  NgpSelectPortal,
} from 'ng-primitives/select';

import { MtLabelledControl } from '../forms/form-control';
import { flattenOptions, isOptionGroup, type MtOption, type MtOptionGroup } from '../forms/options';
import { MtIcon } from '../icon/icon';

let nextId = 0;

/** How long typed characters keep adding to the type-ahead query. */
const TYPEAHEAD_RESET_MS = 500;

/**
 * Index of the option to jump to for a type-ahead query: the first enabled option whose label
 * starts with it, searching after the current option first. Repeating one letter cycles through the
 * options that start with it, as in a native select.
 */
export function typeaheadIndex(
  labels: readonly string[],
  query: string,
  current: number,
  disabled: readonly boolean[] = [],
): number {
  const q = query.toLowerCase();
  const first = q.charAt(0);
  const cycling = q.length > 1 && [...q].every((c) => c === first);
  const needle = cycling ? first : q;
  const start = cycling || q.length === 1 ? current + 1 : current;
  for (let step = 0; step < labels.length; step++) {
    const i = (Math.max(start, 0) + step) % labels.length;
    if (!disabled[i] && (labels[i] ?? '').toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/**
 * Type-ahead for `ngpSelect`, which doesn't have it: typing letters moves to the matching option
 * (open) or selects it (closed), like a native select.
 */
@Directive({ selector: '[mtSelectTypeahead]', host: { '(keydown)': 'onKeydown($event)' } })
export class MtSelectTypeahead {
  readonly labels = input.required<readonly string[]>({ alias: 'mtSelectTypeahead' });
  readonly disabledOptions = input<readonly boolean[]>([]);
  readonly currentIndex = input(-1);
  readonly pick = input.required<(index: number) => void>({ alias: 'mtSelectTypeaheadPick' });

  private readonly state = injectSelectState();
  private query = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    // A space with no query in progress opens the select (ngpSelect handles it).
    if (event.key === ' ' && !this.query) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearTimeout(this.timer);
    this.query += event.key;
    this.timer = setTimeout(() => (this.query = ''), TYPEAHEAD_RESET_MS);

    const state = this.state();
    const active = state.open() ? this.activeIndex(state) : this.currentIndex();
    const index = typeaheadIndex(this.labels(), this.query, active, this.disabledOptions());
    if (index < 0) return;
    if (state.open()) state.activeDescendantManager.activateByIndex(index, { origin: 'keyboard' });
    else this.pick()(index);
  }

  private activeIndex(state: ReturnType<ReturnType<typeof injectSelectState>>): number {
    const id = state.activeDescendantManager.id();
    return state.sortedOptions().findIndex((option) => option.id() === id);
  }
}

/** True below the design system's tablet breakpoint, where the native picker is used. */
function prefersNativePicker(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;
}

/**
 * Select (`mt-select`): choose one value from a short, known list (matter type, jurisdiction). The
 * trigger looks like a TextField with an up/down chevron; options open in a menu with a check on the
 * selected one, optionally grouped. Keyboard: arrows, Home/End, Enter, Escape, and type-ahead.
 *
 * Below 768px it renders a native `<select>`, whose picker works better on touch screens (`native`
 * forces either mode). For long lists such as people or matters, use a combobox (later ticket).
 */
@Component({
  selector: 'mt-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/field.css',
    '../../generated/components/label.css',
    '../../generated/components/input.css',
    '../../generated/components/select.css',
    '../../generated/components/menu.css',
    '../../generated/components/help.css',
    '../../generated/components/error.css',
  ],
  imports: [
    NgpSelect,
    NgpSelectDropdown,
    NgpSelectOption,
    NgpSelectPortal,
    NgpNativeSelect,
    NgpHover,
    NgpLabel,
    NgpDescription,
    MtIcon,
    MtSelectTypeahead,
  ],
  hostDirectives: [NgpFormField],
  host: { class: 'mt-field' },
  template: `
    @if (label(); as text) {
      <span ngpLabel class="mt-label">
        {{ text }}
        @if (optional()) {
          <span class="mt-opt">Optional</span>
        }
      </span>
    }
    @if (useNative()) {
      <span
        ngpHover
        class="mt-input mt-select"
        [attr.data-invalid]="showInvalid() ? '' : null"
        [attr.data-disabled]="isDisabled() ? '' : null"
      >
        <select
          ngpNativeSelect
          [ngpNativeSelectDisabled]="isDisabled()"
          [attr.aria-required]="required() ? 'true' : null"
          (change)="selectIndex(+$any($event.target).value)"
          (blur)="onTouched()"
        >
          <option value="-1" disabled [selected]="selectedIndex() < 0">{{ placeholder() }}</option>
          @for (item of options(); track item.label) {
            @if (asGroup(item); as group) {
              <optgroup [label]="group.label">
                @for (option of group.options; track option.value) {
                  <option
                    [value]="indexOf(option)"
                    [disabled]="!!option.disabled"
                    [selected]="indexOf(option) === selectedIndex()"
                  >
                    {{ option.label }}
                  </option>
                }
              </optgroup>
            } @else if (asOption(item); as option) {
              <option
                [value]="indexOf(option)"
                [disabled]="!!option.disabled"
                [selected]="indexOf(option) === selectedIndex()"
              >
                {{ option.label }}
              </option>
            }
          }
        </select>
        <mt-icon name="updown" />
      </span>
    } @else {
      <div
        ngpSelect
        ngpHover
        class="mt-input mt-select"
        [mtSelectTypeahead]="labels()"
        [disabledOptions]="disabledFlags()"
        [currentIndex]="selectedIndex()"
        [mtSelectTypeaheadPick]="pickIndex"
        [ngpSelectValue]="value()"
        [ngpSelectDisabled]="isDisabled()"
        [attr.data-invalid]="showInvalid() ? '' : null"
        [attr.aria-required]="required() ? 'true' : null"
        [attr.aria-disabled]="isDisabled() ? 'true' : null"
        (ngpSelectValueChange)="select($event)"
        (blur)="onTouched()"
      >
        <span class="v" [class.ph]="selectedIndex() < 0">{{ selectedLabel() ?? placeholder() }}</span>
        <mt-icon name="updown" />
        <div *ngpSelectPortal ngpSelectDropdown class="mt-menu" data-overlay [attr.aria-label]="label()">
          @for (item of options(); track item.label) {
            @if (asGroup(item); as group) {
              <div role="group" [attr.aria-labelledby]="labelId + '-g' + $index">
                <div class="mt-menu-label" [id]="labelId + '-g' + $index">{{ group.label }}</div>
                @for (option of group.options; track option.value) {
                  <div
                    ngpSelectOption
                    class="mt-menu-item"
                    [ngpSelectOptionValue]="option.value"
                    [ngpSelectOptionDisabled]="!!option.disabled"
                  >
                    @if (option.icon; as icon) {
                      <mt-icon [name]="icon" />
                    }
                    <span>{{ option.label }}</span>
                    @if (indexOf(option) === selectedIndex()) {
                      <span class="hint check"><mt-icon name="check" /></span>
                    }
                  </div>
                }
              </div>
            } @else if (asOption(item); as option) {
              <div
                ngpSelectOption
                class="mt-menu-item"
                [ngpSelectOptionValue]="option.value"
                [ngpSelectOptionDisabled]="!!option.disabled"
              >
                @if (option.icon; as icon) {
                  <mt-icon [name]="icon" />
                }
                <span>{{ option.label }}</span>
                @if (indexOf(option) === selectedIndex()) {
                  <span class="hint check"><mt-icon name="check" /></span>
                }
              </div>
            }
          }
        </div>
      </div>
    }
    @if (errorText(); as message) {
      <p ngpDescription class="mt-error"><mt-icon name="alert" [size]="14" />{{ message }}</p>
    } @else if (description(); as text) {
      <p ngpDescription class="mt-help">{{ text }}</p>
    }
  `,
})
export class MtSelect<T = string> extends MtLabelledControl<T | null> {
  readonly options = input.required<readonly (MtOption<T> | MtOptionGroup<T>)[]>();
  readonly placeholder = input('Choose…');
  /** Force the native picker (true) or the menu (false); by default, native below 768px. */
  readonly native = input<boolean | undefined>(undefined);

  protected readonly value = signal<T | null>(null);
  protected readonly labelId = `mt-select-${++nextId}`;

  protected readonly flat = computed(() => flattenOptions(this.options()));
  protected readonly labels = computed(() => this.flat().map((o) => o.label));
  protected readonly disabledFlags = computed(() => this.flat().map((o) => !!o.disabled));
  protected readonly selectedIndex = computed(() => this.flat().findIndex((o) => o.value === this.value()));
  protected readonly selectedLabel = computed(() => this.flat()[this.selectedIndex()]?.label ?? null);
  protected readonly useNative = computed(() => this.native() ?? prefersNativePicker());

  protected readonly asGroup = (item: MtOption<T> | MtOptionGroup<T>) => (isOptionGroup(item) ? item : null);
  protected readonly asOption = (item: MtOption<T> | MtOptionGroup<T>) => (isOptionGroup(item) ? null : item);
  protected readonly indexOf = (option: MtOption<T>) => this.flat().indexOf(option);
  protected readonly pickIndex = (index: number) => this.selectIndex(index);

  writeValue(value: T | null): void {
    this.value.set(value ?? null);
  }

  protected select(value: T | null): void {
    this.value.set(value);
    this.onChange(value);
  }

  protected selectIndex(index: number): void {
    const option = this.flat()[index];
    if (option && !option.disabled) this.select(option.value);
  }
}
