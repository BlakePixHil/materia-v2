import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { Pin, PinOff } from 'lucide';

import { can } from '@materia/data-access';
import {
  compareNotes,
  matterNoteRepository,
  matterNotesQuery,
  noteCallables,
  noteConflictOf,
} from '@materia/data-access/repository';
import type { SaveNoteResult } from '@materia/domain';
import {
  DialogService,
  MtAvatar,
  MtBadge,
  MtButton,
  MtEmptyState,
  MtIconButton,
  MtNote,
  ToastService,
} from '@materia/ui';
import { MtMarkdown } from '@materia/ui/markdown';

import { matterSearch } from './matter-search';
import type { NoteConflictChoice, NoteConflictDialogData, NoteHistoryDialogData } from './note-dialogs';
import { NoteEditor, type NoteDraft } from './note-editor';
import { matterResolver, memberResolver } from './note-mentions';
import { noteTime } from './note-time';
import {
  mentionsAcross,
  nameList,
  noteAuthor,
  noteErrorCopy,
  type NoteMember,
  type NoteRecord,
  versionOf,
} from './note-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { MatterScreen } from '../matter-detail/matter-screen';

/** A note being edited: the draft, and the version it started from (`expectedUpdatedAt`). */
interface NoteEdit {
  noteId: string;
  text: string;
  privileged: boolean;
  /** ISO 8601: the note's `updatedAt` when editing started, or theirs after a reload. */
  expectedUpdatedAt: string;
  saving: boolean;
  /** Their version, after "Reload theirs" on a conflict, shown above the draft to merge from. */
  theirs?: { bodyMd: string; by: string; when: string } | undefined;
}

/**
 * A matter's Notes tab (CORE-13): a composer, then the notes, pinned first and then newest. Notes
 * are Markdown with `@` member and `#` matter mentions (`mt-markdown` renders them), written and
 * edited through `notes-create`/`notes-update`; pinning, deleting (with Undo) and restoring are
 * client writes. An edit sends the version it started from, and a conflicting save asks whether to
 * overwrite theirs or reload it and merge. "Edited" opens the note's history.
 *
 * Keyboard: `c` writes a note, `j`/`k` move between notes, `e` edits and `p` pins the focused one.
 * Listens to the matter's notes only while this tab is shown.
 */
