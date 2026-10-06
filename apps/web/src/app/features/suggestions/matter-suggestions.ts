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
import { FormsModule } from '@angular/forms';

import { can, OrgContext } from '@materia/data-access';
import {
  matterSuggestionsRepository,
  openSuggestionsQuery,
  suggestionCallables,
} from '@materia/data-access/repository';
import {
  canAcceptSuggestion,
  SUGGESTION_ACCEPT_MANY_MAX,
  SUGGESTION_KIND_LABELS,
  type SuggestionKind,
} from '@materia/domain';
import { MtButton, MtClerkMark, MtSwitch, ToastService } from '@materia/ui';

import { SuggestionCard, type SuggestionResolved } from './suggestion-card';
import { bulkLabel, isExpired, type SuggestionRecord } from './suggestion-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { CitationSources } from '../citations/citation-sources';
import { CitationViewer } from '../citations/citation-viewer';
import { MatterScreen } from '../matter-detail/matter-screen';

/** A kind's open suggestions, with the bulk accept when there are several the person may accept. */
interface KindGroup {
  kind: SuggestionKind;
  /** "Task suggestions". */
  label: string;
  items: SuggestionRecord[];
  /** Ids a bulk accept takes: proposed (not stale, not expired) ones, up to the callable's limit. */
  bulkIds: string[];
}

const ORDER: Record<string, number> = { proposed: 0, stale: 1, expired: 2 };

/**
 * "Clerk suggests…" on the matter Overview (AI-07): the matter's open Clerk suggestions, grouped by
 * kind, each a `mt-suggestion-card`, with "Accept all N tasks" for a kind with several. Expired ones
 * are hidden unless "Show expired" is on. Privileged suggestions are only listed for roles with
 * `privileged.view` (the rules refuse the rest). Shown when `clerk.features.suggestions` is on and
 * the role may use Clerk; listens only while the Overview is shown. A citation opens in the
 * citation viewer side panel (AI-05), a lazy chunk.
 */
