import {
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

import { DEFAULT_NARRATIVE_PHRASES, matchPhrases, phraseQueryAt, TIME_NARRATIVE_MAX } from '@materia/domain';

let nextId = 0;

/**
 * A time entry's narrative (BILL-01): one line of text with the phrase library on `/` ("Perusing
 * and considering…", "Attendance on client…"). An accessible combobox: ↑/↓ choose, Enter or Tab
 * inserts the phrase in place of `/query`, Esc closes the list. Enter with the list closed emits
 * `submitted` (the form saves).
 */
@Component({
  selector: 'mt-narrative-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { class: 'mt-field mt-narrative-field' },
  template: `
    @if (!labelHidden()) {
      <label class="mt-label" [for]="id">{{ label() }}</label>
    }
    <span class="mt-input" [attr.data-size]="size() === 'sm' ? 'sm' : null">
      <input
        #field
        type="text"
        [id]="id"
        role="combobox"
        autocomplete="off"
        [attr.aria-label]="labelHidden() ? label() : null"
        [attr.aria-expanded]="open()"
        aria-autocomplete="list"
        [attr.aria-controls]="open() ? id + '-phrases' : null"
        [attr.aria-activedescendant]="open() && phrases().length ? id + '-phrase-' + active() : null"
        [attr.aria-describedby]="id + '-hint'"
        [attr.maxlength]="max"
        [attr.placeholder]="placeholder()"
        [value]="value()"
        (input)="onInput(field)"
        (keydown)="onKeydown($event, field)"
        (keyup)="onCaret(field, $event)"
        (click)="onCaret(field)"
        (blur)="close()"
      />
    </span>
    <span class="mt-sr" [id]="id + '-hint'">Type / for common phrases.</span>
    @if (open() && phrases().length) {
      <ul class="mt-menu phrases" role="listbox" [id]="id + '-phrases'" aria-label="Phrases">
        @for (phrase of phrases(); track phrase) {
          <li
            class="mt-menu-item"
            role="option"
            [id]="id + '-phrase-' + $index"
            [attr.aria-selected]="$index === active()"
            [attr.data-active]="$index === active() ? '' : null"
            (mousedown)="$event.preventDefault(); pick(phrase, field)"
          >
            <span class="label">{{ phrase.trim() }}…</span>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .mt-narrative-field {
      position: relative;
      min-width: 0;
    }
    /* The menu's look (mt-menu), here because the list isn't an MtMenu overlay. */
    .mt-narrative-field .phrases {
      position: absolute;
      z-index: var(--layer-popover);
      top: 100%;
      left: 0;
      right: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
      margin: var(--space-4) 0 0;
      padding: var(--space-4);
      list-style: none;
      max-height: 240px;
      overflow-y: auto;
      border-radius: var(--radius-md);
      background: var(--bg-raised);
      box-shadow: var(--shadow-popover);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-narrative-field .phrases li {
      display: flex;
      align-items: center;
      height: 30px;
      padding: 0 var(--space-8);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      cursor: pointer;
    }
    .mt-narrative-field .phrases li[data-active],
    .mt-narrative-field .phrases li:hover {
      background: var(--bg-hover);
    }
  `,
})
export class NarrativeField {
  readonly value = model('');
  readonly label = input('Narrative');
  readonly labelHidden = input(false);
  readonly placeholder = input('What you did · / for phrases');
  readonly size = input<'sm' | 'md'>('md');
  readonly phraseLibrary = input<readonly string[]>(DEFAULT_NARRATIVE_PHRASES);
  /** Enter pressed with the phrase list closed. */
  readonly submitted = output();

  protected readonly id = `mt-narrative-${nextId++}`;
  protected readonly max = TIME_NARRATIVE_MAX;
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly query = signal<{ start: number; query: string } | null>(null);
  protected readonly active = signal(0);
  protected readonly phrases = computed(() => {
    const at = this.query();
    return at ? matchPhrases(at.query, this.phraseLibrary()) : [];
  });
  protected readonly open = computed(() => this.query() !== null && this.phrases().length > 0);

  focus(): void {
    const element = this.field().nativeElement;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }

  protected onInput(field: HTMLInputElement): void {
    this.value.set(field.value);
    this.track(field);
  }

  protected onCaret(field: HTMLInputElement, event?: KeyboardEvent): void {
    if (event && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    this.track(field);
  }

  protected onKeydown(event: KeyboardEvent, field: HTMLInputElement): void {
    if (this.open()) {
      const items = this.phrases();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.active.set((this.active() + step + items.length) % items.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const phrase = items[this.active()];
        if (phrase) {
          event.preventDefault();
          this.pick(phrase, field);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
      }
    }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      this.submitted.emit();
    }
  }

  protected pick(phrase: string, field: HTMLInputElement): void {
    const at = this.query();
    if (!at) return;
    const caret = field.selectionStart ?? field.value.length;
    const text = field.value.slice(0, at.start) + phrase + field.value.slice(caret);
    const position = at.start + phrase.length;
    field.value = text.slice(0, this.max);
    this.value.set(field.value);
    field.setSelectionRange(position, position);
    this.close();
  }

  protected close(): void {
    this.query.set(null);
    this.active.set(0);
  }

  private track(field: HTMLInputElement): void {
    const next = phraseQueryAt(field.value, field.selectionStart ?? field.value.length);
    const current = this.query();
    if (next?.start !== current?.start || next?.query !== current?.query) this.active.set(0);
    this.query.set(next);
  }
}
