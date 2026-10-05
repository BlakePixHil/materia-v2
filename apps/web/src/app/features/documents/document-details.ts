import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  canAddVersion,
  DOCUMENT_NAME_MAX,
  DOCUMENT_NOTES_MAX,
  DOCUMENT_TAG_MAX,
  DOCUMENT_TAGS_MAX,
  versionHistory,
} from '@materia/domain';
import {
  formatDateOnly,
  MtButton,
  MtSelect,
  MtSwitch,
  MtTextarea,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { DocumentActions } from './document-actions';
import { DocumentUploads } from './document-uploads';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  isReadable,
  parseTags,
  UPLOAD_ACCEPT,
  versionSummary,
  type DocumentCategory,
  type DocumentRow,
} from './documents-view';
import { MatterScreen } from '../matter-detail/matter-screen';

/** Why the details can't be saved as typed, or null. */
export function detailsProblem(name: string, tags: readonly string[], notes: string): string | null {
  if (!name.trim()) return 'Give the document a name.';
  if (name.trim().length > DOCUMENT_NAME_MAX) return `Keep the name to ${DOCUMENT_NAME_MAX} characters.`;
  if (tags.length > DOCUMENT_TAGS_MAX) return `Use at most ${DOCUMENT_TAGS_MAX} tags.`;
  if (tags.some((tag) => tag.length > DOCUMENT_TAG_MAX)) return `Keep each tag to ${DOCUMENT_TAG_MAX} characters.`;
  if (notes.length > DOCUMENT_NOTES_MAX)
    return `Keep notes to ${DOCUMENT_NOTES_MAX.toLocaleString('en-AU')} characters.`;
  return null;
}

/**
 * A document's details beside its preview (CORE-12): rename, category, tags and notes
 * (document.upload roles), the privileged flag (privileged.view only), the version history with
 * Download, Restore and Upload new version, and Remove or Restore for document.delete roles.
 * Everyone else sees the same facts read-only.
 */
@Component({
  selector: 'mt-document-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtSelect, MtSwitch, MtTextarea, MtTextField],
  host: { class: 'mt-document-details' },
  template: `
    @if (doc(); as d) {
      @if (editable()) {
        <form class="fields" (submit)="$event.preventDefault(); save()">
          <mt-text-field name="name" label="Name" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
          <mt-select
            name="category"
            label="Category"
            [native]="true"
            [options]="categoryOptions"
            [ngModel]="category()"
            (ngModelChange)="category.set($event ?? 'other')"
          />
          <mt-text-field
            name="tags"
            label="Tags"
            [optional]="true"
            description="Separate tags with commas."
            [ngModel]="tags()"
            (ngModelChange)="tags.set($event ?? '')"
          />
          <mt-textarea
            name="notes"
            label="Notes"
            [optional]="true"
            [ngModel]="notes()"
            (ngModelChange)="notes.set($event ?? '')"
          />
          @if (problem(); as p) {
            <p class="caption error" role="alert">{{ p }}</p>
          }
          <button
            mtButton
            variant="primary"
            size="sm"
            type="submit"
            [disabled]="!dirty() || saving()"
            [loading]="saving()"
          >
            Save changes
          </button>
        </form>
      } @else {
        <dl class="facts">
          <dt>Category</dt>
          <dd>{{ categoryLabels[d.category] }}</dd>
          <dt>Tags</dt>
          <dd>{{ d.tags.length ? d.tags.join(', ') : 'None' }}</dd>
          @if (d.notes) {
            <dt>Notes</dt>
            <dd class="notes">{{ d.notes }}</dd>
          }
        </dl>
      }

      @if (canPrivileged()) {
        <mt-switch
          label="Privileged"
          description="Hidden from paralegals and read-only users, and never sent anywhere without someone choosing to."
          [disabled]="!editable()"
          [ngModel]="d.privileged"
          (ngModelChange)="setPrivileged($event)"
        />
      }

      <section class="versions" aria-labelledby="versions-heading">
        <div class="mt-row">
          <h3 id="versions-heading" class="label">Versions</h3>
          @if (editable() && canAddVersion() && readable()) {
            <input
              #versionPicker
              type="file"
              hidden
              data-testid="version-upload-input"
              [accept]="accept"
              (change)="pickedVersion($event)"
            />
            <button mtButton variant="ghost" size="sm" iconStart="upload" class="mt-ml" (click)="versionPicker.click()">
              Upload new version
            </button>
          }
        </div>
        @if (history().length) {
          <ol>
            @for (v of history(); track v.version) {
              <li [attr.aria-current]="v.version === d.version ? 'true' : null">
                <div class="mt-col">
                  <span class="label"> Version {{ v.version }}{{ v.version === d.version ? ' (current)' : '' }} </span>
                  <span class="caption t-3">{{ summary(v) }} · {{ v.fileName }}</span>
                  <span class="caption t-3">
                    {{ when(v.uploadedAt) }} by {{ screen.memberName(v.uploadedBy)
                    }}{{ v.restoredFrom ? ' · restored from version ' + v.restoredFrom : '' }}
                  </span>
                </div>
                <span class="actions">
                  @if (readable()) {
                    <button
                      mtButton
                      variant="ghost"
                      size="sm"
                      [attr.aria-label]="'Download version ' + v.version"
                      (click)="actions.download(d.id, v.version)"
                    >
                      Download
                    </button>
                  }
                  @if (editable() && v.version !== d.version && canAddVersion()) {
                    <button
                      mtButton
                      variant="ghost"
                      size="sm"
                      [disabled]="actions.busy()"
                      [attr.aria-label]="'Restore version ' + v.version"
                      (click)="actions.restoreVersion(d.id, v.version)"
                    >
                      Restore
                    </button>
                  }
                </span>
              </li>
            }
          </ol>
        } @else {
          <p class="caption t-3">No stored version yet.</p>
        }
      </section>

      @if (canDelete()) {
        <div class="danger">
          @if (d.deletedAt) {
            <button mtButton size="sm" iconStart="check" [disabled]="actions.busy()" (click)="actions.restore([d.id])">
              Restore document
            </button>
          } @else {
            <button
              mtButton
              variant="ghost"
              size="sm"
              iconStart="trash"
              [disabled]="actions.busy()"
              (click)="actions.remove([d.id])"
            >
              Remove document
            </button>
          }
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      min-width: 0;
    }
    .fields {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-12);
    }
    .fields > button {
      align-self: flex-start;
    }
    .error {
      margin: 0;
      color: var(--text-danger);
    }
    .facts {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--space-4) var(--space-12);
      margin: 0;
      font: 400 13px/18px var(--font-sans);
    }
    dt {
      color: var(--text-secondary);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .notes {
      white-space: pre-wrap;
    }
    .versions h3 {
      margin: 0;
    }
    ol {
      list-style: none;
      margin: var(--space-8) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    li {
      display: flex;
      align-items: flex-start;
      gap: var(--space-8);
      padding: var(--space-8);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-subtle);
    }
    li[aria-current] {
      border-color: var(--border-focus);
    }
    li .mt-col {
      flex: 1;
      min-width: 0;
      gap: 2px;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
    }
  `,
})
export class DocumentDetails {
  protected readonly screen = inject(MatterScreen);
  protected readonly actions = inject(DocumentActions);
  private readonly uploads = inject(DocumentUploads);
  private readonly toasts = inject(ToastService);

