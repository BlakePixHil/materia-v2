import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { Router } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import { matterBriefCallables, matterBriefRepository, type MatterBriefDoc } from '@materia/data-access/repository';
import {
  type BriefRead,
  type BriefRefKind,
  briefRefreshesLeft,
  MATTER_BRIEF_DOC_ID,
  MATTER_BRIEF_REFRESHES_PER_DAY,
  type MatterBriefView,
} from '@materia/domain';
import { type BriefItemVm, type CitationOpenEvent, MT_TODAY, MtButton, MtClerkBrief, MtSkeleton } from '@materia/ui';

import { MatterScreen } from './matter-screen';
import { ClerkPanel } from '../../core/clerk/clerk-panel';
import { CALLABLES } from '../../core/data/callables';
import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { PhoneLayout } from '../../core/layout/phone-layout';

/** The brief as the card shows it: from the listener or from the callable, whichever is newer. */
export interface BriefShown {
  source: 'clerk' | 'template';
  reason?: string | undefined;
  headline: string;
  items: { kind: string; text: string; tone?: string | undefined; refs: BriefRefShown[]; at?: number | undefined }[];
  read: BriefRead;
  generatedAt: number;
  pending: boolean;
  refreshesLeft: number;
}
interface BriefRefShown {
  kind: BriefRefKind;
  id: string;
  label: string;
}

/** The tab each kind of record opens on (a document opens its own page). */
const REF_TABS: Readonly<Record<Exclude<BriefRefKind, 'document' | 'suggestion'>, string>> = {
  deadline: 'deadlines',
  task: 'tasks',
  note: 'notes',
  activity: 'activity',
};

/** Why the template shows instead of Clerk's brief, when the reader can do something about it. */
const REASON_COPY: Readonly<Record<string, string>> = {
  failed: 'Clerk couldn’t write this brief, so it shows the matter’s own summary.',
  limit: 'Clerk has written as many briefs as your practice allows today, so it shows the matter’s own summary.',
};

const timeFormat = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' });
const dayTimeFormat = new Intl.DateTimeFormat('en-AU', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** "2 deadlines, 1 task and 3 changes": what the brief was built from. */
export function readText(read: BriefRead): string {
  const parts = (
    [
      [read.deadlines, 'deadline'],
      [read.tasks, 'task'],
      [read.changes, 'change'],
      [read.documents, 'document'],
      [read.suggestions, 'suggestion'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, noun]) => `${n} ${noun}${n === 1 ? '' : 's'}`);
  if (parts.length <= 1) return parts[0] ?? 'nothing yet';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function briefFromView(view: MatterBriefView): BriefShown {
  return {
    source: view.source,
    reason: view.reason,
    headline: view.headline,
    items: view.items.map((item) => ({ ...item, at: item.at ? Date.parse(item.at) : undefined })),
    read: view.read,
    generatedAt: Date.parse(view.generatedAt),
    pending: view.pending,
    refreshesLeft: view.refreshesLeft,
  };
}

export function briefFromDoc(doc: MatterBriefDoc, today: string, now: number): BriefShown {
  return {
    source: doc.source,
    reason: doc.reason,
    headline: doc.headline,
    items: doc.items.map((item) => ({ ...item, at: item.at?.getTime() })),
    read: doc.read,
    generatedAt: doc.generatedAt.getTime(),
    pending: !!doc.pendingUntil && doc.pendingUntil.getTime() > now,
    refreshesLeft: briefRefreshesLeft(doc.refreshes, today),
  };
}

const SEEN_KEY = 'materia.matterBrief.seen';
const SEEN_KEPT = 100;

/**
 * When I last opened this matter's Overview on this device (null the first time), and now is
 * remembered for next time. "New since your last visit" marks the brief's changes after it.
 */
function lastSeen(uid: string, matterId: string, now: number): number | null {
  const key = `${uid}:${matterId}`;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    const seen: Record<string, number> = parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
    const before = typeof seen[key] === 'number' ? seen[key] : null;
    const next = Object.entries({ ...seen, [key]: now })
      .sort(([, a], [, b]) => b - a)
      .slice(0, SEEN_KEPT);
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(next)));
    return before;
  } catch {
    // Not remembered (private window): nothing is marked new.
    return null;
  }
}

