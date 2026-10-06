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
import { Router } from '@angular/router';

import {
  deadlineCallables,
  factCitationsQuery,
  matterEventRepository,
  matterFactCitationsRepository,
} from '@materia/data-access/repository';
import {
  EVENT_KEY_FACTS,
  keyFactCitations,
  keyFactEditable,
  keyFactPatch,
  keyFactsFor,
  keyFactValue,
  type CitationInput,
  type DateOnly,
  type EventKind,
  type KeyFactDefinition,
  type KeyFactId,
} from '@materia/domain';
import {
  MtButton,
  MtCitation,
  MtFactCitation,
  MtFactEditor,
  MtKeyFacts,
  MtTextField,
  shownCitations,
  ToastService,
  type CitationVm,
  type KeyFactVm,
} from '@materia/ui';

import { MatterScreen } from './matter-screen';
import { KEY_FACT_PLACEHOLDERS, keyFactInput, keyFactText, parseKeyFactInput, type MatterRecord } from './matter-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { CitationSources } from '../citations/citation-sources';
import { deadlineErrorCopy, recomputeSummaryText } from '../deadlines/deadline-view';

/** Why the date of death can't be recorded yet. */
export const NO_DECEASED_HINT = 'Add the deceased on the Parties tab before recording the date of death';

/** Key facts that stand for a matter event (date of death, grant date): edited through the event. */
const FACT_EVENTS = new Map(
  Object.entries(EVENT_KEY_FACTS).map(([kind, fact]) => [fact as KeyFactId, kind as EventKind] as const),
);

/** A key fact's source chip, and its citation's number in the fact's list (for the viewer). */
interface FactChip {
  vm: CitationVm;
  n: number;
}

/**
 * The matter's key facts (CORE-06): the facts its type shows (`keyFactsFor`), each edited inline.
 * A save writes `keyFactPatch` through the matters repository, so two people editing at once means
 * the last write wins; the header says when someone else just changed the matter. The date of
 * death and the grant date are matter events (CORE-10): they're recorded through
 * `deadlines-upsertEvent`, which recomputes the deadlines and proposes any date in force that
 * would move; a toast says so and links to the Deadlines tab.
 *
 * A value accepted from a Clerk suggestion shows where Clerk found it (CORE-06a, ADR-049): a chip
 * per cited source ("Will … p 2", or "Restricted source" for a reader who can't see it) that opens
 * the Overview's citation viewer at the page with the quote highlighted. The chips stay while the
 * fact keeps that value; an edit drops them at once (the server then deletes the record).
 */
