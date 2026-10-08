import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation,
} from '@angular/core';

import { type CitationOpenEvent, type CitationVm, MtCitation, shownCitations } from './citation';
import { MtClerkMark } from './clerk-mark';
import { MtButton } from '../button/button';
import { MtIcon } from '../icon/icon';
import { MtBadge } from '../markers/markers';

/** A proposal from Clerk. Clerk proposes; a person accepts (Clerk rule 4). */
export interface SuggestionVm {
  id: string;
  /** What it would create ("Task", "Deadline", "Time entry"); shown as a badge. */
  kind: string;
  /** The proposal ("Request date-of-death valuation for 14 Ashby St"). */
  title: string;
  /** Why ("From will cl. 4(b) and the title search"). */
  rationale?: string | undefined;
  citations?: readonly CitationVm[] | undefined;
  /** The accept button's label ("Add task"); defaults to "Accept". */
  acceptLabel?: string | undefined;
  /** Who asked for it when Clerk didn't ("Suggested in Claude by Priya Shah", INT-07). */
  origin?: string | undefined;
}

/**
 * Suggestion (`mt-suggestion`): a Clerk proposal (or one a person's Claude made through the
 * connector, which `origin` names) with Accept, Edit and Dismiss. Project a preview or
 * diff as content. `stale` means the underlying data changed since Clerk suggested it: the card says
 * so and Accept becomes "Review". `canAccept`/`canDismiss` hide the actions a person can't take, and
 * `canEdit` hides Edit where the accept verb opens the proposal to check first (a letter, AI-10b).
 * Import it from `@materia/ui/suggestion` (not the barrel), so it stays out of the initial bundle.
 */
@Component({
  selector: 'mt-suggestion',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/suggestion.css', '../../generated/components/cites.css'],
  imports: [MtClerkMark, MtCitation, MtButton, MtBadge, MtIcon],
  host: {
    class: 'mt-suggestion',
    role: 'group',
    '[attr.aria-label]': 'label()',
    '[attr.data-stale]': 'stale() ? "" : null',
  },
  template: `
    <mt-clerk-mark />
    <div class="mt-grow">
      <div class="mt-suggestion-head">
        <mt-badge tone="ai">{{ suggestion().kind }}</mt-badge>
        <span class="tt">{{ suggestion().title }}</span>
      </div>
      @if (suggestion().origin; as origin) {
        <div class="ts" data-origin>{{ origin }}</div>
      }
      @if (suggestion().rationale; as why) {
        <div class="ts">{{ why }}</div>
      }
      @if (stale()) {
        <div class="mt-suggestion-stale">
          <mt-icon name="alert" [size]="14" />Data changed since suggested — review before accepting.
        </div>
      }
    </div>
    <span class="mt-row mt-suggestion-actions">
      @if (canDismiss()) {
        <button mtButton variant="ghost" size="sm" [disabled]="busy()" (click)="dismiss.emit()">Dismiss</button>
      }
      @if (canAccept()) {
        @if (canEdit()) {
          <button mtButton variant="ghost" size="sm" [disabled]="busy()" (click)="edit.emit()">Edit</button>
        }
        <button mtButton variant="clerk" size="sm" [loading]="busy()" (click)="stale() ? edit.emit() : accept.emit()">
          {{ stale() ? 'Review' : (suggestion().acceptLabel ?? 'Accept') }}
        </button>
      }
    </span>
    <div class="mt-suggestion-preview"><ng-content /></div>
    @if (citations().length) {
      <div class="mt-cites mt-suggestion-cites" role="group" aria-label="Sources">
        @for (citation of citations(); track citation.n ?? citation.documentId) {
          <mt-citation [citation]="citation" (open)="citationOpen.emit($event)" />
        }
      </div>
    }
  `,
})
export class MtSuggestion {
  readonly suggestion = input.required<SuggestionVm>();
  readonly stale = input(false, { transform: booleanAttribute });
  /** Accepting is in progress. */
  readonly busy = input(false, { transform: booleanAttribute });
  /** The person may accept (and edit) it: false hides both, e.g. for a role without the underlying action. */
  readonly canAccept = input(true, { transform: booleanAttribute });
  readonly canDismiss = input(true, { transform: booleanAttribute });
  /** Offers Edit beside Accept: false for a proposal the accept verb opens to check first (a letter, AI-10b). */
  readonly canEdit = input(true, { transform: booleanAttribute });

  readonly accept = output();
  readonly edit = output();
  readonly dismiss = output();
  readonly citationOpen = output<CitationOpenEvent>();

  protected readonly label = computed(() => {
    const { title, origin } = this.suggestion();
    return origin ? `Suggestion: ${title}. ${origin}` : `Clerk suggestion: ${title}`;
  });

  /** Its sources, without any that failed verification (AI-05). */
  protected readonly citations = computed(() => shownCitations(this.suggestion().citations ?? []));
}