type Busy = 'open' | 'refresh' | null;

/**
 * The brief on a matter's Overview (AI-06c, ADR-059): up to five lines on what's due, what changed
 * and the next step, each citing the records it comes from; a source opens its tab (a document
 * its page, a suggestion the "Clerk suggests…" card). Shared by everyone who can read the matter:
 * the kept brief shows at once from `briefs/latest`, and `clerk-matterBrief` (called each time the
 * tab opens) rebuilds it when it is stale. Clerk writes it when the practice, the feature and the
 * role allow; otherwise, or when Clerk fails, the matter's own summary (the template, the plain
 * card) shows. Refresh asks again, three times a day; "Ask a follow-up" opens ⌘J on this matter.
 * Read-only: nothing here changes the matter.
 */
@Component({
  selector: 'mt-matter-brief',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtClerkBrief, MtSkeleton],
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/card.css',
    '../../../../../../libs/ui/src/generated/components/clerk.css',
  ],
  host: { class: 'mt-matter-brief', '[attr.aria-busy]': 'busy() !== null || shown()?.pending === true' },
  template: `
    @if (shown(); as brief) {
      <mt-clerk-brief
        data-testid="matter-brief"
        [attr.data-source]="brief.source"
        [label]="brief.source === 'clerk' ? 'Clerk brief' : 'Matter brief'"
        [plain]="brief.source !== 'clerk'"
        [title]="brief.headline"
        [items]="items()"
        (citationOpen)="open($event)"
      >
        @if (canRefresh()) {
          <button
            mtBriefActions
            mtButton
            variant="ghost"
            size="sm"
            iconStart="refresh"
            [loading]="busy() === 'refresh'"
            [disabled]="busy() !== null || brief.pending || brief.refreshesLeft === 0"
            [attr.title]="brief.refreshesLeft === 0 ? limitCopy : null"
            (click)="refresh()"
          >
            Refresh
          </button>
        }
        @if (canAsk()) {
          <button mtBriefActions mtButton variant="clerk" size="sm" iconStart="sparkle" (click)="ask()">
            Ask a follow-up
          </button>
        }
        @if (brief.pending) {
          <p class="caption t-2 note" data-testid="matter-brief-pending">Clerk is writing a fresh brief…</p>
        } @else if (problem(); as text) {
          <p class="caption t-2 note" role="alert" data-testid="matter-brief-problem">{{ text }}</p>
        } @else if (reasonCopy(brief); as text) {
          <p class="caption t-2 note" data-testid="matter-brief-reason">{{ text }}</p>
        }
        <p class="mt-clerk-foot" data-testid="matter-brief-foot">{{ foot(brief) }}</p>
      </mt-clerk-brief>
    } @else if (failed()) {
      <section class="mt-card" data-pad aria-labelledby="mt-ov-brief">
        <div class="mt-card-h">
          <h2 class="mt-card-title" id="mt-ov-brief">Matter brief</h2>
          <button class="mt-ml" mtButton variant="ghost" size="sm" iconStart="refresh" (click)="load()">
            Try again
          </button>
        </div>
        <p class="caption t-2" role="alert" data-testid="matter-brief-problem">{{ problem() }}</p>
      </section>
    } @else {
      <section class="mt-card" data-pad aria-labelledby="mt-ov-brief">
        <div class="mt-card-h"><h2 class="mt-card-title" id="mt-ov-brief">Matter brief</h2></div>
        <mt-skeleton label="Loading the matter brief…" [count]="3" />
      </section>
    }
    <p class="mt-sr" aria-live="polite">{{ announcement() }}</p>
  `,
  styles: `
    .mt-matter-brief {
      display: block;
      min-width: 0;
    }
    .mt-matter-brief .note {
      margin: var(--space-8) 0 0;
    }
    .mt-matter-brief .mt-card-h {
      gap: var(--space-8);
    }
    .mt-matter-brief h2 {
      margin: 0;
    }
  `,
})
export class MatterBrief {
  private readonly screen = inject(MatterScreen);
  private readonly flags = inject(FeatureFlagService);
  private readonly panel = inject(ClerkPanel);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly context = inject(OrgContext);
  private readonly today = inject(MT_TODAY);
  private readonly api = matterBriefCallables(inject(CALLABLES));
  private readonly canClerk = can('clerk.use');
  private readonly id = this.screen.id;

