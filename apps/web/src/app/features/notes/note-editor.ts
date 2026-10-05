import {
  afterNextRender,
  afterRenderEffect,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Bold, Italic, Link, List } from 'lucide';

import { MtButton, MtCheckbox, MtIconButton, MtKbd, MtNote } from '@materia/ui';

import {
  applyFormat,
  insertMention,
  insertText,
  MATTER_QUERY_MIN,
  matchMembers,
  matterToken,
  memberToken,
  mentionAt,
  nameList,
  NOTE_LIMIT_TEXT,
  noteSize,
  pastedText,
  tooLong,
  unreachableMentions,
  type MatterOption,
  type MentionQuery,
  type NoteFormat,
  type NoteMember,
  type TextEdit,
} from './note-view';

/** What a save sends: the Markdown and the privileged flag. */
export interface NoteDraft {
  bodyMd: string;
  privileged: boolean;
}

/** A suggestion in the `@`/`#` list. */
interface Suggestion {
  key: string;
  label: string;
  detail: string;
  token: string;
}

/** How long typing pauses before `#` searches matters. */
const MATTER_SEARCH_DEBOUNCE_MS = 150;
/** Tallest the field grows before it scrolls. */
const MAX_HEIGHT = 360;

let nextId = 0;

/**
 * The note editor (CORE-13), for new notes and edits: a Markdown textarea with a small toolbar (bold,
 * italic, list, link; ⌘B and ⌘I too), `@` to mention an active member and `#` to mention a matter by
 * number or title (an accessible listbox: ↑/↓ choose, Enter or Tab inserts `@[uid]`/`#[matterId]`,
 * Escape closes it). Pasting inserts plain text only. ⌘↵ (Ctrl+Enter) saves; Escape cancels an edit.
 * The size shows against the 100 KB limit, with an error past it. Lawyers and above can mark a
 * note privileged (always, on a privileged matter); mentioning someone who can't open a privileged
 * note warns that they won't be notified.
 */