@Component({
  selector: 'mt-matter-key-facts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCitation, MtFactCitation, MtFactEditor, MtKeyFacts, MtTextField],
  template: `
    <mt-key-facts [facts]="facts()" [editing]="screen.editingFact()" (edit)="edit($event.id)">
      <ng-template mtFactCitation let-fact>
        @for (chip of chips().get(fact.id) ?? []; track chip.n) {
          <mt-citation [citation]="chip.vm" (open)="openCitation(fact.id, chip.n)" />
        }
      </ng-template>
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
  private readonly router = inject(Router);
  private readonly deadlines = deadlineCallables(inject(CALLABLES));
  private readonly events = matterEventRepository(this.screen.id);
  private readonly sources = inject(CitationSources);
  private readonly citationRecords = matterFactCitationsRepository(this.screen.id).watchQuery(() =>
    this.screen.id() ? factCitationsQuery({ privilegedVisible: this.screen.canPrivileged() }) : null,
  );

  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  private readonly definitions = computed(() => {
    const type = this.screen.value()?.type;
    return type ? keyFactsFor(type) : [];
  });
  /** Each fact's citations, while the fact still has the value they were kept with. */
  private readonly cited = computed(() => {
    const matter = this.screen.value();
    const byFact = new Map<KeyFactId, CitationInput[]>();
    if (!matter) return byFact;
    for (const record of this.citationRecords.value()) {
      const citations = keyFactCitations(matter, record.factId, record);
      if (citations.length) byFact.set(record.factId, citations);
    }
    return byFact;
  });
  /** The chips each fact shows: its citations that passed verification (AI-05), unnumbered. */
  protected readonly chips = computed(() => {
    const chips = new Map<string, FactChip[]>();
    for (const [id, citations] of this.cited()) {
      const shown = shownCitations(this.sources.vms(citations)).map((vm) => ({
        vm: { ...vm, n: undefined },
        n: vm.n ?? 0,
      }));
      if (shown.length) chips.set(id, shown);
    }
    return chips;
  });
  protected readonly facts = computed<KeyFactVm[]>(() => {
    const matter = this.screen.value();
    if (!matter) return [];
    const editable = this.screen.editable();
    const chips = this.chips();
    return this.definitions().map((fact) => {
      const allowed = keyFactEditable(matter, fact.id);
      const first = chips.get(fact.id)?.[0];
      return {
        id: fact.id,
        label: fact.label,
        value: keyFactText(fact.kind, keyFactValue(matter, fact.id)),
        editable: editable && allowed,
        editBlockedReason: editable && !allowed ? NO_DECEASED_HINT : undefined,
        citation: first ? { label: first.vm.label } : undefined,
      };
    });
  });
  private readonly editing = computed(() => this.definitions().find((f) => f.id === this.screen.editingFact()));
  protected readonly placeholder = computed(() => KEY_FACT_PLACEHOLDERS[this.editing()?.kind ?? 'text']);

  constructor() {
    // The cited documents are read once each, for their names and whether the reader may open them.
    effect(() => {
      const cited = [...this.cited().values()].flat();
      untracked(() => this.sources.want(cited));
    });
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

  /** Opens the citation viewer at a fact's source, stepping through the fact's others. */
  protected openCitation(id: string, n: number): void {
    this.sources.open(this.cited().get(id as KeyFactId) ?? [], n);
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
      const kind = FACT_EVENTS.get(fact.id);
      if (!kind || !(await this.saveEvent(matter.id, fact.label, kind, parsed.value as DateOnly | undefined))) {
        await this.screen.repo.update(matter.id, patch);
      }
      this.cancel();
    } catch (error) {
      const description = FACT_EVENTS.has(fact.id) ? deadlineErrorCopy(error) : errorCopy(error);
      if (FACT_EVENTS.has(fact.id) && description !== errorCopy(error)) this.error.set(description);
      this.toasts.show({ title: `${fact.label} didn’t save`, description, tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Records the fact's event (or edits it, or deletes it when cleared), which sets the key fact and
   * recomputes the deadlines. False when there's nothing to go through (clearing a fact without an
   * event): the caller writes the patch.
   */
  private async saveEvent(matterId: string, label: string, kind: EventKind, date: DateOnly | undefined) {
    const [existing] = await this.events.query({ where: [['kind', '==', kind]], pageSize: 20 });
    if (!date) {
      if (!existing) return false;
      const result = await this.deadlines.deleteEvent({ matterId, eventId: existing.id });
      this.report(matterId, `${label} cleared`, recomputeSummaryText(result.recompute), result.recompute.proposed);
      return true;
    }
    const result = await this.deadlines.upsertEvent({
      matterId,
      kind,
      date,
      ...(existing ? { eventId: existing.id } : {}),
    });
    this.report(matterId, `${label} saved`, recomputeSummaryText(result.recompute), result.recompute.proposed);
    return true;
  }

  private report(matterId: string, title: string, changes: string, proposed: readonly string[]): void {
    this.toasts.show({
      title,
      ...(changes ? { description: `${changes}.` } : {}),
      tone: proposed.length ? 'neutral' : 'success',
      ...(proposed.length
        ? {
            duration: 10_000,
            action: {
              label: 'Review',
              run: () => void this.router.navigate(['/matters', matterId, 'deadlines']),
            },
          }
        : {}),
    });
  }
}