  readonly doc = input.required<DocumentRow | null>();
  /** document.upload, on a live matter. */
  readonly canEdit = input(false);
  readonly canDelete = input(false);
  readonly canPrivileged = input(false);

  protected readonly name = signal('');
  protected readonly category = signal<DocumentCategory>('other');
  protected readonly tags = signal('');
  protected readonly notes = signal('');
  protected readonly saving = signal(false);

  protected readonly editable = computed(() => this.canEdit() && !this.doc()?.deletedAt);
  protected readonly readable = computed(() => {
    const doc = this.doc();
    return !!doc && isReadable(doc);
  });
  protected readonly canAddVersion = computed(() => {
    const doc = this.doc();
    return !!doc && canAddVersion(doc);
  });
  protected readonly history = computed(() => {
    const doc = this.doc();
    return doc ? versionHistory(doc) : [];
  });
  protected readonly dirty = computed(() => {
    const doc = this.doc();
    if (!doc) return false;
    return (
      this.name().trim() !== doc.name ||
      this.category() !== doc.category ||
      parseTags(this.tags()).join(',') !== doc.tags.join(',') ||
      this.notes() !== (doc.notes ?? '')
    );
  });
  protected readonly problem = computed(() => detailsProblem(this.name(), parseTags(this.tags()), this.notes()));

  protected readonly categoryLabels = DOCUMENT_CATEGORY_LABELS;
  protected readonly categoryOptions: MtOption<DocumentCategory>[] = DOCUMENT_CATEGORIES.map((value) => ({
    value,
    label: DOCUMENT_CATEGORY_LABELS[value],
  }));
  protected readonly accept = UPLOAD_ACCEPT;

  constructor() {
    // A different document (or the saved values changing under a clean form) resets the form.
    let shownId: string | null = null;
    effect(() => {
      const doc = this.doc();
      if (!doc) return;
      untracked(() => {
        if (doc.id === shownId && this.dirty()) return;
        shownId = doc.id;
        this.reset(doc);
      });
    });
  }

  protected summary = versionSummary;

  protected when(date: Date): string {
    return formatDateOnly(date);
  }

  protected async save(): Promise<void> {
    const doc = this.doc();
    if (!doc || !this.dirty() || this.problem()) return;
    this.saving.set(true);
    const notes = this.notes();
    const saved = await this.actions.update(
      doc.id,
      {
        name: this.name().trim(),
        category: this.category(),
        tags: parseTags(this.tags()),
        ...(notes || doc.notes !== undefined ? { notes } : {}),
      },
      'Document details saved',
    );
    this.saving.set(false);
    if (saved)
      this.reset({ ...doc, name: this.name().trim(), category: this.category(), tags: parseTags(this.tags()), notes });
  }

  protected async setPrivileged(privileged: boolean): Promise<void> {
    const doc = this.doc();
    if (!doc || doc.privileged === privileged) return;
    await this.actions.update(doc.id, { privileged }, privileged ? 'Marked privileged' : 'No longer privileged');
  }

  protected pickedVersion(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const doc = this.doc();
    const matterId = this.screen.id();
    if (!file || !doc || !matterId) return;
    this.uploads.add(matterId, [file], { documentId: doc.id });
    this.toasts.show({
      title: 'Uploading a new version',
      description: 'It becomes current once the malware check is done.',
    });
  }

  private reset(doc: Pick<DocumentRow, 'name' | 'category' | 'tags' | 'notes'>): void {
    this.name.set(doc.name);
    this.category.set(doc.category);
    this.tags.set(doc.tags.join(', '));
    this.notes.set(doc.notes ?? '');
  }
}
