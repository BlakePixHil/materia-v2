import { ChangeDetectionStrategy, Component, computed, input, output, signal, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ResourceStatus } from '@materia/data-access/repository';
import { MtButton, MtDeadlineChip, MtEmptyState, MtIcon, MtNote, MtSearchField, MtSkeleton } from '@materia/ui';

import type { MatterRow } from './matters-view';
import { resultPage, type CommandResult } from '../../core/commands/command-registry';
import { recentMatters } from '../../core/matters/recent-matters';
import { MtPageOfflineNote } from '../../core/pwa/offline-banner';
import { SearchResults } from '../../core/search/search-providers';

/** The phone list shows a few recents above the view: the rest are a search away. */
const RECENTS_SHOWN = 5;

type SearchState =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'done'; query: string; results: readonly CommandResult[]; more: boolean }
  | { status: 'error'; query: string };

/**
 * Matters on a phone (MOB-02): search first, by number, title or client (⌘K's matters search,
 * CORE-15), then the matters I opened lately, then the page's view ("My open matters" by default)
 * as rows a thumb can hit. The filters, grouping, bulk actions and board stay on bigger screens.
 */
@Component({
  selector: 'mt-phone-matters',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/mrow.css',
    '../../../../../../libs/ui/src/generated/components/mgroup.css',
  ],
  imports: [
    RouterLink,
    MtButton,
    MtDeadlineChip,
    MtEmptyState,
    MtIcon,
    MtNote,
    MtPageOfflineNote,
    MtSearchField,
    MtSkeleton,
  ],
  host: { class: 'mt-phone-matters' },
  template: `
    <div class="search" role="search">
      <mt-search-field
        label="Search matters"
        placeholder="Number, title or client"
        icon="search"
        [debounce]="250"
        (queryChange)="find($event)"
      />
    </div>

    @switch (search().status) {
      @case ('idle') {
        @if (recents().length) {
          <section aria-labelledby="phone-matters-recent">
            <h2 class="mt-mgroup" id="phone-matters-recent">Recent</h2>
            @for (matter of recents(); track matter.id) {
              <a class="mt-mrow" data-recent [routerLink]="['/matters', matter.id]">
                <span class="dot" [style.background]="'var(--matter-' + matter.type + ')'"></span>
                <span class="mt-grow">
                  <span class="tt mt-ell">{{ matter.title }}</span>
                  <span class="ts mono">{{ matter.number }}</span>
                </span>
                <mt-icon class="chev" name="chevron-right" />
              </a>
            }
          </section>
        }

        <section aria-labelledby="phone-matters-view">
          <h2 class="mt-mgroup" id="phone-matters-view">{{ heading() }}</h2>
          @switch (status()) {
            @case ('error') {
              <mt-note tone="danger">
                {{ error() }}
                <button mtButton size="sm" (click)="retry.emit()">Try again</button>
              </mt-note>
            }
            @case ('offline') {
              <mt-note role="status" mtPageOfflineNote
                >You’re offline. These are the matters as they were when you were last connected.</mt-note
              >
            }
            @case ('loading') {
              <mt-skeleton variant="lines" label="Loading matters…" [count]="6" />
            }
          }
          @if (status() === 'ready' || status() === 'offline') {
            @for (row of rows(); track row.id) {
              <a class="mt-mrow" data-matter [routerLink]="['/matters', row.id]">
                <span class="dot" [style.background]="'var(--matter-' + row.type + ')'"></span>
                <span class="mt-grow">
                  <span class="tt mt-ell">{{ row.title }}</span>
                  <span class="ts mono">{{ row.number }}</span>
                </span>
                @if (row.nextDeadline; as next) {
                  <mt-deadline-chip [due]="next.dueDate" [critical]="next.critical" [trace]="next.title" />
                } @else {
                  <mt-icon class="chev" name="chevron-right" />
                }
              </a>
            } @empty {
              <mt-empty-state
                icon="matters"
                [title]="filtered() ? 'No matters in this view' : 'No matters yet'"
                [description]="
                  filtered()
                    ? 'Search for any matter above, or open Matters on a bigger screen to change the view.'
                    : 'Matters you open, from intake to grant, show here.'
                "
                [headingLevel]="3"
              />
            }
            @if (hasMore()) {
              <button mtButton size="sm" class="more" [loading]="loadingMore()" (click)="more.emit()">
                Show more matters
              </button>
            }
          }
        </section>
      }
      @case ('searching') {
        <mt-skeleton variant="lines" label="Searching matters…" [count]="3" />
      }
      @case ('error') {
        <mt-note tone="danger" role="alert"
          >Couldn’t search matters just now. Check your connection and try again.</mt-note
        >
      }
      @case ('done') {
        <section aria-labelledby="phone-matters-results">
          <h2 class="mt-mgroup" id="phone-matters-results">Matters</h2>
          @for (result of results(); track result.id) {
            <a class="mt-mrow" data-result [href]="result.href" (click)="open($event, result)">
              <mt-icon name="matters" />
              <span class="mt-grow">
                <span class="tt mt-ell">{{ result.title }}</span>
                <span class="ts mono">{{ result.meta }}</span>
              </span>
              <mt-icon class="chev" name="chevron-right" />
            </a>
          } @empty {
            <mt-empty-state
              icon="search"
              title="No matters match"
              [description]="
                'Nothing matches “' + query() + '”. Try a matter number, a surname or a word from the title.'
              "
              [headingLevel]="3"
            />
          }
          @if (moreResults()) {
            <p class="caption t-3 hint">Showing the best few. Type more to narrow it down.</p>
          }
        </section>
      }
    }
    <p class="mt-sr" role="status">{{ announcement() }}</p>
  `,
  styles: `
    .mt-phone-matters {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-phone-matters .search {
      position: sticky;
      top: calc(52px + env(safe-area-inset-top, 0px));
      z-index: 2;
      margin: 0 calc(-1 * var(--space-16));
      padding: var(--space-4) var(--space-16) var(--space-8);
      background: var(--bg-surface);
    }
    .mt-phone-matters .search .mt-input {
      width: 100%;
    }
    .mt-phone-matters .dot {
      flex: none;
      width: 10px;
      height: 10px;
      border-radius: 3px;
    }
    .mt-phone-matters .mt-mrow .mt-grow {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .mt-phone-matters .ts.mono {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .mt-phone-matters .more {
      align-self: center;
      margin-top: var(--space-12);
    }
    .mt-phone-matters section {
      display: flex;
      flex-direction: column;
    }
    .mt-phone-matters .hint {
      margin: var(--space-8) 0 0;
    }
  `,
})
export class PhoneMatters {
  /** The page's view, filtered and sorted. */
  readonly rows = input.required<readonly MatterRow[]>();
  readonly status = input.required<ResourceStatus>();
  /** The view's name ("My open matters"). */
  readonly heading = input.required<string>();
  /** The view has filters, so "nothing here" isn't "no matters at all". */
  readonly filtered = input(false);
  readonly error = input('');
  readonly hasMore = input(false);
  readonly loadingMore = input(false);
  readonly more = output();
  readonly retry = output();

