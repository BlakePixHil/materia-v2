import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  InjectionToken,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  contactsRepository,
  createMatterFromIntake,
  IntakeDrafts,
  intakeDraftKey,
  intakeDraftsRepository,
  type IntakeDraftItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  decodeIntakeDraftState,
  DomainError,
  INTAKE_STEPS,
  intakeToCreateMatterInput,
  MatterTypeSchema,
  type IntakeStepId,
} from '@materia/domain';
import {
  DialogService,
  formatRelativeDate,
  MATTER_TYPE_LABELS,
  MT_TODAY,
  MtButton,
  MtNote,
  MtStepList,
  MtTooltip,
  type StepVm,
} from '@materia/ui';

import { IntakeClientsStep } from './intake-clients-step';
import { IntakeConflictStep } from './intake-conflict-step';
import { IntakeDetailsStep } from './intake-details-step';
import { IntakeFeesStep } from './intake-fees-step';
import { IntakePartiesStep } from './intake-parties-step';
import { IntakeReviewStep } from './intake-review-step';
import {
  buildIntakeForm,
  INTAKE_STEP_LIST,
  INTAKE_STEP_TITLES,
  intakeContact,
  intakeStateJson,
  restoreIntakeState,
  suggestedParties,
} from './intake-state';
import { IntakeStore } from './intake-store';
import { IntakeTypeStep } from './intake-type-step';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';

/** How long after the last change the draft is saved (tests shorten it). */
export const INTAKE_AUTOSAVE_MS = new InjectionToken<number>('INTAKE_AUTOSAVE_MS', {
  providedIn: 'root',
  factory: () => 800,
});

type Phase = 'loading' | 'resume' | 'form';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Why `matters-createMatter` refused, in words (the fields it named, else the code's copy). */
export function createErrorCopy(error: unknown): string {
  const details = error instanceof DomainError ? error.details : undefined;
  const fields = details?.['fields'];
  if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && fields && typeof fields === 'object') {
    const messages = Object.values(fields as Record<string, unknown>).flatMap((value) =>
      Array.isArray(value) ? value.map(String) : [],
    );
    if (messages.length) return `${messages.join('. ')}.`;
  }
  if (details?.['reason'] === 'conflict_determine_required') {
    return 'Only a lawyer can record a conflict determination. Choose “Decide later” to create a lead.';
  }
  return errorCopy(error);
}

/**
 * New matter (`/matters/new`, CORE-05): a seven-step intake in a StepList. Each step validates
 * with the shared zod step schemas (inline errors; Next is blocked on an invalid step) and any
 * completed step can be reopened from the list. The form saves itself as a draft
 * (`users/{uid}/drafts/intake-{id}`) a moment after each change; the next visit offers to resume
 * the latest draft. Create sends `matters-createMatter` (`intakeToCreateMatterInput`) with one
 * request id for every retry, deletes the draft and opens the matter.
 *
 * Keyboard: Enter goes to the next step (not in multi-line fields or on buttons), Esc asks before
 * closing, and every control is reachable with Tab.
 */
