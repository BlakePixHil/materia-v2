import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { can } from '@materia/data-access';
import { clerkDraftCallables, clerkDraftRepository } from '@materia/data-access/repository';
import {
  CLERK_DRAFT_REWRITE_MAX,
  clerkDraftType,
  draftPlaceholders,
  editProvenance,
  provenanceTotals,
  spliceProvenance,
  type CitationInput,
  type ProvenanceRun,
} from '@materia/domain';
import {
  DialogService,
  MtBadge,
  MtButton,
  MtCitation,
  MtNote,
  MtTextField,
  ToastService,
  type CitationOpenEvent,
} from '@materia/ui';

import {
  clerkUnavailable,
  draftEdited,
  draftErrorCopy,
  draftSegments,
  draftStatusLabel,
  rewriteContext,
  toConfirmText,
  type DraftDoc,
} from './clerk-draft-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { CitationScope, CitationSources } from '../citations/citation-sources';
import { CitationViewer } from '../citations/citation-viewer';
import { MANUAL_PATH } from '../clerk/clerk-chat-view';
import { MatterScreen } from '../matter-detail/matter-screen';

/** How long typing pauses before the draft is saved. */
const AUTOSAVE_MS = 800;

/**
 * A Clerk draft (`/matters/:id/drafts/:draftId`, AI-10, ADR-050), for the person who asked for it.
 * Clerk's letter streams in from the server (Stop ends it early); then it's a plain editor, with
 * each `[[TO CONFIRM: …]]` placeholder highlighted and listed beside it with the facts the matter
 * lacked and the sources Clerk drew on. Select a passage to have Clerk rewrite it; Redraft starts
 * the letter again (after asking, once it's edited). Every edit is saved to the draft as it's made,
 * with who wrote what (Clerk or the person), kept for audit and never printed. Save merges it into
 * the firm's letterhead and files it in the matter's documents as "Draft — not sent": nothing is
 * ever sent from here.
 */
