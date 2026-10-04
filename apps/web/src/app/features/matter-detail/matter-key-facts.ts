import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  keyFactEditable,
  keyFactPatch,
  keyFactsFor,
  keyFactValue,
  type KeyFactDefinition,
  type KeyFactId,
} from '@materia/domain';
import { MtButton, MtFactEditor, MtKeyFacts, MtTextField, ToastService, type KeyFactVm } from '@materia/ui';

import { MatterScreen } from './matter-screen';
import { KEY_FACT_PLACEHOLDERS, keyFactInput, keyFactText, parseKeyFactInput, type MatterRecord } from './matter-view';
import { errorCopy } from '../../core/error-copy';

/** Why the date of death can't be recorded yet. */
export const NO_DECEASED_HINT = 'Add the deceased on the Parties tab before recording the date of death';

/**
 * Where Clerk found a key fact's value, for the Citation marker. A hook for now: Clerk-sourced
 * values (AI tickets) fill it from the accepted suggestion's citation.
 */
export type KeyFactCitationSource = (matter: MatterRecord, id: KeyFactId) => KeyFactVm['citation'];
export const keyFactCitation: KeyFactCitationSource = () => undefined;

/**
 * The matter's key facts (CORE-06): the facts its type shows (`keyFactsFor`), each edited inline.
 * A save writes `keyFactPatch` through the matters repository, so two people editing at once means
 * the last write wins; the header says when someone else just changed the matter.
 */
@Component({
  selector: 'mt-matter-key-facts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtFactEditor, MtKeyFacts, MtTextField],
  template: `
    <mt-key-facts [facts]="facts()" [editing]="screen.editingFact()" (edit)="edit($event.id)">
      <ng-template mtFactEditor let-fact>
        <form
          class="mt-row editor"
          (submit)="$event.preventDefault(); save()"
          (keydown.escape)="$event.stopPropagation(); cancel()"
        >
          <mt-text-field
            class="mt-grow"
            name="value"
            size="sm"
            [label]="fact.label"
            [placeholder]="placeholder()"
            [error]="error() ?? undefined"
            [ngModel]="draft()"
            (ngModelChange)="draft.set($event ?? ''); error.set(null)"
          />
          <button mtButton variant="primary" size="sm" type="submit" [loading]="saving()">Save</button>
          <button mtButton variant="ghost" size="sm" type="button" (click)="cancel()">Cancel</button>
        </form>
      </ng-template>
    </mt-key-facts>
  `,
  styles: `
    .editor {
      gap: var(--space-6);
      align-items: flex-start;
      width: 100%;
    }
  `,
})
export class MatterKeyFacts {
  protected readonly screen = inject(MatterScreen);
  private readonly toasts = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  private readonly definitions = computed(() => {
    const type = this.screen.value()?.type;
    return type ? keyFactsFor(type) : [];
  });
  protected readonly facts = computed<KeyFactVm[]>(() => {
    const matter = this.screen.value();
    if (!matter) return [];
    const editable = this.screen.editable();
    return this.definitions().map((fact) => {
      const allowed = keyFactEditable(matter, fact.id);
      return {
        id: fact.id,
        label: fact.label,
        value: keyFactText(fact.kind, keyFactValue(matter, fact.id)),
        editable: editable && allowed,
        editBlockedReason: editable && !allowed ? NO_DECEASED_HINT : undefined,
        citation: keyFactCitation(matter, fact.id),
      };
    });
  });
  private readonly editing = computed(() => this.definitions().find((f) => f.id === this.screen.editingFact()));
  protected readonly placeholder = computed(() => KEY_FACT_PLACEHOLDERS[this.editing()?.kind ?? 'text']);

  constructor() {
    // Opening an editor (its Edit button, or a stage requirement's quick action) starts from the
    // stored value and focuses the field.
    effect(() => {
      const fact = this.editing();
      const matter = untracked(() => this.screen.value());
      if (!fact || !matter) return;
      untracked(() => this.open(fact, matter));
    });
  }

  protected edit(id: string): void {
    this.screen.editingFact.set(id as KeyFactId);
  }

  private open(fact: KeyFactDefinition, matter: MatterRecord): void {
    if (!this.screen.editable() || !keyFactEditable(matter, fact.id)) {
      this.screen.editingFact.set(null);
      return;
    }
    this.draft.set(keyFactInput(fact.kind, keyFactValue(matter, fact.id)));
    this.error.set(null);
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLInputElement>('.editor input')?.focus(), {
      injector: this.injector,
    });
  }

  protected cancel(): void {
    this.screen.editingFact.set(null);
  }

  protected async save(): Promise<void> {
    const fact = this.editing();
    const matter = this.screen.value();
    if (!fact || !matter || this.saving()) return;
    const parsed = parseKeyFactInput(fact.kind, this.draft());
    if ('error' in parsed) {
      this.error.set(parsed.error);
      return;
    }
    const before = keyFactValue(matter, fact.id);
    if (parsed.value === before || (parsed.value === undefined && before === undefined)) {
      this.cancel();
      return;
    }
    let patch: ReturnType<typeof keyFactPatch>;
    try {
      patch = keyFactPatch(matter, fact.id, parsed.value);
    } catch {
      this.error.set(`The ${fact.label.toLowerCase()} can’t be cleared.`);
      return;
    }
    this.saving.set(true);
    try {
      await this.screen.repo.update(matter.id, patch);
      this.cancel();
    } catch (error) {
      this.toasts.show({ title: `${fact.label} didn’t save`, description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