@Component({
  selector: 'mt-matter-notes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/card.css'],
  imports: [MtAvatar, MtBadge, MtButton, MtEmptyState, MtIconButton, MtMarkdown, MtNote, NoteEditor],
  host: { class: 'mt-matter-notes' },
  template: `
    <div class="mt-row head">
      <h2 class="title-m">Notes</h2>
      @if (notes.status() !== 'loading') {
        <span class="caption t-3">{{ rows().length === 1 ? '1 note' : rows().length + ' notes' }}</span>
      }
    </div>
    @if (canWrite()) {
      <section class="mt-card composer" data-pad aria-label="New note">
        <mt-note-editor
          #composer
          [(value)]="draft"
          [(privileged)]="draftPrivileged"
          [members]="members()"
          [searchMatters]="searchMatters"
          [canPrivileged]="screen.canPrivileged()"
          [privilegedLocked]="matterPrivileged()"
          [busy]="creating()"
          (save)="create($event)"
        />
      </section>
    }
    @switch (notes.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading notes…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="notes.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        @if (rows().length) {
          <ul class="notes" aria-label="Notes">
            @for (note of rows(); track note.id; let i = $index) {
              <li>
                <article
                  class="mt-card note"
                  data-pad
                  [id]="'note-' + note.id"
                  [attr.data-note]="note.id"
                  [attr.data-highlight]="highlighted() === note.id ? '' : null"
                  [attr.tabindex]="i === cursor() ? 0 : -1"
                  [attr.aria-labelledby]="'mt-note-' + note.id"
                  (focus)="focused(i, note.id)"
                >
                  <header class="mt-row meta">
                    <mt-avatar size="sm" aria-hidden="true" [name]="author(note)" [colorKey]="note.createdBy" />
                    <span class="mt-grow who" [id]="'mt-note-' + note.id">
                      <b>{{ author(note) }}</b>
                      <span class="caption t-3"> · {{ when(note.createdAt) }}</span>
                      @if (note.editedAt) {
                        <button
                          type="button"
                          class="edited caption"
                          [attr.aria-label]="'Edited ' + when(note.editedAt) + '. Show history'"
                          (click)="history(note)"
                        >
                          edited
                        </button>
                      }
                    </span>
                    @if (note.pinned) {
                      <mt-badge tone="brand">Pinned</mt-badge>
                    }
                    @if (note.privileged) {
                      <mt-badge tone="warning">Privileged</mt-badge>
                    }
                    @if (canWrite() && editing()?.noteId !== note.id) {
                      <span class="actions">
                        <button
                          mtIconButton
                          size="sm"
                          [icon]="note.pinned ? icons.unpin : icons.pin"
                          [label]="note.pinned ? 'Unpin note' : 'Pin note'"
                          tooltipKbd="p"
                          (click)="pin(note)"
                        ></button>
                        <button
                          mtIconButton
                          size="sm"
                          icon="compose"
                          label="Edit note"
                          tooltipKbd="e"
                          (click)="startEdit(note)"
                        ></button>
                        <button mtIconButton size="sm" icon="trash" label="Delete note" (click)="remove(note)"></button>
                      </span>
                    }
                  </header>
                  @if (editing(); as edit) {
                    @if (edit.noteId === note.id) {
                      @if (edit.theirs; as theirs) {
                        <div class="theirs" role="group" aria-label="Their version">
                          <mt-note>
                            {{ version(theirs.by) }} from {{ theirs.when }} is below; your draft is in the editor. Merge
                            what you need, then save.
                          </mt-note>
                          <mt-markdown mentions [content]="theirs.bodyMd" [member]="member()" [matter]="matter()" />
                          <span class="mt-row">
                            <button mtButton size="sm" variant="ghost" (click)="useTheirs()">Use their version</button>
                          </span>
                        </div>
                      }
                      <mt-note-editor
                        #editor
                        label="Edit note"
                        submitLabel="Save"
                        cancellable
                        [value]="edit.text"
                        (valueChange)="editText($event)"
                        [privileged]="edit.privileged"
                        (privilegedChange)="editPrivileged($event)"
                        [members]="members()"
                        [searchMatters]="searchMatters"
                        [canPrivileged]="screen.canPrivileged()"
                        [privilegedLocked]="matterPrivileged()"
                        [busy]="edit.saving"
                        (save)="saveEdit($event)"
                        (cancelled)="cancelEdit()"
                      />
                    } @else {
                      <mt-markdown mentions [content]="note.bodyMd" [member]="member()" [matter]="matter()" />
                    }
                  } @else {
                    <mt-markdown mentions [content]="note.bodyMd" [member]="member()" [matter]="matter()" />
                  }
                </article>
              </li>
            }
          </ul>
        } @else {
          <mt-empty-state
            icon="compose"
            title="No notes yet"
            [description]="
              canWrite()
                ? 'Press c to write a file note. Mention someone with @ to let them know.'
                : 'File notes on this matter show here.'
            "
            [headingLevel]="3"
          />
        }
      }
    }
    <p class="mt-sr" aria-live="polite">{{ announcement() }}</p>
  `,
  styles: `
    .mt-matter-notes {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-width: 860px;
    }
    .mt-matter-notes h2 {
      margin: 0;
    }
    .mt-matter-notes .notes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-matter-notes .note {
      scroll-margin-block: var(--space-24);
    }
    .mt-matter-notes .note:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The note a link pointed at (a mention notification): #note-{id}. */
    .mt-matter-notes .note[data-highlight] {
      background: var(--bg-selected);
      border-color: var(--border-focus);
    }
    .mt-matter-notes .meta {
      flex-wrap: wrap;
      font: 400 13px/18px var(--font-sans);
    }
    .mt-matter-notes .meta b {
      font-weight: 600;
    }
    .mt-matter-notes .actions {
      display: inline-flex;
      gap: var(--space-2);
    }
    .mt-matter-notes .edited {
      margin-left: var(--space-4);
      padding: 0;
      border: 0;
      background: none;
      color: var(--text-tertiary);
      text-decoration: underline;
      text-underline-offset: 2px;
      cursor: pointer;
    }
    .mt-matter-notes .edited:hover {
      color: var(--text-secondary);
    }
    .mt-matter-notes .edited:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
      border-radius: var(--radius-xs);
    }
    .mt-matter-notes .theirs {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding: var(--space-12);
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
    }
  `,
})
export class MatterNotes {
  protected readonly screen = inject(MatterScreen);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = noteCallables(inject(CALLABLES));
  private readonly id = this.screen.id;
  private readonly repo = matterNoteRepository(this.id);
  private readonly composer = viewChild<NoteEditor>('composer');
  private readonly editor = viewChild<NoteEditor>('editor');

