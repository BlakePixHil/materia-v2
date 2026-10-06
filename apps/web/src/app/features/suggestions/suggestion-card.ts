import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import {
  suggestionCallables,
  suggestionFieldErrorsOf,
  suggestionStaleOf,
  type SuggestionCallables,
} from '@materia/data-access/repository';
import { SUGGESTION_DISMISS_REASONS, SUGGESTION_KIND_LABELS } from '@materia/domain';
import {
  MtButton,
  MtCheckbox,
  MtNote,
  MtSelect,
  MtTextarea,
  MtTextField,
  ToastService,
  type CitationOpenEvent,
} from '@materia/ui';
import { MtSuggestion } from '@materia/ui/suggestion';

import {
  draftFrom,
  editFields,
  payloadFrom,
  staleLines,
  suggestionVm,
  type Draft,
  type EditField,
  type SuggestionRecord,
} from './suggestion-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { CitationSources } from '../citations/citation-sources';
import { RECORD_TABS } from '../citations/citation-view';

/** What the card is showing below the suggestion. */
type Mode = 'view' | 'edit' | 'dismiss' | 'review';

/** What happened to a suggestion, for the list (announcements, bulk state). */
export interface SuggestionResolved {
  id: string;
  outcome: 'accepted' | 'edited' | 'dismissed';
}

const OTHER = 'Other';

/**
 * A Clerk suggestion with its actions (AI-07): the `mt-suggestion` card (kind, summary, rationale,
 * citations), Accept, Edit (an inline editor validated by the kind's payload schema, with the
 * server's field errors shown on the fields) and Dismiss with a reason. A refused accept because its
 * sources changed (SUGGESTION_STALE), or a suggestion already marked stale, shows what changed and
 * asks to accept again against the current data. Accepting and dismissing go through the
 * `suggestions-*` callables; the card leaves the list when the suggestion's status changes.
 *
 * Reusable outside the matter Overview: give it the suggestion, its matter and what the person may do.
 * Where the screen provides `CitationSources` (AI-05), its citations are labelled with the documents'
 * names and open in the citation viewer; otherwise a citation opens the document's page.
 */
