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
  /** Shows `meta` in the mono face (a matter number, as in the design). */
  mono?: boolean;
  /** It has sub-commands: Tab (or Enter) drills in, and the row shows a Tab hint. */
  drill?: boolean;
}

export interface MtCommandGroup {
  label: string;
  items: readonly MtCommandItem[];
  /** Still searching: the group shows "Searching…" under its label (CORE-15 providers). */
  busy?: boolean;
  /** A line under the group's rows, such as "Type more to narrow these". */
  note?: string;
}

/** What the person did to a row: Enter or a click opens it, ⌘/Ctrl+Enter or a modified click in a new tab. */
export interface MtCommandRun {
  item: MtCommandItem;
  newTab: boolean;
}

let nextId = 0;

/**
 * Command palette panel (`mt-command-palette`), presentational only: a search input, grouped results
 * (at most five per group, by convention of the registry), per-group "Searching…" and notes, an
 * empty state and footer hints.
 *
 * Focus stays in the input; ArrowUp/ArrowDown move the active row (announced with
 * `aria-activedescendant`), Enter emits `run` (and `open` with `newTab: false`), ⌘/Ctrl+Enter emits
 * `open` with `newTab: true`, Tab on a row with sub-commands emits `drill`, and Backspace in an
 * empty input emits `back` (leaving a drilled-in `scope`). It implements the ARIA combobox pattern
 * itself: ng-primitives' combobox opens its own dropdown portal, which doesn't fit an always-open
 * list. Put it in `<mt-command-palette-overlay>` (or a dialog) to show it modally.
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
  // The scope chip, the searching line and the notes are this component's own (the design's
  // CommandPalette has no drilled-in or loading state); they use the menu's tokens.
  styles: `
    .mt-cmdk-input .scope {
      flex: none;
      max-width: 40%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px var(--space-6);
      border-radius: var(--radius-sm);
      background: var(--bg-hover);
      color: var(--text-secondary);
      font: 500 12px/16px var(--font-sans);
    }
    .mt-cmdk .mt-cmdk-status {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      min-height: 30px;
      padding: 0 var(--space-8);
      color: var(--text-tertiary);
      font: 400 12px/16px var(--font-sans);
    }
  `,
  template: `
    <div class="mt-cmdk-input">
      <mt-icon name="search" />
      @if (scope(); as label) {
        <span class="scope" [attr.title]="label">{{ label }}</span>
      }
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
        @if (group.items.length || group.busy || group.note) {
          <div
            role="group"
            [attr.aria-labelledby]="listId + '-' + $index"
            [attr.aria-busy]="group.busy ? 'true' : null"
          >
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
                (click)="choose(item, $event.metaKey || $event.ctrlKey)"
              >
                @if (item.icon; as name) {
                  <mt-icon [name]="name" />
                }
                <span>
                  {{ item.label }}
                  @if (item.meta; as meta) {
                    <span class="t-3" [class.mono-s]="item.mono">{{ meta }}</span>
                  }
                </span>
                @if (item.kbd; as keys) {
                  <span class="hint"><mt-kbd [keys]="keys" /></span>
                } @else if (item === activeItem()) {
                  <span class="hint" aria-hidden="true">{{ item.drill ? 'Tab ↵' : '↵' }}</span>
                } @else if (item.drill) {
                  <span class="hint" aria-hidden="true">›</span>
                }
              </div>
            }
            @if (group.busy) {
              <div class="mt-cmdk-status" role="status">Searching {{ group.label.toLowerCase() }}…</div>
            } @else if (group.note; as note) {
              <div class="mt-cmdk-status">{{ note }}</div>
            }
          </div>
        }
      }
      @if (!flat().length && !searching()) {
        <div class="mt-cmdk-empty">{{ emptyText() }}</div>
      }
    </div>
    <div class="mt-cmdk-foot" aria-hidden="true">
      <span><mt-kbd keys="up" /><mt-kbd keys="down" />Move</span>
      <span><mt-kbd keys="enter" />Open</span>
      <span><mt-kbd keys="mod+enter" />New tab</span>
      @if (activeItem()?.drill) {
        <span><mt-kbd keys="tab" />Actions</span>
      }
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
  /** Where the palette has drilled in ("M-2026-0142"), shown before the input; Backspace leaves it. */
  readonly scope = input<string | null>(null);
  /** The chosen row (Enter or click). */
  readonly run = output<MtCommandItem>();
  /** The chosen row and whether it should open in a new tab (⌘/Ctrl+Enter or a modified click). */
  readonly open = output<MtCommandRun>();
  /** Tab on a row with sub-commands. */
  readonly drill = output<MtCommandItem>();
  /** Backspace in the empty input: leave the scope. */
  readonly back = output();

  protected readonly listId = `mt-cmdk-${++nextId}`;
  protected readonly flat = computed(() => this.groups().flatMap((g) => g.items));
  /** A group is still searching (the empty state waits for it). */
  protected readonly searching = computed(() => this.groups().some((g) => g.busy));
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

  protected choose(item: MtCommandItem, newTab: boolean): void {
    if (!newTab) this.run.emit(item);
    this.open.emit({ item, newTab });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Backspace' && !this.query() && this.scope()) {
      event.preventDefault();
      this.back.emit();
      return;
    }
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
        if (item) this.choose(item, event.metaKey || event.ctrlKey);
        return;
      }
      case 'Tab': {
        const item = this.activeItem();
        if (!item?.drill || event.shiftKey) return;
        event.preventDefault();
        this.drill.emit(item);
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