  private readonly canNote = can('note.write');
  /** The role may write notes and the matter isn't deleted. */
  protected readonly canWrite = computed(() => this.canNote() && !this.screen.deleted());
  protected readonly matterPrivileged = computed(() => !!this.screen.value()?.privileged);

  protected readonly notes = this.repo.watchQuery(() =>
    this.id() ? matterNotesQuery({ privilegedVisible: this.screen.canPrivileged() }) : null,
  );
  protected readonly rows = computed(() => [...this.notes.value()].sort(compareNotes));
  protected readonly loadError = computed(() => errorCopy(this.notes.error()));

  protected readonly members = computed<NoteMember[]>(() => this.screen.memberList());
  protected readonly member = memberResolver(this.members);
  protected readonly matter = matterResolver(() => {
    const theirs = this.editing()?.theirs?.bodyMd;
    return mentionsAcross([...this.rows().map((note) => note.bodyMd), ...(theirs ? [theirs] : [])]).matterIds;
  });
  protected readonly searchMatters = matterSearch(() => this.screen.canPrivileged());

  protected readonly icons = { pin: Pin, unpin: PinOff };
  protected readonly draft = signal('');
  protected readonly draftPrivileged = signal(false);
  protected readonly creating = signal(false);
  protected readonly editing = signal<NoteEdit | null>(null);
  /** The note that takes Tab (roving focus; `j`/`k` move it). */
  protected readonly cursor = signal(0);
  protected readonly announcement = signal('');
  /** The note a `#note-{id}` link pointed at (a mention notification), highlighted until another is focused. */
  protected readonly highlighted = signal<string | null>(null);
  private readonly fragment = toSignal(inject(ActivatedRoute).fragment, { initialValue: null });

  constructor() {
    const shortcuts = inject(ShortcutService);
    const cleanups = [
      shortcuts.register({
        combo: 'c',
        description: 'Write a note',
        group: 'Notes',
        scope: 'route',
        when: () => this.canWrite(),
        handler: () => this.composer()?.focus(),
      }),
      shortcuts.register({
        combo: 'j',
        description: 'Next note',
        group: 'Notes',
        scope: 'route',
        when: () => this.rows().length > 0,
        handler: () => this.move(1),
      }),
      shortcuts.register({
        combo: 'k',
        description: 'Previous note',
        group: 'Notes',
        scope: 'route',
        when: () => this.rows().length > 0,
        handler: () => this.move(-1),
      }),
      shortcuts.register({
        combo: 'e',
        description: 'Edit the focused note',
        group: 'Notes',
        scope: 'route',
        when: () => this.canWrite() && !!this.focusedNote(),
        handler: () => {
          const note = this.focusedNote();
          if (note) this.startEdit(note);
        },
      }),
      shortcuts.register({
        combo: 'p',
        description: 'Pin or unpin the focused note',
        group: 'Notes',
        scope: 'route',
        when: () => this.canWrite() && !!this.focusedNote(),
        handler: () => {
          const note = this.focusedNote();
          if (note) this.pin(note);
        },
      }),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));

