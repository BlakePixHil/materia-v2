import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can, OrgContext } from '@materia/data-access';
import {
  clerkChatCallables,
  clerkMessageRepository,
  clerkMessagesQuery,
  clerkThreadRepository,
  clerkThreadsQuery,
  matterDocumentRepository,
  matterDocumentsQuery,
  sortMessages,
  sortThreads,
} from '@materia/data-access/repository';
import {
  CLERK_CHAT_ATTACHMENTS_MAX,
  CLERK_FEEDBACK_REASON_LABELS,
  CLERK_FEEDBACK_REASONS,
  type CitationInput,
  type ClerkFeedbackReason,
} from '@materia/domain';
import {
  MtBadge,
  MtButton,
  MtCheckbox,
  MtClerkWorking,
  MtComposer,
  MtIconButton,
  MtNote,
  MtSwitch,
  ToastService,
  type CitationOpenEvent,
  type CitationVm,
} from '@materia/ui';
import { MtClerkMessage, MtUserMessage } from '@materia/ui/markdown';

import { ClerkChatSuggestion } from './clerk-chat-suggestion';
import {
  answerError,
  blocksComposer,
  CHAT_COMMANDS,
  isUnavailable,
  MANUAL_PATH,
  messageNote,
  messageState,
  messageText,
  retryable,
  scopeLabel,
  streamingAnswer,
  workingLabel,
  type ChatMessage,
  type ChatThread,
} from './clerk-chat-view';
import { ClerkPanel } from '../../core/clerk/clerk-panel';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { startTrace } from '../../core/observability/perf';
import { CitationScope, CitationSources } from '../citations/citation-sources';
import { CitationViewer } from '../citations/citation-viewer';

/**
 * The Clerk chat panel (AI-06, ADR-044), inside the shell's ⌘J panel, loaded the first time it
 * opens. It asks Clerk about the matter the page is scoped to: one thread at a time, the person's
 * own threads and the ones shared with the matter team listed per matter, "New thread", and "Share
 * with matter team" for the owner.
 *
 * `clerk-sendMessage` returns at once and the answer streams into its message from the server, so
 * navigating away doesn't stop it and another tab sees the same stream. While Clerk works, the
 * running tool shows ("Searching documents…"); Stop sets `stopRequested`; Retry adds a new answer
 * (history is never edited); each answer can be copied and rated (with a reason when it's down).
 * Proposed suggestions show as cards under their answer; citations open in the citation viewer.
 * When Clerk can't answer (switched off, over budget, rate limited), the panel says why and points
 * to the manual way.
 */