@Component({
  selector: 'mt-clerk-draft-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/input.css'],
  imports: [CitationViewer, FormsModule, MtBadge, MtButton, MtCitation, MtNote, MtTextField, RouterLink],
  providers: [CitationSources, { provide: CitationScope, useExisting: MatterScreen }],
  host: { class: 'mt-clerk-draft' },
  template: `
    @if (draft(); as d) {
      <div class="head">
        <div class="mt-col title">
          <h2 class="title-m">{{ d.title }}</h2>
          <p class="body-s t-2" role="status">
            <mt-badge [tone]="d.status === 'error' ? 'danger' : 'neutral'">{{ statusLabel() }}</mt-badge>
            @if (typeTitle(); as t) {
              <span>{{ t }}</span>
            }
            @if (saving()) {
              <span class="t-3">Saving…</span>
            }
          </p>
        </div>
        <div class="actions">
          @if (d.status === 'drafting') {
            <button mtButton size="sm" iconStart="x" (click)="stop()">Stop</button>
          } @else {
            <button mtButton variant="ghost" size="sm" iconStart="refresh" [disabled]="busy()" (click)="redraft()">
              Redraft
            </button>
            <button mtButton variant="ghost" size="sm" iconStart="trash" [disabled]="busy()" (click)="discard()">
              Discard
            </button>
            <button
              mtButton
              variant="primary"
              size="sm"
              iconStart="document"
              [loading]="filing()"
              [disabled]="!canSave()"
              (click)="save()"
            >
              Save to documents
            </button>
          }
        </div>
      </div>

      @if (errorText(); as text) {
        <mt-note tone="danger">{{ text }} {{ unavailable() ? manualPath : '' }}</mt-note>
      }
      @if (d.truncated && d.status !== 'drafting') {
        <mt-note tone="warning">
          Clerk ran out of room before the end of the letter. Finish the last part yourself, or select it and ask Clerk
          to rewrite it.
        </mt-note>
      }

      <div class="layout">
        <div class="mt-col editor">
          <div class="mt-input frame" [attr.data-disabled]="locked() ? '' : null">
            <div class="layer" aria-hidden="true" #layer>
              @for (segment of segments(); track $index) {
                @if (segment.placeholder) {
                  <mark>{{ segment.text }}</mark>
                } @else {
                  {{ segment.text }}
                }
              }
            </div>
            <textarea
              #field
              class="field"
              aria-label="Letter"
              spellcheck="true"
              [readOnly]="locked()"
              [value]="body()"
              [attr.aria-busy]="d.status === 'drafting'"
              [attr.placeholder]="d.status === 'drafting' ? 'Clerk is reading the matter…' : null"
              (input)="edit()"
              (select)="track()"
              (keyup)="track()"
              (mouseup)="track()"
              (scroll)="syncScroll()"
            ></textarea>
          </div>
          @if (d.status !== 'drafting') {
            <form class="rewrite" (submit)="$event.preventDefault(); rewrite()">
              <mt-text-field
                name="rewrite"
                label="Rewrite the selected text"
                placeholder="Shorter, firmer, plainer… (optional)"
                [disabled]="!selected()"
                [ngModel]="rewriteAsk()"
                (ngModelChange)="rewriteAsk.set($event ?? '')"
              />
              <button
                mtButton
                size="sm"
                type="submit"
                iconStart="sparkle"
                [loading]="rewriting()"
                [disabled]="!selected()"
              >
                Rewrite
              </button>
            </form>
            <p class="caption t-3">{{ authorship() }}</p>
          }
        </div>

        <aside class="mt-col side" aria-label="Checking the draft">
          <section class="mt-col">
            <h3 class="label">{{ placeholders().length ? toConfirm() : 'Nothing marked to confirm' }}</h3>
            @for (item of placeholders(); track item.start) {
              <button type="button" class="confirm" (click)="selectRange(item.start, item.end)">
                {{ item.label }}
              </button>
            }
          </section>
          @if (d.missingFacts.length) {
            <section class="mt-col">
              <h3 class="label">Not on the matter</h3>
              <p class="caption t-3">Clerk had none of these when it drafted, so it left placeholders for them.</p>
              <ul>
                @for (fact of d.missingFacts; track fact) {
                  <li class="body-s">{{ fact }}</li>
                }
              </ul>
            </section>
          }
          <section class="mt-col">
            <h3 class="label">Sources</h3>
            @for (vm of citations(); track $index) {
              <mt-citation [citation]="vm" (open)="openCitation($event)" />
            } @empty {
              <p class="caption t-3">
                {{
                  d.status === 'drafting' ? 'Clerk lists its sources when it finishes.' : 'Clerk cited no documents.'
                }}
              </p>
            }
          </section>
          @if (d.documentIds.length) {
            <section class="mt-col">
              <h3 class="label">Saved</h3>
              @for (id of d.documentIds; track id) {
                <a class="body-s" [routerLink]="['/matters', matterId(), 'documents', id]"
                  >Saved letter {{ $index + 1 }}</a
                >
              }
            </section>
          }
          <p class="caption t-3">Clerk drafts; you check each fact before saving. Nothing is sent from here.</p>
        </aside>
      </div>

      @if (sources.viewing(); as viewing) {
        @defer (on immediate) {
          <mt-citation-viewer
            [matterId]="matterId() ?? ''"
            [citations]="viewing.citations"
            [index]="viewing.index"
            (indexChange)="sources.viewing.set({ citations: viewing.citations, index: $event })"
            (closed)="sources.close()"
          />
        } @loading (minimum 0ms) {
          <p class="caption t-3 mt-sr" role="status">Opening the source…</p>
        }
      }
    } @else if (doc.status() === 'loading') {
      <p class="caption t-3 pad" role="status">Opening the draft…</p>
    } @else {
      <div class="pad">
        <mt-note>This draft isn’t here: it was discarded, or it belongs to someone else.</mt-note>
        <a mtButton size="sm" [routerLink]="['/matters', matterId(), 'drafts', 'new']">Draft a letter</a>
      </div>
    }
  `,
  styles: `
    .mt-clerk-draft {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
      min-width: 0;
    }
    .mt-clerk-draft .pad {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      align-items: flex-start;
    }
    .mt-clerk-draft .head {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-16);
      align-items: flex-start;
      justify-content: space-between;
    }
    .mt-clerk-draft .head .title {
      gap: var(--space-4);
      min-width: 0;
    }
    .mt-clerk-draft .head p {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8);
      align-items: center;
    }
    .mt-clerk-draft .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
    }
    .mt-clerk-draft .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-16);
    }
    @media (min-width: 1024px) {
      .mt-clerk-draft .layout {
        grid-template-columns: minmax(0, 1fr) 280px;
      }
    }
    .mt-clerk-draft .editor {
      gap: var(--space-8);
      min-width: 0;
    }
    .mt-clerk-draft .frame {
      position: relative;
      display: grid;
      padding: 0;
      height: auto;
      min-height: 360px;
    }
    .mt-clerk-draft .frame .layer,
    .mt-clerk-draft .frame .field {
      grid-area: 1 / 1;
      margin: 0;
      padding: var(--space-12);
      font: 400 14px/22px var(--font-sans);
      letter-spacing: normal;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
      tab-size: 4;
      box-sizing: border-box;
      min-height: 360px;
      max-height: 70vh;
      overflow-y: auto;
    }
    .mt-clerk-draft .frame .layer {
      color: transparent;
      pointer-events: none;
      overflow: hidden;
    }
    .mt-clerk-draft .frame .layer mark {
      color: transparent;
      background: var(--warning-subtle, #fff3c4);
      border-radius: 2px;
    }
    .mt-clerk-draft .frame .field {
      position: relative;
      width: 100%;
      resize: vertical;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--text-primary);
    }
    .mt-clerk-draft .rewrite {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8);
      align-items: flex-end;
    }
    .mt-clerk-draft .rewrite mt-text-field {
      flex: 1 1 220px;
    }
    .mt-clerk-draft .side {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-clerk-draft .side section {
      gap: var(--space-6);
    }
    .mt-clerk-draft .side ul {
      margin: 0;
      padding-inline-start: var(--space-16);
    }
    .mt-clerk-draft .confirm {
      text-align: start;
      border: 0;
      border-radius: var(--radius-sm, 4px);
      padding: var(--space-4) var(--space-6);
      /* Theme tokens: the undefined --warning-subtle fell back to a pale yellow in the dark theme
         too, under the dark theme's light text (SEC-06, WCAG 1.4.3). */
      background: var(--bg-warning-subtle);
      color: var(--text-primary);
      font: 400 13px/18px var(--font-sans);
      cursor: pointer;
    }
  `,
})
export class ClerkDraftPage {
  private readonly screen = inject(MatterScreen);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly api = clerkDraftCallables(inject(CALLABLES));
  protected readonly sources = inject(CitationSources);
  private readonly canPrivileged = can('privileged.view');