    // `/matters/{id}/notes#note-{noteId}` (mention notifications): once the notes load, scroll to
    // that note, highlight and focus it. Each link is handled once; a note that's gone says so.
    let handled: string | null = null;
    effect(() => {
      const fragment = this.fragment();
      const noteId = /^note-(.+)$/.exec(fragment ?? '')?.[1];
      if (!noteId || fragment === handled || this.notes.status() === 'loading') return;
      handled = fragment;
      const index = this.rows().findIndex((note) => note.id === noteId);
      untracked(() => {
        if (index === -1) {
          this.toasts.show({
            title: 'That note isn’t here',
            description: 'It was deleted, or you can’t open it.',
            tone: 'neutral',
          });
          return;
        }
        this.cursor.set(index);
        this.highlighted.set(noteId);
        afterNextRender(
          () => {
            const article = this.articles()[index];
            article?.scrollIntoView?.({ block: 'center' });
            article?.focus({ preventScroll: true });
          },
          { injector: this.injector },
        );
      });
    });
  }

  protected focused(index: number, noteId: string): void {
    this.cursor.set(index);
    if (this.highlighted() !== noteId) this.highlighted.set(null);
  }

  protected author(note: NoteRecord): string {
    return noteAuthor(note, (uid) => this.screen.memberName(uid));
  }

  protected version(by: string): string {
    const text = versionOf(by);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  protected when(at: Date): string {
    return this.time(at);
  }

  private readonly time = noteTime();

  // ---------- writing ----------

  /** Adds a note through `notes-create`; the draft stays if it fails. */
  protected async create(draft: NoteDraft): Promise<void> {
    const matterId = this.id();
    if (!matterId || this.creating()) return;
    this.creating.set(true);
    try {
      const result = await this.api.create({
        matterId,
        bodyMd: draft.bodyMd,
        ...(this.screen.canPrivileged() ? { privileged: draft.privileged } : {}),
      });
      this.draft.set('');
      this.draftPrivileged.set(false);
      this.saved('Note added', result);
      this.cursor.set(0);
    } catch (error) {
      this.toasts.show({ title: 'The note didn’t save', description: noteErrorCopy(error, 'create'), tone: 'danger' });
    } finally {
      this.creating.set(false);
    }
  }

  protected startEdit(note: NoteRecord): void {
    if (!this.canWrite()) return;
    this.editing.set({
      noteId: note.id,
      text: note.bodyMd,
      privileged: note.privileged,
      expectedUpdatedAt: note.updatedAt.toISOString(),
      saving: false,
    });
    afterNextRender(() => this.editor()?.focus(), { injector: this.injector });
  }

  protected editText(text: string): void {
    this.editing.update((edit) => (edit ? { ...edit, text } : edit));
  }

  protected editPrivileged(privileged: boolean): void {
    this.editing.update((edit) => (edit ? { ...edit, privileged } : edit));
  }

  protected cancelEdit(): void {
    const noteId = this.editing()?.noteId;
    this.editing.set(null);
    if (noteId) this.focusNote(noteId);
  }

  /** Replaces the draft with their version (after a reload). */
  protected useTheirs(): void {
    this.editing.update((edit) => (edit?.theirs ? { ...edit, text: edit.theirs.bodyMd, theirs: undefined } : edit));
  }

  /**
   * Saves an edit through `notes-update` with the version it started from. Someone else's save in
   * between fails with `note_conflict`: the dialog then overwrites theirs or reloads it to merge.
   */
  protected async saveEdit(draft: NoteDraft, overwrite = false): Promise<void> {
    const edit = this.editing();
    const matterId = this.id();
    if (!edit || !matterId || edit.saving) return;
    this.editing.set({ ...edit, text: draft.bodyMd, privileged: draft.privileged, saving: true });
    try {
      const result = await this.api.update({
        matterId,
        noteId: edit.noteId,
        bodyMd: draft.bodyMd,
        ...(this.screen.canPrivileged() ? { privileged: draft.privileged } : {}),
        expectedUpdatedAt: edit.expectedUpdatedAt,
        ...(overwrite ? { overwrite: true } : {}),
      });
      this.editing.set(null);
      this.saved('Note saved', result);
      this.focusNote(edit.noteId);
    } catch (error) {
      this.editing.update((current) => (current ? { ...current, saving: false } : current));
      const conflict = noteConflictOf(error);
      if (conflict && !overwrite) await this.resolveConflict(edit.noteId, draft, conflict);
      else
        this.toasts.show({ title: 'The note didn’t save', description: noteErrorCopy(error, 'edit'), tone: 'danger' });
    }
  }

  private async resolveConflict(
    noteId: string,
    draft: NoteDraft,
    conflict: { updatedAt: string | null; updatedBy: string | null },
  ): Promise<void> {
    const current = this.rows().find((note) => note.id === noteId);
    const byUid = conflict.updatedBy ?? current?.updatedBy ?? '';
    // A pin moves `updatedAt` too: the reader may have pinned it themselves in another tab.
    const by = byUid === this.screen.me() ? 'You' : this.screen.memberName(byUid);
    const at = conflict.updatedAt ? new Date(conflict.updatedAt) : current?.updatedAt;
    const when = at ? this.time(at) : 'just now';
    const { NoteConflictDialog } = await import('./note-dialogs');
    const choice = await this.dialogs.open<NoteConflictDialogData, NoteConflictChoice | undefined>(NoteConflictDialog, {
      data: { by, when },
    }).result;
    if (choice === 'overwrite') {
      await this.saveEdit(draft, true);
      return;
    }
    if (choice === 'reload') {
      let theirs: NoteRecord | null | undefined = current;
      try {
        theirs = (await this.repo.get(noteId)) ?? current;
      } catch {
        // Offline or refused: what the list last showed will do.
      }
      if (!theirs) {
        this.toasts.show({ title: 'The note was deleted', description: 'Your draft is still in the editor.' });
        return;
      }
      const reloaded = theirs;
      this.editing.update((edit) =>
        edit?.noteId === noteId
          ? {
              ...edit,
              text: draft.bodyMd,
              privileged: draft.privileged,
              expectedUpdatedAt: conflict.updatedAt ?? reloaded.updatedAt.toISOString(),
              theirs: { bodyMd: reloaded.bodyMd, by, when },
            }
          : edit,
      );
      this.say(`Loaded ${versionOf(by)}. Your draft is kept.`);
    }
    afterNextRender(() => this.editor()?.focus(), { injector: this.injector });
  }

  /** After a save: a toast, saying who wasn't notified because they can't open the note. */
  private saved(title: string, result: SaveNoteResult): void {
    const missed = result.unreachable.map((uid) => this.screen.memberName(uid));
    if (missed.length) {
      this.toasts.show({
        title: `${title}. ${nameList(missed)} ${missed.length === 1 ? 'wasn’t' : 'weren’t'} notified`,
        description: 'They can’t open privileged notes.',
        tone: 'neutral',
        duration: 0,
      });
    } else {
      this.toasts.show({ title, tone: 'success' });
    }
  }

  // ---------- pin, delete, history ----------

  /** Pins or unpins (a client write: it queues offline). */
  protected pin(note: NoteRecord): void {
    if (!this.canWrite()) return;
    const pinned = !note.pinned;
    this.repo
      .update(note.id, { pinned })
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The note didn’t change', description: errorCopy(error), tone: 'danger' }),
      );
    this.say(pinned ? 'Pinned the note.' : 'Unpinned the note.');
  }

  /** Deletes (soft) without asking; the toast's Undo restores it. */
  protected remove(note: NoteRecord): void {
    if (!this.canWrite()) return;
    if (this.editing()?.noteId === note.id) this.editing.set(null);
    this.repo
      .softDelete(note.id)
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The note didn’t delete', description: errorCopy(error), tone: 'danger' }),
      );
    this.toasts.show({
      title: 'Note deleted',
      tone: 'neutral',
      action: { label: 'Undo', run: () => this.restore(note.id) },
    });
  }

  private restore(noteId: string): void {
    this.repo
      .restore(noteId)
      .then(() => this.say('Restored the note.'))
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The note wasn’t restored', description: errorCopy(error), tone: 'danger' }),
      );
  }

  /** The note's earlier versions (loaded on demand). */
  protected async history(note: NoteRecord): Promise<void> {
    const matterId = this.id();
    if (!matterId) return;
    const { NoteHistoryDialog } = await import('./note-dialogs');
    await this.dialogs.open<NoteHistoryDialogData>(NoteHistoryDialog, {
      data: {
        matterId,
        noteId: note.id,
        privilegedVisible: this.screen.canPrivileged(),
        memberName: (uid) => this.screen.memberName(uid),
        when: (at) => this.time(at),
        member: this.member(),
        matter: this.matter(),
      },
    }).result;
  }

  // ---------- keyboard ----------

  private move(step: number): void {
    const count = this.rows().length;
    if (!count) return;
    const from = this.focusedIndex();
    const next = from === -1 ? (step > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, from + step));
    this.cursor.set(next);
    this.articles()[next]?.focus();
  }

  private focusedIndex(): number {
    const active = document.activeElement;
    return this.articles().findIndex((article) => article === active || article.contains(active));
  }

  private focusedNote(): NoteRecord | undefined {
    const index = this.focusedIndex();
    return index === -1 ? undefined : this.rows()[index];
  }

  private articles(): HTMLElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLElement>('article[data-note]')];
  }

  private focusNote(noteId: string): void {
    afterNextRender(
      () =>
        this.articles()
          .find((article) => article.dataset['note'] === noteId)
          ?.focus(),
      {
        injector: this.injector,
      },
    );
  }

  private say(message: string): void {
    // Clear first so the same words are announced again.
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(message));
  }
}