@Component({
  selector: 'mt-suggestion-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, MtButton, MtCheckbox, MtNote, MtSelect, MtSuggestion, MtTextarea, MtTextField],
  host: { class: 'mt-suggestion-card' },
  template: `
    <mt-suggestion
      [suggestion]="vm()"
      [stale]="stale()"
      [busy]="saving() || busy()"
      [canAccept]="actionable() && canAccept()"
      [canDismiss]="actionable() && canDismiss()"
      [attr.data-suggestion]="item().id"
      (accept)="accept()"
      (edit)="stale() ? review() : startEdit()"
      (dismiss)="startDismiss()"
      (citationOpen)="openCitation($event)"
    >
      @if (expired()) {
        <p class="caption t-3 state">Expired: Clerk suggested this more than two weeks ago.</p>
      }
      @switch (mode()) {
        @case ('edit') {
          <form
            class="mt-col editor"
            [attr.aria-label]="'Edit ' + kindLabel()"
            (submit)="$event.preventDefault(); acceptEdited()"
          >
            @for (field of fields(); track field.key) {
              @switch (field.type) {
                @case ('select') {
                  <mt-select
                    [name]="field.key"
                    [label]="field.label"
                    [native]="true"
                    [options]="field.options ?? []"
                    [error]="errorOf(field)"
                    [ngModel]="text(field)"
                    (ngModelChange)="set(field, $event)"
                  />
                }
                @case ('checkbox') {
                  <mt-checkbox
                    [name]="field.key"
                    [label]="field.label"
                    [ngModel]="draft()[field.key] === true"
                    (ngModelChange)="set(field, $event)"
                  />
                }
                @case ('textarea') {
                  <mt-textarea
                    [name]="field.key"
                    [label]="field.label"
                    [optional]="!!field.optional"
                    [error]="errorOf(field)"
                    [ngModel]="text(field)"
                    (ngModelChange)="set(field, $event ?? '')"
                  />
                }
                @default {
                  <mt-text-field
                    [name]="field.key"
                    [label]="field.label"
                    [optional]="!!field.optional"
                    [placeholder]="placeholder(field)"
                    [inputmode]="field.type === 'money' || field.type === 'number' ? 'decimal' : ''"
                    [error]="errorOf(field)"
                    [ngModel]="text(field)"
                    (ngModelChange)="set(field, $event ?? '')"
                  />
                }
              }
            }
            @if (formError(); as message) {
              <mt-note tone="danger">{{ message }}</mt-note>
            }
            <span class="mt-row actions">
              <button mtButton type="button" variant="ghost" size="sm" (click)="cancel()">Cancel</button>
              <button mtButton type="submit" variant="clerk" size="sm" [loading]="saving()">Accept edited</button>
            </span>
          </form>
        }
        @case ('dismiss') {
          <form class="mt-col editor" aria-label="Dismiss suggestion" (submit)="$event.preventDefault(); dismiss()">
            <mt-select
              name="reason"
              label="Why dismiss it?"
              [native]="true"
              [options]="reasons"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event)"
            />
            @if (reason() === other) {
              <mt-text-field
                name="otherReason"
                label="Reason"
                [optional]="true"
                [ngModel]="otherReason()"
                (ngModelChange)="otherReason.set($event ?? '')"
              />
            }
            <span class="mt-row actions">
              <button mtButton type="button" variant="ghost" size="sm" (click)="cancel()">Cancel</button>
              <button mtButton type="submit" variant="secondary" size="sm" [loading]="saving()">Dismiss</button>
            </span>
          </form>
        }
        @case ('review') {
          <div class="mt-col editor" role="group" aria-label="What changed">
            <p class="caption t-2">Since Clerk suggested this, these changed:</p>
            <ul class="changes">
              @for (line of changes(); track line) {
                <li>{{ line }}</li>
              } @empty {
                <li>The matter or a cited document.</li>
              }
            </ul>
            <span class="mt-row actions">
              <button mtButton type="button" variant="ghost" size="sm" (click)="cancel()">Cancel</button>
              @if (fields().length) {
                <button mtButton type="button" variant="ghost" size="sm" (click)="startEdit()">Edit</button>
              }
              <button mtButton type="button" variant="clerk" size="sm" [loading]="saving()" (click)="acceptAnyway()">
                Accept anyway
              </button>
            </span>
          </div>
        }
      }
    </mt-suggestion>
  `,
  styles: `
    .mt-suggestion-card .editor {
      gap: var(--space-12);
      padding-top: var(--space-8);
    }
    .mt-suggestion-card .actions {
      justify-content: flex-end;
      gap: var(--space-8);
    }
    .mt-suggestion-card .state {
      margin: var(--space-4) 0 0;
    }
    .mt-suggestion-card .changes {
      margin: 0;
      padding-left: var(--space-20);
      font: 400 13px/18px var(--font-sans);
    }
  `,
})
export class SuggestionCard {
  readonly item = input.required<SuggestionRecord>();
  readonly matterId = input.required<string>();
  /** The person may accept (and edit) it: clerk.use and the kind's underlying action. */
  readonly canAccept = input(true, { transform: booleanAttribute });
  readonly canDismiss = input(true, { transform: booleanAttribute });
  /** Past its expiry: shown read-only. */
  readonly expired = input(false, { transform: booleanAttribute });
  /** A bulk accept that includes it is running. */
  readonly busy = input(false, { transform: booleanAttribute });
  /** Overrides the callables (tests, other screens); the app's otherwise. */
  readonly api = input<SuggestionCallables | null>(null);

  readonly resolved = output<SuggestionResolved>();

  private readonly defaultApi = suggestionCallables(inject(CALLABLES));
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  /** The screen's cited documents and citation viewer (AI-05), where it provides them. */
  private readonly sources = inject(CitationSources, { optional: true });

  protected readonly vm = computed(() => {
    const vm = suggestionVm(this.item());
    return this.sources ? { ...vm, citations: this.sources.vms(this.item().citations) } : vm;
  });
  protected readonly kindLabel = computed(() => SUGGESTION_KIND_LABELS[this.item().kind].toLowerCase());
  protected readonly fields = computed(() => editFields(this.item()));
  protected readonly actionable = computed(
    () => !this.expired() && (this.item().status === 'proposed' || this.item().status === 'stale'),
  );
  protected readonly mode = signal<Mode>('view');
  protected readonly saving = signal(false);
  protected readonly draft = signal<Draft>({});
  protected readonly errors = signal<Record<string, string[]>>({});
  /** The basis to accept against after a re-review, and the changed sources' keys. */
  private readonly staleInfo = signal<{ basis?: string; keys: string[] } | null>(null);
  protected readonly stale = computed(() => this.item().status === 'stale' || !!this.staleInfo());
  protected readonly changes = computed(() =>
    staleLines(this.staleInfo()?.keys ?? this.item().staleReview?.changed ?? []),
  );
  /** Errors not on a shown field (the payload as a whole). */
  protected readonly formError = computed(() => {
    const shown = new Set(this.fields().map((field) => field.key));
    const rest = Object.entries(this.errors())
      .filter(([key]) => !shown.has(key))
      .flatMap(([, messages]) => messages);
    return rest.length ? rest.join(' ') : null;
  });

  protected readonly other = OTHER;
  protected readonly reasons = [...SUGGESTION_DISMISS_REASONS, OTHER].map((value) => ({ value, label: value }));
  protected readonly reason = signal<string>(SUGGESTION_DISMISS_REASONS[0]);
  protected readonly otherReason = signal('');