@Component({
  selector: 'mt-intake-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [IntakeStore],
  imports: [
    MtButton,
    MtNote,
    MtStepList,
    MtTooltip,
    IntakeClientsStep,
    IntakeConflictStep,
    IntakeDetailsStep,
    IntakeFeesStep,
    IntakePartiesStep,
    IntakeReviewStep,
    IntakeTypeStep,
  ],
  host: { class: 'mt-intake', '(keydown)': 'onKeydown($event)' },
  template: `
    <header class="head">
      <h1 class="title-l">New matter</h1>
      <span class="caption t-3 save" role="status" aria-live="polite" data-testid="draft-status">{{ saveText() }}</span>
      <button
        mtButton
        class="mt-ml"
        variant="secondary"
        size="sm"
        iconStart="sparkle"
        type="button"
        [disabled]="!prefillOn()"
        [mtTooltip]="prefillOn() ? 'Clerk reads an email or notes and fills in what it can' : 'Coming soon'"
        (click)="prefill()"
      >
        Prefill from email or notes
      </button>
    </header>

    @if (!canCreate()) {
      <mt-note>Your role can’t create matters. Ask a lawyer or paralegal.</mt-note>
    } @else {
      @switch (phase()) {
        @case ('loading') {
          <p class="caption t-3" role="status">Loading…</p>
        }
        @case ('resume') {
          @if (offered(); as draft) {
            <section class="card resume" aria-labelledby="intake-resume-h" data-testid="intake-resume">
              <h2 id="intake-resume-h" class="heading">Pick up where you left off?</h2>
              <p>{{ resumeText(draft) }}</p>
              <div class="mt-row" style="gap: var(--space-8)">
                <button mtButton variant="primary" type="button" (click)="resume()">Resume draft</button>
                <button mtButton variant="ghost" type="button" (click)="startFresh()">Start fresh</button>
              </div>
              <p class="caption t-3">Starting fresh deletes the draft.</p>
            </section>
          }
        }
        @default {
          <div class="layout">
            <nav class="steps" aria-label="New matter steps">
              <mt-step-list
                label="New matter steps"
                [steps]="steps"
                [current]="store.step()"
                [completed]="completed()"
                [interactive]="true"
                (stepSelect)="jump($any($event.id))"
              />
            </nav>
            <section class="panel" aria-labelledby="intake-step-h">
              <h2 id="intake-step-h" class="title-m step-h" tabindex="-1" #stepHeading>
                <span class="caption t-3">Step {{ store.stepIndex() + 1 }} of {{ steps.length }}</span>
                {{ title() }}
              </h2>
              <div class="body">
                @switch (store.step()) {
                  @case ('type') {
                    <mt-intake-type-step />
                  }
                  @case ('clients') {
                    <mt-intake-clients-step />
                  }
                  @case ('details') {
                    <mt-intake-details-step />
                  }
                  @case ('parties') {
                    <mt-intake-parties-step />
                  }
                  @case ('fees') {
                    <mt-intake-fees-step />
                  }
                  @case ('conflict') {
                    <mt-intake-conflict-step (discard)="discard()" />
                  }
                  @case ('review') {
                    <mt-intake-review-step (jump)="jump($event)" />
                  }
                }
              </div>
              @if (blocked()) {
                <mt-note tone="danger" role="alert">Fix the highlighted fields to continue.</mt-note>
              }
              @if (createError(); as message) {
                <mt-note tone="danger" role="alert" data-testid="create-error">{{ message }}</mt-note>
              }
              @if (creating()) {
                <p class="caption t-2" role="status">Creating the matter…</p>
              }
              <footer class="actions">
                <button mtButton variant="ghost" type="button" (click)="close()">Cancel</button>
                <span class="mt-grow"></span>
                @if (store.stepIndex() > 0) {
                  <button mtButton variant="secondary" type="button" iconStart="chevron-left" (click)="back()">
                    Back
                  </button>
                }
                @if (store.step() === 'review') {
                  <button mtButton variant="primary" type="button" [loading]="creating()" (click)="create()">
                    {{ createError() ? 'Try again' : 'Create matter' }}
                  </button>
                } @else {
                  <!-- No Enter key cap here: on a primary button it misses AA contrast (axe). -->
                  <button mtButton variant="primary" type="button" iconEnd="chevron-right" (click)="next()">
                    Next
                  </button>
                }
              </footer>
            </section>
          </div>
        }
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
    .head {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-12);
    }
    .head h1 {
      margin: 0;
    }
    .layout {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: var(--space-24);
      align-items: start;
    }
    .steps {
      position: sticky;
      top: var(--space-16);
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      min-width: 0;
      max-width: 880px;
    }
    .step-h {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin: 0;
      outline: none;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding-top: var(--space-16);
      border-top: 1px solid var(--border-subtle);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      max-width: 560px;
      padding: var(--space-20);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
    }
    .card h2,
    .card p {
      margin: 0;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
      .steps {
        position: static;
      }
    }
  `,
})
export class IntakePage {
  protected readonly store = inject(IntakeStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly dialogs = inject(DialogService);
  private readonly callables = inject(CALLABLES);
  private readonly context = inject(OrgContext);
  private readonly flags = inject(FeatureFlagService);
  private readonly today = inject(MT_TODAY);
  private readonly document = inject(DOCUMENT);
  private readonly autosaveMs = inject(INTAKE_AUTOSAVE_MS);
  private readonly contacts = contactsRepository();
  private readonly drafts = new IntakeDrafts(intakeDraftsRepository(), () => this.context.requireOrgId());
  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  protected readonly canCreate = can('matter.create');
  protected readonly prefillOn = computed(() => this.flags.isOn('clerk.features.intakePrefill'));
  protected readonly steps: readonly StepVm[] = INTAKE_STEP_LIST;
  protected readonly phase = signal<Phase>('loading');
  protected readonly offered = signal<WithId<IntakeDraftItem> | null>(null);
  protected readonly saveState = signal<SaveState>('idle');
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  /** Next was pressed on an invalid step. */
  protected readonly blocked = signal(false);

  protected readonly title = computed(() => INTAKE_STEP_TITLES[this.store.step()]);
  /** Steps reached before and still valid: ticked, and reopenable from the list. */
  protected readonly completed = computed(() => {
    const reached = this.store.state().reached;
    const current = this.store.step();
    return INTAKE_STEPS.filter((step, i) => i <= reached && step !== current && this.store.valid(step));
  });
  protected readonly saveText = computed(() => {
    switch (this.saveState()) {
      case 'saving':
        return 'Saving draft…';
      case 'saved':
        return 'Draft saved';
      case 'error':
        return 'Couldn’t save the draft';
      default:
        return '';
    }
  });

  /** The draft's id: a new one per intake, or the resumed draft's. */
  private draftKey: string = crypto.randomUUID();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private lastSaved = '';
  /** Created or discarded: nothing more is saved. */
  private finished = false;
  private confirming = false;

  constructor() {
    // Offer the latest draft once the session's org is known.
    let started = false;
    effect(() => {
      if (started || !this.context.orgId() || !this.context.uid()) return;
      started = true;
      untracked(() => void this.load());
    });

    // Autosave: a moment after the last change, once a type is chosen.
    effect(() => {
      const state = this.store.state();
      const step = this.store.step();
      if (this.phase() !== 'form' || !state.type) return;
      untracked(() => this.schedule(JSON.stringify({ step, state })));
    });

    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      // Leaving mid-flow keeps the draft: save what's pending now.
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        void this.save();
      }
    });

    // Esc when focus is outside the page (on the body): the page's own handler covers the rest.
    const release = inject(ShortcutService).register({
      combo: 'esc',
      description: 'Close the new matter',
      group: 'New matter',
      scope: 'route',
      when: () => this.phase() === 'form' && !this.dialogOpen(),
      handler: () => void this.close(),
    });
    destroyRef.onDestroy(release);
  }

  // ---------- drafts ----------

  private async load(): Promise<void> {
    try {
      const draft = await this.drafts.latest();
      if (draft) {
        this.offered.set(draft);
        this.phase.set('resume');
        return;
      }
    } catch {
      // No draft to offer (offline, say): start fresh.
    }
    await this.startWithParams();
  }

  protected resumeText(draft: WithId<IntakeDraftItem>): string {
    const state = decodeIntakeDraftState(draft.stateJson);
    const type = MatterTypeSchema.safeParse(state['type']);
    const what = type.success ? `a ${MATTER_TYPE_LABELS[type.data].toLowerCase()} matter` : 'a new matter';
    const relative = draft.updatedAt ? formatRelativeDate(draft.updatedAt, this.today()) : '';
    const when = /^(Today|Yesterday)$/.test(relative)
      ? relative.toLowerCase()
      : /^\d+ days ago$/.test(relative)
        ? relative
        : relative
          ? `on ${relative}`
          : '';
    return `You started ${what}${when ? `, last saved ${when}` : ''}. It was at “${INTAKE_STEP_TITLES[draft.step]}”.`;
  }

  protected resume(): void {
    const draft = this.offered();
    if (!draft) return;
    this.draftKey = intakeDraftKey(draft.id);
    const state = restoreIntakeState(decodeIntakeDraftState(draft.stateJson));
    this.store.reset(state, draft.step);
    this.lastSaved = JSON.stringify({ step: draft.step, state });
    this.offered.set(null);
    this.phase.set('form');
    this.focusStep();
  }

  protected async startFresh(): Promise<void> {
    const draft = this.offered();
    this.offered.set(null);
    if (draft) await this.drafts.remove(intakeDraftKey(draft.id)).catch(() => undefined);
    await this.startWithParams();
  }

  /** A new form, prefilled from `?type=probate&deceased=<contactId>` (the contact screen's link). */
  private async startWithParams(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const type = MatterTypeSchema.safeParse(params.get('type'));
    const deceasedId = params.get('deceased');
    this.store.reset();
    if (type.success) this.store.update((s) => ({ ...s, type: type.data }));
    if (deceasedId) {
      const contact = await this.contacts.get(deceasedId).catch(() => null);
      if (contact) {
        const summary = intakeContact(contact);
        this.store.remember(deceasedId, summary);
        const died = summary.dateOfDeath?.split('-').reverse().join('/') ?? '';
        this.store.details({ deceasedContactId: deceasedId, dateOfDeath: died });
      }
    }
    this.phase.set('form');
  }

  private schedule(snapshot: string): void {
    if (this.finished || snapshot === this.lastSaved) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.save();
    }, this.autosaveMs);
  }

  private save(): Promise<void> {
    if (this.finished) return this.saving;
    const step = this.store.step();
    const state = this.store.state();
    const snapshot = JSON.stringify({ step, state });
    if (snapshot === this.lastSaved || !state.type) return this.saving;
    this.saveState.set('saving');
    this.saving = this.saving
      .then(() => this.drafts.save(this.draftKey, step, intakeStateJson(state)))
      .then(
        () => {
          this.lastSaved = snapshot;
          this.saveState.set('saved');
        },
        () => this.saveState.set('error'),
      );
    return this.saving;
  }

  /** Stops saving and deletes the draft (after a create, or when discarding). */
  private async finish(): Promise<void> {
    this.finished = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.saving;
    await this.drafts.remove(this.draftKey).catch(() => undefined);
  }

  // ---------- steps ----------

  protected next(): void {
    const step = this.store.step();
    this.store.showErrors(step);
    if (!this.store.valid(step)) {
      this.blocked.set(true);
      queueMicrotask(() => this.focusFirstError());
      return;
    }
    const index = this.store.stepIndex();
    const nextStep = INTAKE_STEPS[index + 1];
    if (!nextStep) return;
    this.store.update((s) => ({ ...s, reached: Math.max(s.reached, index + 1) }));
    this.go(nextStep);
  }

  protected back(): void {
    const previous = INTAKE_STEPS[this.store.stepIndex() - 1];
    if (previous) this.go(previous);
  }

  /** Reopens a completed step (or one before the current step). */
  protected jump(step: IntakeStepId): void {
    const index = INTAKE_STEPS.indexOf(step);
    if (index < this.store.stepIndex() || this.completed().includes(step)) this.go(step);
  }

  private go(step: IntakeStepId): void {
    this.blocked.set(false);
    if (step === 'parties') this.prefillParties();
    this.store.step.set(step);
    if (INTAKE_STEPS.indexOf(step) <= this.store.state().reached) this.store.showErrors(step);
    this.focusStep();
  }

  /** A grant's clients start as its executors or administrators (once per type). */
  private prefillParties(): void {
    const state = this.store.state();
    if (state.partiesPrefilledFor === state.type) return;
    const suggested = suggestedParties(state);
    this.store.update((s) => ({
      ...s,
      partiesPrefilledFor: s.type,
      parties: s.parties.length ? s.parties : suggested,
    }));
  }

  private focusStep(): void {
    setTimeout(() => this.stepHeading()?.nativeElement.focus());
  }

  private focusFirstError(): void {
    const panel = this.stepHeading()?.nativeElement.closest('.panel');
    const invalid = panel?.querySelector<HTMLElement>('[aria-invalid="true"], .mt-error');
    if (invalid?.matches('input, select, textarea, button')) invalid.focus();
    else invalid?.scrollIntoView?.({ block: 'center' });
  }

  // ---------- create, close, discard ----------

  /** `matters-createMatter`; a retry after a failure sends the same request id. */
  protected async create(): Promise<void> {
    if (this.creating()) return;
    const invalid = INTAKE_STEPS.find((step) => !this.store.valid(step));
    if (invalid) {
      INTAKE_STEPS.forEach((step) => this.store.showErrors(step));
      this.go(invalid);
      this.blocked.set(true);
      return;
    }
    let requestId = this.store.state().requestId;
    if (!requestId) {
      requestId = crypto.randomUUID();
      const id = requestId;
      this.store.update((s) => ({ ...s, requestId: id }));
    }
    this.creating.set(true);
    this.createError.set(null);
    try {
      const input = intakeToCreateMatterInput(buildIntakeForm(this.store.state(), this.today()), requestId);
      const result = await createMatterFromIntake(this.callables, input);
      await this.finish();
      await this.router.navigate(['/matters', result.matterId]);
    } catch (error) {
      this.createError.set(createErrorCopy(error));
    } finally {
      this.creating.set(false);
    }
  }

  /** Asks, then leaves; the draft stays for next time. */
  protected async close(): Promise<void> {
    if (this.confirming) return;
    this.confirming = true;
    try {
      const leave = await this.dialogs.confirm({
        title: 'Close the new matter?',
        body: 'Your draft is saved. You can pick it up next time you start a new matter.',
        confirmLabel: 'Close new matter',
        cancelLabel: 'Keep going',
      });
      if (!leave) return;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.save();
      }
      await this.router.navigateByUrl('/matters');
    } finally {
      this.confirming = false;
    }
  }

  /** Deletes the draft and leaves (a conflict, say). */
  protected async discard(): Promise<void> {
    const sure = await this.dialogs.confirm({
      title: 'Discard this intake?',
      body: 'The draft is deleted and no matter is created.',
      confirmLabel: 'Discard intake',
      tone: 'danger',
    });
    if (!sure) return;
    await this.finish();
    await this.router.navigateByUrl('/matters');
  }

  protected prefill(): void {
    // AI prefill arrives with Clerk's intake feature; the flag keeps the button disabled until then.
  }

  // ---------- keyboard ----------

  /** Enter: next step (not in multi-line fields, on buttons or links, or in a contact search). Esc: close. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || this.phase() !== 'form') return;
    if (event.key === 'Escape') {
      if (this.dialogOpen()) return;
      event.preventDefault();
      void this.close();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      target?.closest(
        'textarea, button, a, select, [contenteditable="true"], [role="listbox"], [role="option"], [data-intake-enter="off"]',
      )
    ) {
      return;
    }
    if (this.store.step() === 'review') return;
    event.preventDefault();
    this.next();
  }

  private dialogOpen(): boolean {
    return !!this.document.querySelector('.mt-dialog');
  }
}