@Component({
  selector: 'mt-note-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/input.css',
    '../../../../../../libs/ui/src/generated/components/menu.css',
  ],
  imports: [FormsModule, MtButton, MtCheckbox, MtIconButton, MtKbd, MtNote],
  host: { class: 'mt-note-editor' },
  template: `
    <div class="mt-input frame" [attr.data-invalid]="overLimit() ? '' : null">
      <div class="toolbar" role="toolbar" [attr.aria-label]="label() + ' formatting'" [attr.aria-controls]="id">
        <button
          mtIconButton
          size="sm"
          [icon]="icons.bold"
          label="Bold"
          tooltipKbd="mod+b"
          [disabled]="busy()"
          (mousedown)="$event.preventDefault()"
          (click)="format('bold')"
        ></button>
        <button
          mtIconButton
          size="sm"
          [icon]="icons.italic"
          label="Italic"
          tooltipKbd="mod+i"
          [disabled]="busy()"
          (mousedown)="$event.preventDefault()"
          (click)="format('italic')"
        ></button>
        <button
          mtIconButton
          size="sm"
          [icon]="icons.list"
          label="Bulleted list"
          [disabled]="busy()"
          (mousedown)="$event.preventDefault()"
          (click)="format('list')"
        ></button>
        <button
          mtIconButton
          size="sm"
          [icon]="icons.link"
          label="Link"
          [disabled]="busy()"
          (mousedown)="$event.preventDefault()"
          (click)="format('link')"
        ></button>
      </div>
      <textarea
        #field
        class="field"
        rows="3"
        [id]="id"
        [attr.aria-label]="label()"
        [attr.placeholder]="placeholder()"
        aria-autocomplete="list"
        [attr.aria-controls]="listOpen() ? id + '-mentions' : null"
        [attr.aria-activedescendant]="suggestions().length ? id + '-mention-' + active() : null"
        [attr.aria-describedby]="id + '-hint'"
        [attr.aria-invalid]="overLimit() ? 'true' : null"
        [readOnly]="busy()"
        [value]="value()"
        (input)="onInput(field)"
        (keydown)="onKeydown($event)"
        (keyup)="onCaret(field, $event)"
        (click)="onCaret(field)"
        (paste)="onPaste($event, field)"
        (blur)="closeList()"
      ></textarea>
    </div>
    @if (listOpen()) {
      <ul
        class="mt-menu mentions"
        role="listbox"
        [id]="id + '-mentions'"
        [attr.aria-label]="mention()?.sigil === '#' ? 'Matters' : 'People'"
      >
        @for (item of suggestions(); track item.key) {
          <li
            class="mt-menu-item"
            role="option"
            [id]="id + '-mention-' + $index"
            [attr.aria-selected]="$index === active()"
            [attr.data-active]="$index === active() ? '' : null"
            (mousedown)="$event.preventDefault(); pick(item)"
          >
            <span class="label">{{ item.label }}</span
            ><span class="hint">{{ item.detail }}</span>
          </li>
        } @empty {
          <li class="empty" role="option" aria-disabled="true" aria-selected="false">{{ emptyText() }}</li>
        }
      </ul>
    }
    @if (overLimit()) {
      <mt-note tone="danger"
        >This note is {{ size() }}, over the {{ limit }} limit. Shorten it, or split it into two notes.</mt-note
      >
    }
    @if (unreachable().length) {
      <mt-note tone="warning">
        {{ unreachableText() }}
      </mt-note>
    }
    <div class="bar">
      @if (canPrivileged()) {
        <mt-checkbox
          label="Privileged"
          [description]="privilegedLocked() ? 'Notes on a privileged matter are always privileged.' : ''"
          [ngModel]="privilegedLocked() || privileged()"
          [disabled]="privilegedLocked() || busy()"
          (ngModelChange)="privileged.set(!!$event)"
        />
      }
      <span class="mt-grow caption t-3 hint" [id]="id + '-hint'">
        Markdown. &#64; to mention someone, # for a matter. <mt-kbd keys="mod+enter" /> to save.
      </span>
      <span class="caption size" [class.t-3]="!overLimit()" [class.over]="overLimit()" aria-live="polite">
        {{ size() }} of {{ limit }}
      </span>
      @if (cancellable()) {
        <button mtButton variant="ghost" size="sm" [disabled]="busy()" (click)="cancelled.emit()">Cancel</button>
      }
      <button mtButton variant="primary" size="sm" [loading]="busy()" [disabled]="!canSave()" (click)="submit()">
        {{ submitLabel() }}
      </button>
    </div>
  `,
  styles: `
    .mt-note-editor {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-note-editor .frame {
      flex-direction: column;
      align-items: stretch;
      height: auto;
      padding: 0;
      gap: 0;
    }
    .mt-note-editor .toolbar {
      display: flex;
      gap: var(--space-2);
      padding: var(--space-4);
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-note-editor textarea.field {
      display: block;
      width: 100%;
      min-height: 88px;
      margin: 0;
      padding: var(--space-8) var(--space-12);
      border: 0;
      outline: none;
      resize: none;
      background: transparent;
      color: var(--text-primary);
      font: 400 14px/20px var(--font-sans);
      overflow-y: auto;
    }
    .mt-note-editor textarea.field::placeholder {
      color: var(--text-tertiary);
    }
    .mt-note-editor .mentions {
      list-style: none;
      margin: 0;
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid var(--border-subtle);
    }
    .mt-note-editor .mentions .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mt-note-editor .mentions .hint {
      flex: none;
    }
    .mt-note-editor .mentions .empty {
      padding: var(--space-6) var(--space-8);
      color: var(--text-tertiary);
    }
    .mt-note-editor .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-note-editor .hint {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
      flex-wrap: wrap;
    }
    .mt-note-editor .size.over {
      color: var(--text-danger);
    }
  `,
})
export class NoteEditor {
  /** The Markdown being written. */
  readonly value = model('');
  /** The privileged flag (lawyers and above set it). */
  readonly privileged = model(false);
  /** Members for `@` (active ones are offered) and for the privileged warning (everyone mentioned). */
  readonly members = input<readonly NoteMember[]>([]);
  /** Matters matching what follows `#` (number or title). */
  readonly searchMatters = input<(query: string) => Promise<MatterOption[]>>(async () => []);
  /** The reader may mark notes privileged (privileged.view). */
  readonly canPrivileged = input(false, { transform: booleanAttribute });
  /** The matter is privileged, so the note is too. */
  readonly privilegedLocked = input(false, { transform: booleanAttribute });
  /** A save is on its way: the text is read-only. */
  readonly busy = input(false, { transform: booleanAttribute });
  /** The field's accessible name ("New note", "Edit note"). */
  readonly label = input('New note');
  readonly placeholder = input('Write a file note…');
  readonly submitLabel = input('Add note');
  /** Show Cancel (editing); Escape cancels too. */
  readonly cancellable = input(false, { transform: booleanAttribute });

  readonly save = output<NoteDraft>();
  readonly cancelled = output();

  protected readonly id = `mt-note-editor-${nextId++}`;
  protected readonly icons = { bold: Bold, italic: Italic, list: List, link: Link };
  protected readonly limit = NOTE_LIMIT_TEXT;
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');
  private readonly injector = inject(Injector);

  /** The mention being typed at the caret, if any. */
  protected readonly mention = signal<MentionQuery | null>(null);
  protected readonly active = signal(0);
  private readonly matters = signal<{ query: string; options: MatterOption[] } | null>(null);