  protected readonly manualPath = MANUAL_PATH;
  protected readonly matterId = this.screen.id;
  private readonly draftId = toSignal(this.route.paramMap.pipe(map((params) => params.get('draftId'))), {
    initialValue: null,
  });
  private readonly repo = clerkDraftRepository(this.matterId);
  protected readonly doc = this.repo.watch(() => this.draftId());
  protected readonly draft = computed<DraftDoc | null>(() => {
    const draft = this.doc.value();
    return draft && draft.id === this.draftId() && !draft.deletedAt ? draft : null;
  });
  private readonly type = computed(() => {
    const id = this.draft()?.typeId;
    return id ? clerkDraftType(id) : undefined;
  });
  protected readonly typeTitle = computed(() => this.type()?.title ?? null);

  private readonly field = viewChild<ElementRef<HTMLTextAreaElement>>('field');
  private readonly layer = viewChild<ElementRef<HTMLElement>>('layer');

  /** The letter as edited here, and who wrote each part. */
  protected readonly body = signal('');
  private readonly runs = signal<ProvenanceRun[]>([]);
  /** Edits not saved to the draft yet. */
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  protected readonly saving = signal(false);
  protected readonly selection = signal<{ start: number; end: number }>({ start: 0, end: 0 });
  protected readonly rewriteAsk = signal('');
  protected readonly rewriting = signal(false);
  protected readonly filing = signal(false);
  protected readonly busy = computed(() => this.rewriting() || this.filing());
  protected readonly actionError = signal<unknown>(null);

  protected readonly locked = computed(() => this.draft()?.status === 'drafting' || this.busy());
  protected readonly segments = computed(() => draftSegments(this.body()));
  protected readonly placeholders = computed(() => draftPlaceholders(this.body()));
  protected readonly toConfirm = computed(() => toConfirmText(this.placeholders().length));
  protected readonly selected = computed(() => {
    const { start, end } = this.selection();
    return end > start && end - start <= CLERK_DRAFT_REWRITE_MAX && !this.locked();
  });
  protected readonly canSave = computed(() => !!this.body().trim() && !this.busy());
  protected readonly statusLabel = computed(() => {
    const draft = this.draft();
    return draft ? draftStatusLabel(draft) : '';
  });
  protected readonly errorText = computed(() => {
    const error = this.actionError();
    if (error) return errorCopy(error);
    const draft = this.draft();
    return draft?.status === 'error' ? draftErrorCopy(draft.error) : null;
  });
  protected readonly unavailable = computed(() => {
    const error = this.actionError();
    if (error) return clerkUnavailable(error);
    const code = this.draft()?.error?.code;
    return !!code && code !== 'CLERK_REFUSED' && code.startsWith('CLERK_');
  });
  protected readonly authorship = computed(() => {
    const totals = provenanceTotals(this.runs());
    const all = totals.clerk + totals.person;
    if (!all) return 'Clerk’s share of the letter shows here once it has text.';
    const clerk = Math.round((totals.clerk / all) * 100);
    return `Clerk wrote ${clerk}% of this letter and you wrote ${100 - clerk}%. Kept with the draft for the record; never printed.`;
  });
  protected readonly citations = computed(() => this.sources.vms((this.draft()?.citations ?? []) as CitationInput[]));