  private readonly recent = recentMatters();
  protected readonly recents = computed(() => this.recent.items().slice(0, RECENTS_SHOWN));
  private readonly provider = new SearchResults().providers[0];

  protected readonly search = signal<SearchState>({ status: 'idle' });
  protected readonly query = computed(() => {
    const state = this.search();
    return state.status === 'idle' ? '' : state.query;
  });
  protected readonly results = computed(() => {
    const state = this.search();
    return state.status === 'done' ? state.results : [];
  });
  protected readonly moreResults = computed(() => {
    const state = this.search();
    return state.status === 'done' && state.more;
  });
  protected readonly announcement = computed(() => {
    const state = this.search();
    if (state.status !== 'done') return '';
    const count = state.results.length;
    if (!count) return 'No matters match.';
    return count === 1 ? '1 matter found.' : `${count} matters found.`;
  });
  private controller: AbortController | null = null;

  /** Searches as the query settles; an empty query goes back to recents and the view. */
  protected async find(typed: string): Promise<void> {
    this.controller?.abort();
    const query = typed.trim();
    if (!query || !this.provider) {
      this.controller = null;
      this.search.set({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.search.set({ status: 'searching', query });
    try {
      const answer = await this.provider.search(query, controller.signal);
      if (controller.signal.aborted) return;
      const page = resultPage(answer);
      this.search.set({ status: 'done', query, results: page.results, more: !!page.more });
    } catch {
      if (!controller.signal.aborted) this.search.set({ status: 'error', query });
    }
  }

  /** Opens the matter the way ⌘K does, so it lands in my recents too. */
  protected open(event: MouseEvent, result: CommandResult): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void result.run();
  }
}