  protected readonly size = computed(() => noteSize(this.value().length));
  protected readonly overLimit = computed(() => tooLong(this.value()));
  protected readonly isPrivileged = computed(() => this.privilegedLocked() || this.privileged());
  protected readonly canSave = computed(() => !this.busy() && !!this.value().trim() && !this.overLimit());
  protected readonly unreachable = computed(() =>
    unreachableMentions(this.value(), this.isPrivileged(), this.members()),
  );
  protected readonly unreachableText = computed(
    () =>
      `${nameList(this.unreachable().map((member) => member.name))} can’t open privileged notes, so they won’t be notified.`,
  );

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const at = this.mention();
    if (!at) return [];
    if (at.sigil === '@') {
      return matchMembers(this.members(), at.query).map((member) => ({
        key: member.uid,
        label: member.name,
        detail: member.role.charAt(0).toUpperCase() + member.role.slice(1),
        token: memberToken(member.uid),
      }));
    }
    const found = this.matters();
    if (!found || found.query !== at.query) return [];
    return found.options.map((matter) => ({
      key: matter.id,
      label: matter.title,
      detail: matter.number,
      token: matterToken(matter.id),
    }));
  });
  protected readonly listOpen = computed(() => {
    const at = this.mention();
    if (!at) return false;
    // A query with a space that matches nothing is most likely ordinary text.
    return this.suggestions().length > 0 || !at.query.includes(' ');
  });
  protected readonly emptyText = computed(() => {
    const at = this.mention();
    if (at?.sigil === '#') {
      if (at.query.trim().length < MATTER_QUERY_MIN) return 'Type a matter number or title';
      return this.matters()?.query === at.query ? 'No matters match' : 'Searching…';
    }
    return 'No one matches';
  });

  constructor() {
    // Grow with the text, including when it's set from outside (an edit starting, a reload).
    afterRenderEffect(() => {
      this.value();
      const element = this.field().nativeElement;
      element.style.height = 'auto';
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
    });
    // `#` searches matters once typing pauses; a stale answer is ignored.
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const at = this.mention();
      clearTimeout(timer);
      if (at?.sigil !== '#' || at.query.trim().length < MATTER_QUERY_MIN) return;
      const query = at.query;
      const search = this.searchMatters();
      timer = setTimeout(() => {
        search(query.trim())
          .catch(() => [])
          .then((options) => {
            if (untracked(() => this.mention()?.query) === query) this.matters.set({ query, options });
          });
      }, MATTER_SEARCH_DEBOUNCE_MS);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  }

  /** Focuses the field, the caret at the end. */
  focus(): void {
    const element = this.field().nativeElement;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }

  protected onInput(field: HTMLTextAreaElement): void {
    this.value.set(field.value);
    this.track(field);
  }

  protected onCaret(field: HTMLTextAreaElement, event?: KeyboardEvent): void {
    // The list's own keys move the highlight, not the caret.
    if (event && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    this.track(field);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (this.listOpen()) {
      const items = this.suggestions();
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.active.set((this.active() + step + items.length) % items.length);
        return;
      }
      if (((event.key === 'Enter' && !mod) || event.key === 'Tab') && items.length) {
        const item = items[this.active()];
        if (item) {
          event.preventDefault();
          this.pick(item);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeList();
        return;
      }
    }
    if (event.key === 'Enter' && mod) {
      event.preventDefault();
      this.submit();
    } else if (mod && !event.shiftKey && !event.altKey && (event.key === 'b' || event.key === 'i')) {
      event.preventDefault();
      this.format(event.key === 'b' ? 'bold' : 'italic');
    } else if (event.key === 'Escape' && this.cancellable() && !this.busy()) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelled.emit();
    }
  }

  /** Pasting puts in the clipboard's plain text, never its HTML. */
  protected onPaste(event: ClipboardEvent, field: HTMLTextAreaElement): void {
    event.preventDefault();
    if (this.busy()) return;
    const text = pastedText(event.clipboardData);
    if (!text) return;
    this.apply(insertText(field.value, field.selectionStart, field.selectionEnd, text));
  }

  protected format(kind: NoteFormat): void {
    if (this.busy()) return;
    const field = this.field().nativeElement;
    this.apply(applyFormat(field.value, field.selectionStart, field.selectionEnd, kind));
  }

  protected pick(item: Suggestion): void {
    const at = this.mention();
    if (!at) return;
    const next = insertMention(this.value(), at, item.token);
    this.apply({ text: next.text, selectionStart: next.caret, selectionEnd: next.caret });
    this.closeList();
  }

  protected closeList(): void {
    this.mention.set(null);
    this.active.set(0);
  }

  protected submit(): void {
    if (!this.canSave()) return;
    this.closeList();
    this.save.emit({ bodyMd: this.value(), privileged: this.isPrivileged() });
  }

  private track(field: HTMLTextAreaElement): void {
    const at = field.selectionStart === field.selectionEnd ? mentionAt(field.value, field.selectionStart) : null;
    const before = this.mention();
    if (at?.sigil !== before?.sigil || at?.query !== before?.query) this.active.set(0);
    this.mention.set(at);
  }

  /** Writes an edit to the field and restores the selection after it renders. */
  private apply(edit: TextEdit): void {
    const field = this.field().nativeElement;
    field.value = edit.text;
    this.value.set(edit.text);
    field.focus();
    field.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    afterNextRender(() => field.setSelectionRange(edit.selectionStart, edit.selectionEnd), {
      injector: this.injector,
    });
    this.track(field);
  }
}