  protected readonly limitCopy = `This brief has been refreshed ${MATTER_BRIEF_REFRESHES_PER_DAY} times today. It updates on its own when the matter changes.`;

  private readonly doc = matterBriefRepository(this.id).watch(() => (this.id() ? MATTER_BRIEF_DOC_ID : null));
  /** The callable's latest answer (shown until the listener catches up, or when it can't). */
  private readonly returned = signal<BriefShown | null>(null);
  private readonly now = signal(Date.now());
  protected readonly busy = signal<Busy>(null);
  protected readonly problem = signal<string | null>(null);
  /** The first call failed and there is no brief to show. */
  protected readonly failed = signal(false);
  protected readonly announcement = signal('');
  private readonly seen = signal<number | null>(null);
  private readonly mobile = inject(PhoneLayout).phone;
  /** The latest call; an answer to an earlier one (another matter since) is dropped. */
  private seq = 0;

  protected readonly shown = computed<BriefShown | null>(() => {
    const doc = this.doc.value();
    const fromDoc = doc ? briefFromDoc(doc, this.today(), this.now()) : null;
    const returned = this.returned();
    if (!fromDoc) return returned;
    return returned && returned.generatedAt > fromDoc.generatedAt ? returned : fromDoc;
  });

  /** Clerk may write it for this person: Refresh asks again. */
  protected readonly canRefresh = computed(
    () =>
      this.flags.isOn('clerk.enabled') &&
      this.flags.isOn('clerk.features.matterBrief') &&
      this.canClerk() &&
      !this.screen.deleted() &&
      !this.screen.archived(),
  );
  /** ⌘J's chat is on (AI-06), and not on a phone, where the panel doesn't open. */
  protected readonly canAsk = computed(
    () =>
      this.flags.isOn('clerk.enabled') && this.flags.isOn('clerk.features.chat') && this.canClerk() && !this.mobile(),
  );
  /** Suggestions open on the "Clerk suggests…" card, shown only when the role can act on them (AI-07). */
  private readonly suggestionsShown = computed(() => this.flags.isOn('clerk.features.suggestions') && this.canClerk());

  protected readonly items = computed<BriefItemVm[]>(() => {
    const brief = this.shown();
    if (!brief) return [];
    const seen = this.seen();
    let n = 0;
    return brief.items.flatMap((item, index): BriefItemVm[] => {
      const refs = item.refs.filter((ref) => ref.kind !== 'suggestion' || this.suggestionsShown());
      if (!refs.length) return [];
      const fresh = item.kind === 'changed' && seen !== null && item.at !== undefined && item.at > seen;
      const overdue = item.kind === 'due' && item.tone === 'danger';
      return [
        {
          id: `${index}`,
          icon: overdue ? 'alert' : item.kind === 'due' ? 'calendar' : item.kind === 'next' ? 'arrow-right' : 'clock',
          tone:
            item.kind === 'next' ? 'brand' : item.tone === 'danger' || item.tone === 'warning' ? item.tone : undefined,
          lead: overdue
            ? 'Overdue.'
            : item.kind === 'due'
              ? 'Due soon.'
              : item.kind === 'next'
                ? 'Next step.'
                : fresh
                  ? 'New since your last visit.'
                  : undefined,
          text: item.text,
          citations: refs.map((ref) => ({
            n: ++n,
            documentId: `${ref.kind}:${ref.id}`,
            label: ref.label,
            kind: ref.kind === 'document' ? 'document' : 'record',
          })),
        },
      ];
    });
  });