@Component({
  selector: 'mt-clerk-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    CitationViewer,
    ClerkChatSuggestion,
    FormsModule,
    MtBadge,
    MtButton,
    MtCheckbox,
    MtClerkMessage,
    MtClerkWorking,
    MtComposer,
    MtIconButton,
    MtNote,
    MtSwitch,
    MtUserMessage,
  ],
  providers: [
    CitationSources,
    {
      provide: CitationScope,
      useFactory: (): CitationScope => {
        const panel = inject(ClerkPanel);
        return { id: computed(() => panel.scope()?.id ?? null), canPrivileged: can('privileged.view') };
      },
    },
  ],
  host: { class: 'mt-clerk-chat' },
  styles: `
    .mt-clerk-chat {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .mt-clerk-chat .threadbar {
      display: flex;
      align-items: center;
      gap: var(--space-6);
      padding: var(--space-8) var(--space-12);
      border-bottom: 1px solid var(--border-subtle);
      flex: none;
      min-width: 0;
    }
    .mt-clerk-chat .threadbar .title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 500 13px/18px var(--font-sans);
    }
    .mt-clerk-chat .threads {
      list-style: none;
      margin: 0;
      padding: var(--space-4) var(--space-8);
      border-bottom: 1px solid var(--border-subtle);
      max-height: 40%;
      overflow-y: auto;
      flex: none;
    }
    .mt-clerk-chat .threads button {
      display: flex;
      width: 100%;
      gap: var(--space-8);
      align-items: center;
      padding: var(--space-6) var(--space-8);
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      color: var(--text-primary);
      font: 400 13px/18px var(--font-sans);
      text-align: left;
      cursor: pointer;
    }
    .mt-clerk-chat .threads button:hover,
    .mt-clerk-chat .threads button[aria-current='true'] {
      background: var(--bg-hover);
    }
    /* Positioned, so the screen-reader-only text in citations scrolls with the log instead of
       sitting where it would be unscrolled and stretching the page below the panel. */
    .mt-clerk-chat .log {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-16);
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
    }
    .mt-clerk-chat .empty {
      margin: auto 0;
      text-align: center;
      color: var(--text-secondary);
      font: 400 13px/20px var(--font-sans);
    }
    .mt-clerk-chat .empty h2 {
      margin: 0 0 var(--space-4);
      font: 600 14px/20px var(--font-sans);
      color: var(--text-primary);
    }
    .mt-clerk-chat .answer {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-clerk-chat .reasons {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      align-items: center;
    }
    .mt-clerk-chat .foot {
      flex: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding: var(--space-12);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-clerk-chat .attach {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-height: 160px;
      overflow-y: auto;
    }
  `,
  template: `
    @if (!scope()) {
      <div class="log">
        <div class="empty">
          <h2>Ask Clerk about a matter</h2>
          <p>Open a matter, then press ⌘J. Clerk answers from that matter’s facts, notes and documents.</p>
        </div>
      </div>
    } @else if (!canUse()) {
      <div class="log">
        <div class="empty"><p>Your role can’t use Clerk. Ask a practice admin if you need it.</p></div>
      </div>
    } @else {
      <div class="threadbar">
        <button
          mtIconButton
          icon="list"
          size="sm"
          label="Threads"
          [attr.aria-expanded]="showThreads()"
          aria-controls="mt-clerk-threads"
          (click)="showThreads.set(!showThreads())"
        ></button>
        <span class="title mt-grow">{{ thread()?.title ?? 'New thread' }}</span>
        @if (thread()?.privileged) {
          <mt-badge tone="warning">Privileged</mt-badge>
        }
        @if (mine()) {
          <mt-switch
            name="share"
            label="Share with matter team"
            [labelHidden]="true"
            [ngModel]="thread()?.shared ?? false"
            (ngModelChange)="share($event)"
          />
        }
        <button mtIconButton icon="compose" size="sm" label="New thread" (click)="newThread()"></button>
      </div>
      @if (showThreads()) {
        <ul class="threads" id="mt-clerk-threads" aria-label="Threads on this matter">
          @for (item of threads(); track item.id) {
            <li>
              <button
                type="button"
                [attr.aria-current]="item.id === threadId() ? 'true' : null"
                (click)="openThread(item.id)"
              >
                <span class="mt-grow mt-ell">{{ item.title }}</span>
                @if (item.ownerUid !== uid()) {
                  <mt-badge>Shared</mt-badge>
                }
              </button>
            </li>
          } @empty {
            <li class="caption t-3" style="padding: var(--space-6) var(--space-8)">No threads on this matter yet.</li>
          }
        </ul>
      }

      <div class="log" #log role="log" aria-label="Conversation with Clerk">
        @if (thread()?.continuedFrom; as from) {
          <mt-note>
            This thread continues an earlier one that got too long; Clerk was given a summary of it.
            <button mtButton variant="ghost" size="sm" (click)="openThread(from)">Open the earlier thread</button>
          </mt-note>
        }
        @for (message of messages(); track message.id) {
          @if (message.role === 'user') {
            <mt-user-message>
              {{ text(message) }}
              @if (message.attachments?.length; as count) {
                <span class="caption t-3"> · {{ count }} attachment{{ count === 1 ? '' : 's' }}</span>
              }
            </mt-user-message>
          } @else {
            <div class="answer" [attr.data-message]="message.id">
              @if (working(message); as label) {
                <mt-clerk-working [label]="label" />
              }
              <mt-clerk-message
                [content]="text(message)"
                [citations]="citations(message)"
                [state]="state(message)"
                [error]="errorOf(message)"
                (retry)="retry(message)"
                (citationOpen)="openCitation(message, $event)"
              >
                <button mtButton variant="ghost" size="sm" iconStart="copy" (click)="copy(message)">Copy</button>
                <button
                  mtButton
                  variant="ghost"
                  size="sm"
                  [attr.aria-pressed]="message.feedback?.rating === 'up'"
                  (click)="rate(message, 'up')"
                >
                  Helpful
                </button>
                <button
                  mtButton
                  variant="ghost"
                  size="sm"
                  [attr.aria-pressed]="message.feedback?.rating === 'down'"
                  [attr.aria-expanded]="reasonsFor() === message.id"
                  (click)="reasonsFor.set(reasonsFor() === message.id ? null : message.id)"
                >
                  Not helpful
                </button>
                @if (canRetry(message)) {
                  <button mtButton variant="ghost" size="sm" iconStart="refresh" (click)="retry(message)">Retry</button>
                }
              </mt-clerk-message>
              @if (note(message); as note) {
                <mt-note>{{ note }}</mt-note>
              }
              @if (message.status === 'stopped' && canRetry(message)) {
                <div class="mt-row">
                  <button mtButton variant="ghost" size="sm" iconStart="refresh" (click)="retry(message)">Retry</button>
                </div>
              }
              @if (unavailable(message)) {
                <p class="caption t-2">{{ manualPath }}</p>
              }
              @if (reasonsFor() === message.id) {
                <div class="reasons" role="group" aria-label="What was wrong with this answer?">
                  @for (reason of reasons; track reason) {
                    <button
                      mtButton
                      size="sm"
                      [attr.aria-pressed]="message.feedback?.reason === reason"
                      (click)="rate(message, 'down', reason)"
                    >
                      {{ reasonLabel(reason) }}
                    </button>
                  }
                </div>
              }
              @for (id of message.suggestionIds; track id) {
                <mt-clerk-chat-suggestion [suggestionId]="id" [matterId]="matterId() ?? ''" [canUse]="canUse()" />
              }
            </div>
          }
        } @empty {
          @if (!threadId()) {
            <div class="empty">
              <h2>Ask Clerk about {{ scope()?.label }}</h2>
              <p>
                Clerk answers from this matter’s facts, notes and documents, and cites its sources. It can’t change
                anything: anything it suggests waits for you to accept it.
              </p>
            </div>
          }
        }
      </div>

      <div class="foot">
        @if (!enabled()) {
          <mt-note tone="warning" data-clerk-off>{{ offCopy() }} {{ manualPath }}</mt-note>
        } @else if (sendError(); as error) {
          <mt-note tone="danger">{{ errorText(error) }} {{ unavailableError(error) ? manualPath : '' }}</mt-note>
        }
        @if (notice(); as notice) {
          <mt-note>{{ notice }}</mt-note>
        }
        @if (attachOpen()) {
          <div class="attach" role="group" aria-label="Attach documents">
            @for (doc of documents(); track doc.id) {
              <mt-checkbox
                [name]="'attach-' + doc.id"
                [label]="doc.name"
                [disabled]="!attachments().includes(doc.id) && attachments().length >= attachmentsMax"
                [ngModel]="attachments().includes(doc.id)"
                (ngModelChange)="toggleAttachment(doc.id, $event)"
              />
            } @empty {
              <p class="caption t-3">No documents on this matter to attach yet.</p>
            }
          </div>
        }
        <mt-composer
          [scope]="composerScope()"
          [commands]="commands"
          [streaming]="!!streaming()"
          [disabled]="composerOff()"
          [(value)]="draft"
          (send)="send($event)"
          (stop)="stop()"
          (attach)="attachOpen.set(!attachOpen())"
        />
      </div>

      <!-- The citation viewer (AI-05) loads the first time a source is opened. -->
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
    }
  `,
})
export class ClerkChatPanel {
  private readonly panel = inject(ClerkPanel);
  private readonly context = inject(OrgContext);
  private readonly flags = inject(FeatureFlagService);
  private readonly toasts = inject(ToastService);
  private readonly api = clerkChatCallables(inject(CALLABLES));
  protected readonly sources = inject(CitationSources);

