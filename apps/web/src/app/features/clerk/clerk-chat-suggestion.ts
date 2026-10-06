import { ChangeDetectionStrategy, Component, computed, inject, input, ViewEncapsulation } from '@angular/core';

import { OrgContext } from '@materia/data-access';
import { matterSuggestionsRepository } from '@materia/data-access/repository';
import { canAcceptSuggestion, OPEN_SUGGESTION_STATUSES } from '@materia/domain';

import { SuggestionCard } from '../suggestions/suggestion-card';
import { isExpired } from '../suggestions/suggestion-view';

/**
 * One suggestion an answer proposed (AI-06), as its `mt-suggestion-card` (AI-07): accepted,
 * edited or dismissed right in the panel. Read by id; it leaves once someone resolves it, and
 * shows nothing the reader can't see.
 */
@Component({
  selector: 'mt-clerk-chat-suggestion',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [SuggestionCard],
  host: { style: 'display: contents' },
  template: `
    @if (item(); as item) {
      <mt-suggestion-card
        [item]="item"
        [matterId]="matterId()"
        [expired]="expired()"
        [canAccept]="mayAccept()"
        [canDismiss]="canUse()"
      />
    }
  `,
})
export class ClerkChatSuggestion {
  readonly suggestionId = input.required<string>();
  readonly matterId = input.required<string>();
  readonly canUse = input(false);

  private readonly context = inject(OrgContext);
  private readonly suggestion = matterSuggestionsRepository(() => this.matterId()).watch(() => this.suggestionId());

  protected readonly item = computed(() => {
    const item = this.suggestion.value();
    return item && (OPEN_SUGGESTION_STATUSES as readonly string[]).includes(item.status) ? item : null;
  });
  protected readonly expired = computed(() => {
    const item = this.item();
    return !!item && isExpired(item, Date.now());
  });
  protected readonly mayAccept = computed(() => {
    const item = this.item();
    const role = this.context.role();
    return !!item && !!role && canAcceptSuggestion(role, item.kind, item.privileged);
  });
}