  constructor() {
    // Each matter opened: the kept brief, rebuilt when it is stale.
    effect(() => {
      const matterId = this.id();
      if (!matterId) return;
      untracked(() => {
        const uid = this.context.uid();
        this.seen.set(uid ? lastSeen(uid, matterId, Date.now()) : null);
        void this.load();
      });
    });
    // "Clerk is writing…" clears when the claim lapses, even if no newer brief arrives.
    const timer = setInterval(() => this.now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** `open`: the brief as kept, rebuilt when it is stale. */
  protected async load(): Promise<void> {
    const matterId = this.id();
    if (!matterId) return;
    const seq = ++this.seq;
    this.busy.set('open');
    this.failed.set(false);
    this.problem.set(null);
    try {
      const result = await this.api.brief({ matterId, mode: 'open' });
      if (seq !== this.seq) return;
      this.returned.set(briefFromView(result.brief));
    } catch (error) {
      if (seq !== this.seq) return;
      // A brief already showing stays; with none, say so and offer to try again.
      if (!this.shown()) {
        this.problem.set(errorCopy(error));
        this.failed.set(true);
      }
    } finally {
      if (seq === this.seq) {
        this.busy.set(null);
        this.now.set(Date.now());
      }
    }
  }

  protected async refresh(): Promise<void> {
    const matterId = this.id();
    if (!matterId || this.busy()) return;
    const seq = ++this.seq;
    this.busy.set('refresh');
    this.problem.set(null);
    this.announcement.set('Clerk is writing a fresh brief…');
    try {
      const result = await this.api.brief({ matterId, mode: 'refresh' });
      if (seq !== this.seq) return;
      this.returned.set(briefFromView(result.brief));
      this.announcement.set(result.brief.source === 'clerk' ? 'Clerk’s brief is ready.' : 'The brief is up to date.');
    } catch (error) {
      if (seq !== this.seq) return;
      this.problem.set(errorCodeOf(error) === 'RATE_LIMITED' ? this.limitCopy : errorCopy(error));
      this.announcement.set('');
    } finally {
      if (seq === this.seq) {
        this.busy.set(null);
        this.now.set(Date.now());
      }
    }
  }

  protected ask(): void {
    this.panel.show();
  }

  /** A source opens where the record lives: its tab, a document's page, or the suggestions card. */
  protected open(event: CitationOpenEvent): void {
    const matterId = this.id();
    const at = event.documentId.indexOf(':');
    if (!matterId || at < 0) return;
    const kind = event.documentId.slice(0, at) as BriefRefKind;
    const id = event.documentId.slice(at + 1);
    if (kind === 'suggestion') {
      this.document
        .getElementById('mt-ov-suggestions')
        ?.closest('section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const path = kind === 'document' ? ['documents', id] : [REF_TABS[kind]];
    void this.router.navigate(['/matters', matterId, ...path]);
  }

  protected reasonCopy(brief: BriefShown): string | null {
    if (brief.source === 'clerk' || !brief.reason || !this.canRefresh()) return null;
    return REASON_COPY[brief.reason] ?? null;
  }

  protected foot(brief: BriefShown): string {
    const when = this.written(brief.generatedAt);
    return brief.source === 'clerk'
      ? `Clerk read ${readText(brief.read)} · ${when}. Clerk can be wrong; check the sources.`
      : `Built from the matter’s deadlines, tasks and activity, not by Clerk · ${when}`;
  }

  private written(at: number): string {
    const date = new Date(at);
    const sameDay = new Date(this.now()).toDateString() === date.toDateString();
    return (sameDay ? timeFormat : dayTimeFormat).format(date);
  }
}