  protected readonly commands = CHAT_COMMANDS;
  protected readonly reasons = CLERK_FEEDBACK_REASONS;
  protected readonly manualPath = MANUAL_PATH;
  protected readonly attachmentsMax = CLERK_CHAT_ATTACHMENTS_MAX;

  protected readonly scope = this.panel.scope;
  protected readonly matterId = computed(() => this.scope()?.id ?? null);
  protected readonly uid = this.context.uid;
  protected readonly canUse = can('clerk.use');
  private readonly canPrivileged = can('privileged.view');
  protected readonly enabled = computed(
    () => this.flags.isOn('clerk.enabled') && this.flags.isOn('clerk.features.chat'),
  );
  /** Why chat is off here: one of Materia's switches, which nothing in Settings changes. */
  protected readonly offCopy = computed(() =>
    errorCopy({
      details: {
        code: 'CLERK_DISABLED',
        switch: this.flags.isOn('clerk.enabled') ? 'clerk.features.chat' : 'clerk.enabled',
      },
    }),
  );
  private readonly active = computed(() => !!this.matterId() && !!this.uid() && this.canUse());

  protected readonly threadId = signal<string | null>(null);
  protected readonly showThreads = signal(false);
  protected readonly draft = signal('');
  protected readonly attachments = signal<string[]>([]);
  protected readonly attachOpen = signal(false);
  protected readonly sendError = signal<unknown>(null);
  protected readonly sending = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly reasonsFor = signal<string | null>(null);
  /** The clerk_first_token trace (FND-21): from Send or Retry to the answer's first words. */
  private readonly firstToken = signal<{ done: () => void; messageId: string | null } | null>(null);
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');