  constructor() {
    // Clerk's text as it streams, and the saved draft whenever nothing here is waiting to save.
    effect(() => {
      const draft = this.draft();
      if (!draft) return;
      untracked(() => {
        if (draft.status !== 'drafting' && this.dirty) return;
        this.load(draft.bodyMd, draft.provenance);
      });
    });
    effect(() => {
      const cited = (this.draft()?.citations ?? []) as CitationInput[];
      untracked(() => this.sources.want(cited));
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
      if (this.dirty) void this.flush();
    });
  }

  /** Shows text from the draft; while Clerk writes, the newest text stays in view. */
  private load(text: string, runs: readonly ProvenanceRun[]): void {
    this.runs.set([...runs]);
    if (text === this.body()) return;
    this.body.set(text);
    const drafting = this.draft()?.status === 'drafting';
    setTimeout(() => {
      const field = this.field()?.nativeElement;
      if (field && drafting) field.scrollTop = field.scrollHeight;
      this.syncScroll();
    });
  }

  protected edit(): void {
    const field = this.field()?.nativeElement;
    if (!field || this.locked()) return;
    const before = this.body();
    const after = field.value;
    this.runs.set(editProvenance(this.runs(), before, after, 'person'));
    this.body.set(after);
    this.track();
    this.schedule();
  }

  protected track(): void {
    const field = this.field()?.nativeElement;
    if (field) this.selection.set({ start: field.selectionStart, end: field.selectionEnd });
  }

  protected syncScroll(): void {
    const field = this.field()?.nativeElement;
    const layer = this.layer()?.nativeElement;
    if (field && layer) layer.scrollTop = field.scrollTop;
  }

  protected selectRange(start: number, end: number): void {
    const field = this.field()?.nativeElement;
    if (!field) return;
    field.focus();
    field.setSelectionRange(start, end);
    this.track();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
  }

  /** Saves the edits to the draft (rules: the owner, `bodyMd` and `provenance` only, once Clerk has finished). */
  private async flush(): Promise<boolean> {
    const draft = this.draft();
    if (!draft || draft.status === 'drafting') return false;
    if (this.timer) clearTimeout(this.timer);
    const bodyMd = this.body();
    const provenance = this.runs();
    this.saving.set(true);
    try {
      await this.repo.update(draft.id, { bodyMd, provenance });
      // Typing since then is still waiting.
      if (this.body() === bodyMd) this.dirty = false;
      return true;
    } catch (error) {
      this.actionError.set(error);
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  protected async stop(): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    try {
      await this.repo.update(draft.id, { stopRequested: true });
    } catch (error) {
      this.toasts.show({ title: 'Clerk didn’t stop', description: errorCopy(error), tone: 'danger' });
    }
  }

  /** Clerk rewrites the selection; the result replaces it here and counts as Clerk's. */
  protected async rewrite(): Promise<void> {
    const draft = this.draft();
    const matterId = this.matterId();
    if (!draft || !matterId || !this.selected()) return;
    const { start, end } = this.selection();
    const text = this.body();
    this.rewriting.set(true);
    this.actionError.set(null);
    try {
      const result = await this.api.rewrite({
        matterId,
        draftId: draft.id,
        selection: text.slice(start, end),
        ...rewriteContext(text, start, end),
        instruction: this.rewriteAsk().trim(),
      });
      if (this.body() !== text) {
        this.toasts.show({
          title: 'The letter changed while Clerk was rewriting',
          description: 'Select the text again.',
        });
        return;
      }
      const next = `${text.slice(0, start)}${result.text}${text.slice(end)}`;
      this.runs.set(spliceProvenance(this.runs(), start, end, result.text.length, 'clerk'));
      this.body.set(next);
      this.rewriteAsk.set('');
      this.schedule();
      setTimeout(() => this.selectRange(start, start + result.text.length));
    } catch (error) {
      this.actionError.set(error);
    } finally {
      this.rewriting.set(false);
    }
  }

  protected async redraft(): Promise<void> {
    const draft = this.draft();
    const matterId = this.matterId();
    if (!draft || !matterId) return;
    if (
      draftEdited(draft, this.body()) &&
      !(await this.dialogs.confirm({
        title: 'Redraft the whole letter?',
        body: 'Clerk starts again from the matter. Your edits to this draft will be lost.',
        confirmLabel: 'Redraft',
        tone: 'danger',
      }))
    )
      return;
    this.actionError.set(null);
    if (this.timer) clearTimeout(this.timer);
    this.dirty = false;
    try {
      await this.api.redraft({ matterId, draftId: draft.id });
    } catch (error) {
      this.actionError.set(error);
    }
  }

  protected async discard(): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    if (
      !(await this.dialogs.confirm({
        title: 'Discard this draft?',
        body: 'Letters already saved to the matter’s documents stay there.',
        confirmLabel: 'Discard draft',
        tone: 'danger',
      }))
    )
      return;
    if (this.timer) clearTimeout(this.timer);
    this.dirty = false;
    try {
      await this.repo.softDelete(draft.id);
      await this.router.navigate(['/matters', this.matterId(), 'drafts', 'new'], { replaceUrl: true });
    } catch (error) {
      this.actionError.set(error);
    }
  }