@Component({
  selector: 'mt-matter-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/card.css'],
  imports: [CitationViewer, FormsModule, MtButton, MtClerkMark, MtSwitch, SuggestionCard],
  providers: [CitationSources],
  host: { class: 'mt-matter-suggestions' },
  template: `
    @if (visible()) {
      <section class="mt-card" data-pad aria-labelledby="mt-ov-suggestions">
        <div class="mt-card-h">
          <mt-clerk-mark size="xs" />
          <h2 class="mt-card-title" id="mt-ov-suggestions">Clerk suggests…</h2>
          @if (open().length) {
            <span class="caption t-3">{{ open().length }}</span>
          }
          <span class="mt-ml">
            <mt-switch
              name="showExpired"
              label="Show expired"
              [ngModel]="showExpired()"
              (ngModelChange)="showExpired.set($event)"
            />
          </span>
        </div>
        @switch (suggestions.status()) {
          @case ('loading') {
            <p class="caption t-3" role="status">Loading suggestions…</p>
          }
          @case ('error') {
            <p class="caption t-2">{{ loadError() }}</p>
          }
          @default {
            @for (group of groups(); track group.kind) {
              <div class="group" role="group" [attr.aria-label]="group.label">
                @if (group.bulkIds.length > 1) {
                  <span class="mt-row bulk">
                    <button
                      mtButton
                      variant="ghost"
                      size="sm"
                      [loading]="bulkKind() === group.kind"
                      [disabled]="!!bulkKind()"
                      (click)="acceptAll(group)"
                    >
                      {{ bulk(group.kind, group.bulkIds.length) }}
                    </button>
                  </span>
                }
                @for (item of group.items; track item.id) {
                  <mt-suggestion-card
                    [item]="item"
                    [matterId]="matterId()"
                    [expired]="expired(item)"
                    [canAccept]="mayAccept(item)"
                    [canDismiss]="canUse()"
                    [busy]="bulkKind() === group.kind"
                    (resolved)="resolved($event)"
                  />
                }
              </div>
            } @empty {
              <p class="caption t-3">No suggestions right now.</p>
            }
          }
        }
        <p class="mt-sr" aria-live="polite">{{ announcement() }}</p>
      </section>
      <!-- The citation viewer (AI-05) loads the first time a source is opened. -->
      @if (sources.viewing(); as viewing) {
        @defer (on immediate) {
          <mt-citation-viewer
            [matterId]="matterId()"
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
  styles: `
    .mt-matter-suggestions .group {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-matter-suggestions .group + .group {
      margin-top: var(--space-12);
    }
    .mt-matter-suggestions .bulk {
      justify-content: flex-end;
    }
    .mt-matter-suggestions h2 {
      margin: 0;
    }
  `,
})
export class MatterSuggestions {
  private readonly screen = inject(MatterScreen);
  private readonly flags = inject(FeatureFlagService);
  private readonly context = inject(OrgContext);
  private readonly toasts = inject(ToastService);
  private readonly api = suggestionCallables(inject(CALLABLES));
  protected readonly sources = inject(CitationSources);

  protected readonly canUse = can('clerk.use');
  protected readonly visible = computed(() => this.flags.isOn('clerk.features.suggestions') && this.canUse());
  protected readonly matterId = computed(() => this.screen.id() ?? '');
  protected readonly showExpired = signal(false);
  /** Resolved here, hidden until the listener drops them. */
  private readonly gone = signal<ReadonlySet<string>>(new Set());
  protected readonly bulkKind = signal<SuggestionKind | null>(null);
  protected readonly announcement = signal('');
  /** Re-checks expiry each minute so a suggestion past its time leaves the list. */
  private readonly now = signal(Date.now());

  protected readonly suggestions = matterSuggestionsRepository(this.screen.id).watchQuery(() =>
    this.screen.id() && this.visible()
      ? openSuggestionsQuery({
          privilegedVisible: this.screen.canPrivileged(),
          includeExpired: this.showExpired(),
        })
      : null,
  );
  protected readonly loadError = computed(() => errorCopy(this.suggestions.error()));

  private readonly rows = computed(() => {
    const gone = this.gone();
    const privileged = this.screen.canPrivileged();
    const now = this.now();
    return this.suggestions
      .value()
      .filter((item) => !gone.has(item.id) && (privileged || !item.privileged))
      .filter((item) => this.showExpired() || !isExpired(item, now))
      .sort(
        (a, b) =>
          (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
  });
  /** The ones a person can still act on. */
  protected readonly open = computed(() => this.rows().filter((item) => !this.expired(item)));

  protected readonly groups = computed<KindGroup[]>(() => {
    const byKind = new Map<SuggestionKind, SuggestionRecord[]>();
    for (const item of this.rows()) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
    return [...byKind].map(([kind, items]) => ({
      kind,
      label: `${SUGGESTION_KIND_LABELS[kind]} suggestions`,
      items,
      bulkIds: items
        .filter((item) => item.status === 'proposed' && !this.expired(item) && this.mayAccept(item))
        .slice(0, SUGGESTION_ACCEPT_MANY_MAX)
        .map((item) => item.id),
    }));
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // Forget local hides once the listener no longer returns them.
    effect(() => {
      const ids = new Set(this.suggestions.value().map((item) => item.id));
      untracked(() => {
        const gone = this.gone();
        if ([...gone].some((id) => !ids.has(id))) this.gone.set(new Set([...gone].filter((id) => ids.has(id))));
      });
    });
  }

  protected expired(item: SuggestionRecord): boolean {
    return isExpired(item, this.now());
  }

  /** clerk.use, the kind's action, and privileged.view for a privileged one; never on a deleted matter. */
  protected mayAccept(item: SuggestionRecord): boolean {
    const role = this.context.role();
    return !!role && !this.screen.deleted() && canAcceptSuggestion(role, item.kind, item.privileged);
  }

  protected bulk(kind: SuggestionKind, count: number): string {
    return bulkLabel(kind, count);
  }

  protected resolved(event: SuggestionResolved): void {
    this.hide([event.id]);
    this.announcement.set(event.outcome === 'dismissed' ? 'Suggestion dismissed' : 'Suggestion accepted');
  }

  /** Accepts a kind's proposed suggestions in one call; each has its own result. */
  protected async acceptAll(group: KindGroup): Promise<void> {
    if (this.bulkKind()) return;
    this.bulkKind.set(group.kind);
    try {
      const { results, accepted, failed } = await this.api.acceptMany({
        matterId: this.matterId(),
        suggestionIds: group.bulkIds,
      });
      this.hide(results.filter((result) => result.ok).map((result) => result.suggestionId));
      const stale = results.filter((result) => !result.ok && result.code === 'SUGGESTION_STALE').length;
      this.toasts.show({
        title: `${accepted} accepted`,
        ...(failed
          ? {
              description: stale
                ? `${stale} need a review: their data changed since Clerk suggested them.`
                : `${failed} couldn’t be accepted.`,
            }
          : {}),
        tone: failed ? 'neutral' : 'success',
      });
      this.announcement.set(`${accepted} suggestions accepted`);
    } catch (error) {
      this.toasts.show({ title: 'The suggestions weren’t accepted', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.bulkKind.set(null);
    }
  }

  private hide(ids: string[]): void {
    if (ids.length) this.gone.update((gone) => new Set([...gone, ...ids]));
  }
}
