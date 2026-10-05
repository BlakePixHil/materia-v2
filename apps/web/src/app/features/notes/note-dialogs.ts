import { ChangeDetectionStrategy, Component, computed } from '@angular/core';

import {
  forMatter,
  noteRevisionRepository,
  noteRevisionsQuery,
  type NoteRevisionItem,
  type WithId,
} from '@materia/data-access/repository';
import { injectDialogRef, MtButton, MtDialog, MtNote } from '@materia/ui';
import { MtMarkdown, type MtMentionMatterResolver, type MtMentionMemberResolver } from '@materia/ui/markdown';

/** What the conflict dialog says: who last changed the note ("You" when it was the reader) and when ("Today at 10:42 am"). */
export interface NoteConflictDialogData {
  by: string;
  when: string;
}

/** Save the draft over theirs, or reload theirs and keep the draft to merge; undefined keeps editing. */
export type NoteConflictChoice = 'overwrite' | 'reload';

/**
 * The note changed after editing started (`note_conflict`, CORE-13): someone saved an edit, or
 * pinned or unpinned it (a pin moves `updatedAt` too, so a pin made elsewhere lands here). Saving
 * anyway replaces the text with the draft (their text stays in the history; a pin is kept);
 * reloading shows theirs next to the draft to merge.
 */
@Component({
  selector: 'mt-note-conflict-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDialog],
  template: `
    <mt-dialog size="sm" title="This note changed since you started editing" [description]="description">
      <p class="caption t-2">
        It may have been edited, or only pinned or unpinned. Your draft is kept either way, and the text you replace
        stays in the note’s history.
      </p>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Keep editing</button>
        <button mtButton variant="danger" (click)="ref.close('overwrite')">Save mine anyway</button>
        <button mtButton variant="primary" (click)="ref.close('reload')">Reload theirs and merge</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class NoteConflictDialog {
  protected readonly ref = injectDialogRef<NoteConflictDialogData, NoteConflictChoice | undefined>();
  protected readonly description = `Last changed by ${this.ref.data.by} · ${this.ref.data.when}.`;
}

/** The note whose history is shown, and how to name people and matters in it. */
export interface NoteHistoryDialogData {
  matterId: string;
  noteId: string;
  /** Whether the reader may see privileged revisions (`privileged.view`); without it only non-privileged ones are read. */
  privilegedVisible: boolean;
  /** "Priya Shah" by uid. */
  memberName: (uid: string) => string;
  /** "Today at 10:42 am". */
  when: (at: Date) => string;
  member: MtMentionMemberResolver;
  matter: MtMentionMatterResolver;
}

/**
 * A note's earlier versions (CORE-13), newest first: each one's text as it was, who wrote it and
 * when. Read-only; `notes-update` appends one before every edit.
 */
@Component({
  selector: 'mt-note-history-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDialog, MtMarkdown, MtNote],
  template: `
    <mt-dialog size="lg" title="Note history" description="Earlier versions of this note, newest first.">
      @switch (revisions.status()) {
        @case ('loading') {
          <p class="caption t-3" role="status">Loading history…</p>
        }
        @case ('error') {
          <mt-note tone="danger">The history couldn’t be loaded. Close this and try again.</mt-note>
        }
        @default {
          <ol class="mt-note-history">
            @for (revision of rows(); track revision.id) {
              <li>
                <p class="caption t-2 who">
                  {{ data.memberName(revision.editedBy) }} · {{ data.when(revision.editedAt) }}
                  @if (revision.privileged) {
                    · Privileged
                  }
                </p>
                <mt-markdown mentions [content]="revision.bodyMd" [member]="data.member" [matter]="data.matter" />
              </li>
            } @empty {
              <li class="caption t-3">No earlier versions.</li>
            }
          </ol>
        }
      }
      <ng-container mtDialogFooter>
        <button mtButton variant="primary" (click)="ref.close()">Done</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-note-history {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-height: 60vh;
      overflow-y: auto;
    }
    .mt-note-history li + li {
      padding-top: var(--space-16);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-note-history .who {
      margin: 0 0 var(--space-4);
    }
  `,
})
export class NoteHistoryDialog {
  protected readonly ref = injectDialogRef<NoteHistoryDialogData, undefined>();
  protected readonly data = this.ref.data;
  private readonly matterId = () => this.data.matterId;
  protected readonly revisions = noteRevisionRepository(this.matterId, () => this.data.noteId).watchQuery(
    forMatter(this.matterId, noteRevisionsQuery({ privilegedVisible: this.data.privilegedVisible })),
    { live: false },
  );
  protected readonly rows = computed<WithId<NoteRevisionItem>[]>(() => this.revisions.value());
}