  /**
   * Files the letter on the letterhead in the matter's documents. Asks first when placeholders
   * remain, and when a letter to a third party drew on privileged material.
   */
  protected async save(): Promise<void> {
    const draft = this.draft();
    const matterId = this.matterId();
    if (!draft || !matterId || !this.canSave()) return;
    const count = this.placeholders().length;
    if (
      count &&
      !(await this.dialogs.confirm({
        title: `Save with ${toConfirmText(count)}?`,
        body: 'They print highlighted on the letter, for you to fill in before it goes anywhere.',
        confirmLabel: 'Save anyway',
      }))
    )
      return;
    let confirmPrivileged = false;
    if (draft.privileged && this.type()?.audience === 'third_party') {
      if (!(await this.confirmPrivileged())) return;
      confirmPrivileged = true;
    }
    this.filing.set(true);
    this.actionError.set(null);
    if (this.timer) clearTimeout(this.timer);
    try {
      const result = await this.api.save({
        matterId,
        draftId: draft.id,
        bodyMd: this.body(),
        provenance: this.runs(),
        confirmPrivileged,
      });
      this.dirty = false;
      this.toasts.show({
        title: 'Saved to documents',
        description: 'Saved on the letterhead as a draft. Nothing was sent.',
        tone: 'success',
      });
      await this.router.navigate(['/matters', matterId, 'documents', result.documentId]);
    } catch (error) {
      if (errorCodeOf(error) === 'FAILED_PRECONDITION' && !confirmPrivileged && this.privilegedAsked(error)) {
        this.filing.set(false);
        if (await this.confirmPrivileged()) return this.saveConfirmed();
        return;
      }
      this.actionError.set(error);
    } finally {
      this.filing.set(false);
    }
  }

  private privilegedAsked(error: unknown): boolean {
    return (error as { details?: { reason?: unknown } }).details?.reason === 'privileged_confirmation';
  }

  private confirmPrivileged(): Promise<boolean> {
    return this.dialogs.confirm({
      title: 'This letter may carry privileged material',
      body: `Clerk drew on privileged material, and the letter goes to someone other than your client. Check that it discloses nothing privileged before it is sent. It is filed as privileged${this.canPrivileged() ? '' : ', which your role can’t open'}.`,
      confirmLabel: 'Save as privileged',
    });
  }

  private async saveConfirmed(): Promise<void> {
    const draft = this.draft();
    const matterId = this.matterId();
    if (!draft || !matterId) return;
    this.filing.set(true);
    try {
      const result = await this.api.save({
        matterId,
        draftId: draft.id,
        bodyMd: this.body(),
        provenance: this.runs(),
        confirmPrivileged: true,
      });
      this.dirty = false;
      this.toasts.show({
        title: 'Saved to documents',
        description: 'Filed as privileged. Nothing was sent.',
        tone: 'success',
      });
      await this.router.navigate(['/matters', matterId, 'documents', result.documentId]);
    } catch (error) {
      this.actionError.set(error);
    } finally {
      this.filing.set(false);
    }
  }

  protected openCitation(event: CitationOpenEvent): void {
    this.sources.open((this.draft()?.citations ?? []) as CitationInput[], event.n);
  }
}