  private readonly threadRepo = clerkThreadRepository();
  private readonly messageRepo = clerkMessageRepository(() => this.threadId());
  private readonly mineQuery = this.threadRepo.watchQuery(() => this.threadsQuery('mine'));
  private readonly sharedQuery = this.threadRepo.watchQuery(() => this.threadsQuery('shared'));
  protected readonly threads = computed(() => sortThreads(this.mineQuery.value(), this.sharedQuery.value()));
  private readonly threadDoc = this.threadRepo.watch(() => this.threadId());
  protected readonly thread = computed<ChatThread | null>(() => {
    const thread = this.threadDoc.value();
    return thread && thread.id === this.threadId() ? thread : null;
  });
  protected readonly mine = computed(() => !!this.thread() && this.thread()?.ownerUid === this.uid());
  private readonly messageQuery = this.messageRepo.watchQuery(() =>
    this.threadId() && this.active() ? clerkMessagesQuery({ privilegedVisible: this.canPrivileged() }) : null,
  );
  protected readonly messages = computed(() => sortMessages(this.messageQuery.value()));
  protected readonly streaming = computed(() => streamingAnswer(this.messages()));
  private readonly docQuery = matterDocumentRepository(() => this.matterId()).watchQuery(() =>
    this.attachOpen() && this.matterId() ? matterDocumentsQuery({ privilegedVisible: this.canPrivileged() }) : null,
  );
  protected readonly documents = computed(() =>
    this.docQuery.value().filter((doc) => !doc.deletedAt && doc.scan.status === 'clean'),
  );

  protected readonly composerScope = computed(() => scopeLabel(this.scope()?.label ?? '', this.attachments().length));
  protected readonly composerOff = computed(
    () =>
      !this.enabled() ||
      this.sending() ||
      (!this.thread() && !!this.threadId()) ||
      (!!this.threadId() && !this.mine()) ||
      blocksComposer(this.sendError()),
  );

  constructor() {
    // A new scope (another matter) starts a new conversation; the old thread stays in its list.
    effect(() => {
      this.matterId();
      untracked(() => {
        this.threadId.set(null);
        this.attachments.set([]);
        this.sendError.set(null);
        this.notice.set(null);
      });
    });
    // Each answer's cited documents are read once, for the chips and the viewer.
    effect(() => {
      const cited = this.messages().flatMap((message) => message.citations as CitationInput[]);
      untracked(() => this.sources.want(cited));
    });
    // The first words of the answer being timed end its trace. An answer that ends without any
    // (an error, a refusal, stopped early) isn't timed.
    effect(() => {
      const timing = this.firstToken();
      const answer = timing?.messageId ? this.messages().find((message) => message.id === timing.messageId) : null;
      if (!timing || !answer) return;
      if (messageText(answer)) timing.done();
      if (messageText(answer) || answer.status !== 'streaming') untracked(() => this.firstToken.set(null));
    });
    // Keep the newest message in view as it streams.
    effect(() => {
      this.messages();
      const log = this.log()?.nativeElement;
      if (log) queueMicrotask(() => log.scrollTo?.({ top: log.scrollHeight }));
    });
  }

  private threadsQuery(which: 'mine' | 'shared') {
    const matterId = this.matterId();
    const uid = this.uid();
    if (!matterId || !uid || !this.active()) return null;
    return clerkThreadsQuery({ uid, matterId, which, privilegedVisible: this.canPrivileged() });
  }

  protected text(message: ChatMessage): string {
    return messageText(message);
  }

  protected state(message: ChatMessage) {
    return messageState(message);
  }

  protected note(message: ChatMessage): string | null {
    return messageNote(message);
  }

  protected errorOf(message: ChatMessage): string | undefined {
    return answerError(message);
  }

