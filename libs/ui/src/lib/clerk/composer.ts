import {
  afterRenderEffect,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  model,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import { MtIcon } from '../icon/icon';
import { MtIconButton } from '../icon-button/icon-button';
import { MtKbd } from '../kbd/kbd';

/** A `/` command Clerk understands ("/draft", "/summarise"). */
export interface ComposerCommand {
  name: string;
  description: string;
}

/** Tallest the input grows before it scrolls. */
export const MT_COMPOSER_MAX_HEIGHT = 240;

let nextId = 0;

/** Commands matching what has been typed after a leading `/` (nothing once a space is typed). */
export function matchCommands(value: string, commands: readonly ComposerCommand[]): ComposerCommand[] {
  const match = /^\/(\S*)$/.exec(value);
  if (!match) return [];
  const query = (match[1] ?? '').toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(query));
}

/**
 * Composer (`mt-composer`): where people ask Clerk. Shows the scope ("Asking about WE-142"), grows with
 * its text, and sends with ⌘↵ (Ctrl+Enter); while Clerk is answering, Send becomes Stop and Escape stops.
 * Typing `/` lists the commands; ↑/↓ choose and Enter or Tab inserts one. `attach` is emitted by the
 * paperclip; the feature opens the file picker.
 */
@Component({
  selector: 'mt-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/composer.css', '../../generated/components/send.css'],
  imports: [MtIcon, MtIconButton, MtKbd],
  host: {
    class: 'mt-composer',
    '[attr.data-focus]': 'focused() ? "" : null',
    '[attr.data-streaming]': 'streaming() ? "" : null',
  },
  template: `
    @if (scope(); as label) {
      <span class="ctx"><mt-icon name="matters" />Asking about {{ label }}</span>
    }
    <textarea
      #field
      class="field"
      rows="1"
      [id]="id"
      [attr.aria-label]="label()"
      [attr.placeholder]="placeholder()"
      [attr.aria-autocomplete]="commands().length ? 'list' : null"
      [attr.aria-controls]="hints().length ? id + '-commands' : null"
      [attr.aria-activedescendant]="hints().length ? id + '-command-' + activeHint() : null"
      [attr.aria-describedby]="id + '-hint'"
      [disabled]="disabled()"
      [value]="value()"
      (input)="onInput(field.value)"
      (keydown)="onKeydown($event)"
      (focus)="focused.set(true)"
      (blur)="focused.set(false)"
    ></textarea>
    @if (hints().length) {
      <ul class="mt-composer-commands" role="listbox" [id]="id + '-commands'" aria-label="Commands">
        @for (command of hints(); track command.name) {
          <li
            role="option"
            [id]="id + '-command-' + $index"
            [attr.aria-selected]="$index === activeHint()"
            [attr.data-active]="$index === activeHint() ? '' : null"
            (mousedown)="$event.preventDefault(); pick(command)"
          >
            <span class="name">/{{ command.name }}</span
            ><span class="desc">{{ command.description }}</span>
          </li>
        }
      </ul>
    }
    <div class="bar">
      <button
        mtIconButton
        icon="attach"
        label="Attach a file"
        size="sm"
        [disabled]="disabled()"
        (click)="attach.emit()"
      ></button>
      <span class="mt-grow mt-composer-hint" [id]="id + '-hint'">
        Clerk can be wrong. Check the citations. <mt-kbd keys="mod+enter" /> to send
      </span>
      @if (streaming()) {
        <button type="button" class="mt-send" data-stop aria-label="Stop" (click)="stop.emit()">
          <mt-icon name="x" />
        </button>
      } @else {
        <button
          type="button"
          class="mt-send"
          aria-label="Send"
          [attr.aria-disabled]="canSend() ? null : 'true'"
          [attr.data-disabled]="canSend() ? null : ''"
          (click)="submit()"
        >
          <mt-icon name="send" />
        </button>
      }
    </div>
  `,
})
export class MtComposer {
  readonly value = model('');
  /** The matter or object Clerk is scoped to ("WE-142 · Estate of Margaret Whitfield"). */
  readonly scope = input<string>();
  /** Accessible name of the input. */
  readonly label = input('Ask Clerk');
  readonly placeholder = input('Ask about this matter…');
  readonly commands = input<readonly ComposerCommand[]>([]);
  /** Clerk is answering: Send becomes Stop. */
  readonly streaming = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  /** The trimmed message. */
  readonly send = output<string>();
  readonly stop = output();
  readonly attach = output();

  protected readonly id = `mt-composer-${nextId++}`;
  protected readonly focused = signal(false);
  protected readonly activeHint = signal(0);
  private readonly dismissedFor = signal<string | null>(null);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  protected readonly canSend = computed(() => !this.disabled() && this.value().trim().length > 0);
  protected readonly hints = computed(() =>
    this.dismissedFor() === this.value() ? [] : matchCommands(this.value(), this.commands()),
  );

  constructor() {
    // Grow with the text (up to MT_COMPOSER_MAX_HEIGHT), including when the value is set from outside.
    afterRenderEffect(() => {
      this.value();
      const element = this.field().nativeElement;
      element.style.height = 'auto';
      element.style.height = `${Math.min(element.scrollHeight, MT_COMPOSER_MAX_HEIGHT)}px`;
    });
  }

  /** Focuses the input (after picking a scope, or a keyboard shortcut). */
  focus(): void {
    this.field().nativeElement.focus();
  }

  protected onInput(value: string): void {
    this.value.set(value);
    this.activeHint.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const hints = this.hints();
    if (hints.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.activeHint.set((this.activeHint() + step + hints.length) % hints.length);
        return;
      }
      if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
        const command = hints[this.activeHint()];
        if (command) {
          event.preventDefault();
          this.pick(command);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.dismissedFor.set(this.value());
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.submit();
    } else if (event.key === 'Escape' && this.streaming()) {
      event.preventDefault();
      this.stop.emit();
    }
  }

  protected pick(command: ComposerCommand): void {
    this.value.set(`/${command.name} `);
    this.activeHint.set(0);
    this.focus();
  }

  protected submit(): void {
    if (!this.canSend() || this.streaming()) return;
    this.send.emit(this.value().trim());
    this.value.set('');
  }
}