  constructor() {
    effect(() => this.sources?.want(this.item().citations));
  }

  private get callables(): SuggestionCallables {
    return this.api() ?? this.defaultApi;
  }

  protected text(field: EditField): string {
    const value = this.draft()[field.key];
    return typeof value === 'string' ? value : '';
  }

  protected set(field: EditField, value: string | boolean): void {
    this.draft.update((draft) => ({ ...draft, [field.key]: value }));
    if (this.errors()[field.key])
      this.errors.update((errors) => Object.fromEntries(Object.entries(errors).filter(([key]) => key !== field.key)));
  }

  protected errorOf(field: EditField): string | undefined {
    return this.errors()[field.key]?.join(' ') || undefined;
  }

  protected placeholder(field: EditField): string {
    return field.type === 'date' ? 'DD/MM/YYYY' : field.type === 'money' ? '0.00' : '';
  }

  protected startEdit(): void {
    this.draft.set(draftFrom(this.item()));
    this.errors.set({});
    this.mode.set('edit');
  }

  protected startDismiss(): void {
    this.reason.set(SUGGESTION_DISMISS_REASONS[0]);
    this.otherReason.set('');
    this.mode.set('dismiss');
  }

  protected review(): void {
    this.mode.set('review');
  }

  protected cancel(): void {
    this.errors.set({});
    this.mode.set('view');
  }

  protected accept(): Promise<void> {
    return this.run({});
  }

  /** Accepts against the current data, after the person has seen what changed. */
  protected acceptAnyway(): Promise<void> {
    const basis = this.staleInfo()?.basis ?? this.item().staleReview?.basis;
    return this.run(basis ? { expectedBasis: basis } : {});
  }

  protected acceptEdited(): Promise<void> {
    const result = payloadFrom(this.item(), this.draft());
    if ('errors' in result) {
      this.errors.set(result.errors);
      return Promise.resolve();
    }
    const basis = this.staleInfo()?.basis ?? this.item().staleReview?.basis;
    return this.run({ editedPayload: result.payload, ...(this.stale() && basis ? { expectedBasis: basis } : {}) });
  }

  protected async dismiss(): Promise<void> {
    if (this.saving()) return;
    const reason = this.reason() === OTHER ? this.otherReason().trim() : this.reason();
    this.saving.set(true);
    try {
      await this.callables.dismiss({
        matterId: this.matterId(),
        suggestionId: this.item().id,
        ...(reason ? { reason } : {}),
      });
      this.mode.set('view');
      this.resolved.emit({ id: this.item().id, outcome: 'dismissed' });
    } catch (error) {
      this.toasts.show({ title: 'The suggestion wasn’t dismissed', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }

  private async run(extra: { editedPayload?: Record<string, unknown>; expectedBasis?: string }): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const result = await this.callables.accept({
        matterId: this.matterId(),
        suggestionId: this.item().id,
        ...extra,
      });
      this.mode.set('view');
      this.staleInfo.set(null);
      this.toasts.show({
        title: result.status === 'edited' ? 'Accepted with your changes' : 'Suggestion accepted',
        description: this.vm().title,
        tone: 'success',
      });
      this.resolved.emit({ id: this.item().id, outcome: result.status });
    } catch (error) {
      const stale = suggestionStaleOf(error);
      const fields = suggestionFieldErrorsOf(error);
      if (stale) {
        this.staleInfo.set({ basis: stale.basis, keys: stale.changed.map((change) => change.key) });
        this.mode.set('review');
      } else if (fields && this.mode() === 'edit') {
        this.errors.set(fields);
      } else {
        this.toasts.show({ title: 'The suggestion wasn’t accepted', description: errorCopy(error), tone: 'danger' });
      }
    } finally {
      this.saving.set(false);
    }
  }

  /** Opens the citation viewer at the source (AI-05), or the document's page where there is no viewer. */
  protected openCitation(event: CitationOpenEvent): void {
    // A record citation (a deadline, a time entry…) opens the matter tab that lists it. Routes are
    // absolute, so the card works off the matter too (the Inbox, CORE-22a).
    const stored = event.n ? this.item().citations[event.n - 1] : undefined;
    if (stored?.kind === 'record' && stored.recordRef) {
      void this.router.navigate(['/matters', this.matterId(), RECORD_TABS[stored.recordRef.collection]]);
      return;
    }
    if (this.sources) return this.sources.open(this.item().citations, event.n);
    void this.router.navigate(['/matters', this.matterId(), 'documents', event.documentId], {
      queryParams: { ...(event.page ? { page: event.page } : {}), ...(event.version ? { v: event.version } : {}) },
    });
  }
}