  protected unavailable(message: ChatMessage): boolean {
    return !!message.error && isUnavailable({ details: { code: message.error.code } });
  }

  protected working(message: ChatMessage): string | null {
    const label = workingLabel(message);
    if (label) return label;
    return message.status === 'streaming' && !messageText(message) ? 'Reading the matter…' : null;
  }

  protected citations(message: ChatMessage): CitationVm[] {
    return this.sources.vms(message.citations as CitationInput[]);
  }

  protected canRetry(message: ChatMessage): boolean {
    return this.mine() && !this.streaming() && retryable(this.messages(), message);
  }

  protected reasonLabel(reason: ClerkFeedbackReason): string {
    return CLERK_FEEDBACK_REASON_LABELS[reason];
  }

  protected errorText(error: unknown): string {
    return errorCopy(error);
  }

  protected unavailableError(error: unknown): boolean {
    return isUnavailable(error);
  }

  protected newThread(): void {
    this.threadId.set(null);
    this.showThreads.set(false);
    this.sendError.set(null);
    this.notice.set(null);
  }

  protected openThread(id: string): void {
    this.threadId.set(id);
    this.showThreads.set(false);
    this.sendError.set(null);
    this.notice.set(null);
  }

  protected toggleAttachment(id: string, on: boolean): void {
    this.attachments.update((ids) =>
      on ? [...new Set([...ids, id])].slice(0, CLERK_CHAT_ATTACHMENTS_MAX) : ids.filter((other) => other !== id),
    );
  }

  /** Asks Clerk; the answer streams into its message, which the thread's listener shows. */
  protected async send(text: string): Promise<void> {
    const matterId = this.matterId();
    if (!matterId || this.sending()) return;
    this.sending.set(true);
    this.sendError.set(null);
    this.notice.set(null);
    const done = startTrace('clerk_first_token');
    try {
      const threadId = this.threadId();
      const result = await this.api.send({
        matterId,
        text,
        attachments: this.attachments(),
        ...(threadId ? { threadId } : {}),
      });
      this.threadId.set(result.threadId);
      this.firstToken.set({ done, messageId: result.messageId });
      this.attachments.set([]);
      this.attachOpen.set(false);
      if (result.continuedFrom)
        this.notice.set('That conversation got long, so Clerk carried on in a new thread with a summary of it.');
    } catch (error) {
      // Nothing was sent: give the question back.
      if (!this.draft()) this.draft.set(text);
      this.sendError.set(error);
    } finally {
      this.sending.set(false);
    }
  }

  protected async stop(): Promise<void> {
    const answer = this.streaming();
    if (!answer) return;
    try {
      await this.messageRepo.update(answer.id, { stopRequested: true });
    } catch (error) {
      this.toasts.show({ title: 'Clerk didn’t stop', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async retry(message: ChatMessage): Promise<void> {
    const threadId = this.threadId();
    if (!threadId) return;
    this.sendError.set(null);
    const done = startTrace('clerk_first_token');
    try {
      const { messageId } = await this.api.retry({ threadId, messageId: message.id });
      this.firstToken.set({ done, messageId });
    } catch (error) {
      this.sendError.set(error);
    }
  }

  protected async copy(message: ChatMessage): Promise<void> {
    try {
      await navigator.clipboard.writeText(messageText(message));
      this.toasts.show({ title: 'Answer copied', tone: 'success' });
    } catch {
      this.toasts.show({ title: 'The answer wasn’t copied', description: 'Select the text and copy it instead.' });
    }
  }

  protected async rate(message: ChatMessage, rating: 'up' | 'down', reason?: ClerkFeedbackReason): Promise<void> {
    const threadId = this.threadId();
    if (!threadId) return;
    this.reasonsFor.set(null);
    try {
      await this.api.feedback({ threadId, messageId: message.id, rating, ...(reason ? { reason } : {}) });
      this.toasts.show({ title: 'Thanks for the feedback', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Your feedback wasn’t saved', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async share(shared: boolean): Promise<void> {
    const thread = this.thread();
    if (!thread) return;
    try {
      await this.threadRepo.update(thread.id, { shared });
      this.toasts.show({ title: shared ? 'Shared with the matter team' : 'Only you can see this thread now' });
    } catch (error) {
      this.toasts.show({ title: 'The thread wasn’t shared', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected openCitation(message: ChatMessage, event: CitationOpenEvent): void {
    this.sources.open(message.citations as CitationInput[], event.n);
  }
}
