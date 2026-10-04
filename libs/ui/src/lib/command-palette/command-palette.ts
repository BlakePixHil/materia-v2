import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
  input,
  model,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { NgpDialog, NgpDialogOverlay } from 'ng-primitives/dialog';

import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { MtKbd } from '../kbd/kbd';

/** One result row. The data comes from the CommandRegistry (FND-12); this component only renders. */
export interface MtCommandItem {
  id: string;
  label: string;
  /** Secondary text after the label, such as a matter reference or a role. */
  meta?: string;
  icon?: MtIconName | MtIconNode;
  /** Shortcut hint, for example `t`. */
  kbd?: string;
  /** `ai` for "Ask Clerk about …". */
  tone?: 'ai';
}

export interface MtCommandGroup {
  label: string;
  items: readonly MtCommandItem[];
}

let nextId = 0;

/**
 * Command palette panel (`mt-command-palette`), presentational only: a search input, grouped results
 * (at most five per group, by convention of the registry), an empty state and footer hints.
 *
 * Focus stays in the input; ArrowUp/ArrowDown move the active row (announced with
 * `aria-activedescendant`), Enter emits `run`. It implements the ARIA combobox pattern itself: ng-primitives'
 * combobox opens its own dropdown portal, which doesn't fit an always-open list. Put it in
 * `<mt-command-palette-overlay>` (or a dialog) to show it modally.
 */
@Component({
  selector: 'mt-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/cmdk.css',
    '../../generated/components/menu.css',
    '../../generated/components/kbd.css',
  ],
  imports: [MtIcon, MtKbd],
  host: { class: 'mt-cmdk' },
  template: `
    <div class="mt-cmdk-input">
      <mt-icon name="search" />
      <input
        #input
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        [attr.aria-label]="label()"
        [attr.aria-controls]="listId"
        [attr.aria-activedescendant]="activeId()"
        [attr.placeholder]="placeholder()"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        (keydown)="onKeydown($event)"
      />
      <mt-kbd keys="esc" />
    </div>
    <div class="mt-menu" role="listbox" [id]="listId" [attr.aria-label]="label()">
      @for (group of groups(); track group.label) {
        @if (group.items.length) {
          <div role="group" [attr.aria-labelledby]="listId + '-' + $index">
            <div class="mt-menu-label" [id]="listId + '-' + $index">{{ group.label }}</div>
            @for (item of group.items; track item.id) {
              <!-- Options are reached with aria-activedescendant from the input, so they don't take focus. -->
              <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
              <div
                class="mt-menu-item"
                role="option"
                [id]="optionId(item)"
                [attr.aria-selected]="item === activeItem()"
                [attr.data-highlighted]="item === activeItem() ? '' : null"
                [attr.data-tone]="item.tone ?? null"
                (pointermove)="activate(item)"
                (click)="run.emit(item)"
              >
                @if (item.icon; as name) {
                  <mt-icon [name]="name" />
                }
                <span>
                  {{ item.label }}
                  @if (item.meta; as meta) {
                    <span class="t-3">{{ meta }}</span>
                  }
                </span>
                @if (item.kbd; as keys) {
                  <span class="hint"><mt-kbd [keys]="keys" /></span>
                } @else if (item === activeItem()) {
                  <span class="hint" aria-hidden="true">↵</span>
                }
              </div>
            }
          </div>
        }
      }
      @if (!flat().length) {
        <div class="mt-cmdk-empty">{{ emptyText() }}</div>
      }
    </div>
    <div class="mt-cmdk-foot" aria-hidden="true">
      <span><mt-kbd keys="up" /><mt-kbd keys="down" />Move</span>
      <span><mt-kbd keys="enter" />Open</span>
      <span><mt-kbd keys="mod+j" />Ask Clerk</span>
    </div>
  `,
})
export class MtCommandPalette {
  readonly groups = input.required<readonly MtCommandGroup[]>();
  readonly query = model('');
  readonly placeholder = input('Search matters, people and actions…');
  readonly label = input('Command palette');
  readonly emptyText = input('No matches. Try a matter number or a person’s name.');
  /** The chosen row (Enter or click). */
  readonly run = output<MtCommandItem>();

  protected readonly listId = `mt-cmdk-${++nextId}`;
  protected readonly flat = computed(() => this.groups().flatMap((g) => g.items));
  private readonly activeIndex = signal(0);
  protected readonly activeItem = computed(() => this.flat()[this.activeIndex()] ?? null);
  protected readonly activeId = computed(() => {
    const item = this.activeItem();
    return item ? this.optionId(item) : null;
  });
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  constructor() {
    // New results: start again from the first row.
    effect(() => {
      this.flat();
      this.activeIndex.set(0);
    });
  }

  /** Focuses the search input (call after opening). */
  focus(): void {
    this.input().nativeElement.focus();
  }

  protected optionId(item: MtCommandItem): string {
    return `${this.listId}-o-${item.id}`;
  }

  protected activate(item: MtCommandItem): void {
    this.activeIndex.set(this.flat().indexOf(item));
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.flat().length;
    if (!count) return;
    const move = (index: number) => {
      event.preventDefault();
      this.activeIndex.set((index + count) % count);
      queueMicrotask(() => {
        const id = this.activeId();
        if (id) document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' });
      });
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(this.activeIndex() + 1);
      case 'ArrowUp':
        return move(this.activeIndex() - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(count - 1);
      case 'Enter': {
        event.preventDefault();
        const item = this.activeItem();
        if (item) this.run.emit(item);
        return;
      }
    }
  }
}

/**
 * Shows projected content (usually `<mt-command-palette>`) as a modal near the top of the screen:
 * a scrim, a focus trap, scroll lock and Escape to close. Open it with `DialogService` or `[mtDialogTrigger]`.
 */
@Component({
  selector: 'mt-command-palette-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/overlay.css', '../../generated/components/modal.css'],
  imports: [NgpDialogOverlay, NgpDialog],
  host: { style: 'display: contents' },
  template: `
    <div ngpDialogOverlay class="mt-overlay mt-modal-root" data-placement="top">
      <div ngpDialog [attr.aria-label]="label()"><ng-content /></div>
    </div>
  `,
})
export class MtCommandPaletteOverlay {
  readonly label = input('Command palette');
}
