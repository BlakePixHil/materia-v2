import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  ViewEncapsulation,
} from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { injectDialogRef } from 'ng-primitives/dialog';

import { can, OrgContext } from '@materia/data-access';
import { matterSuggestionsRepository } from '@materia/data-access/repository';
import { canAcceptSuggestion } from '@materia/domain';
import { MT_ORG_TIMEZONE, MT_TODAY, MtDialog, MtNote } from '@materia/ui';

import { notificationTime } from '../../core/notifications/notification-view';
import { SuggestionCard, type SuggestionResolved } from '../suggestions/suggestion-card';
import { isExpired, type SuggestionRecord } from '../suggestions/suggestion-view';

/** What became of a suggestion someone already decided ("Already accepted by Priya Shah (Mon 5 Oct)"). */
const DECIDED: Record<string, { mine: string; theirs: string }> = {
  accepted: { mine: 'You accepted it', theirs: 'Already accepted by' },
  edited: { mine: 'You accepted it with changes', theirs: 'Already accepted with changes by' },
  dismissed: { mine: 'You dismissed it', theirs: 'Already dismissed by' },
};

/**
 * A Clerk suggestion reviewed from the Inbox (CORE-22a): the notification's suggestion, live, as
 * AI-07's `mt-suggestion-card` with the same Accept, Edit and Dismiss as the matter Overview. One
 * already decided says who decided it (or that it expired); one that was removed, or that I can no
 * longer read (privileged, or the matter's access changed), is no longer available.
 */
@Component({
  selector: 'mt-inbox-suggestion',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtNote, SuggestionCard],
  host: { class: 'mt-inbox-suggestion' },
  template: `
    @switch (state()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading the suggestion…</p>
      }
      @case ('gone') {
        <mt-note tone="warning" icon="lock">
          No longer available. The suggestion was removed, or you can’t see it any more.
        </mt-note>
      }
      @default {
        @if (item(); as record) {
          @if (decided(); as text) {
            <mt-note class="decided" icon="check">{{ text }}</mt-note>
          }
          <mt-suggestion-card
            [item]="record"
            [matterId]="matterId()"
            [expired]="expired()"
            [canAccept]="mayAccept()"
            [canDismiss]="canUse()"
            (resolved)="resolved.emit($event)"
          />
        }
      }
    }
  `,
  styles: `
    .mt-inbox-suggestion {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
  `,
})
export class InboxSuggestion {
  readonly matterId = input.required<string>();
  readonly suggestionId = input.required<string>();
  /** Member display names by uid, to say who decided it. */
  readonly names = input<ReadonlyMap<string, string>>(new Map());

  readonly resolved = output<SuggestionResolved>();

  private readonly context = inject(OrgContext);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly today = inject(MT_TODAY);
  protected readonly canUse = can('clerk.use');

  private readonly doc = matterSuggestionsRepository(() => this.matterId()).watch(() => this.suggestionId());

  protected readonly item = computed<SuggestionRecord | null>(() => this.doc.value());
  protected readonly state = computed<'loading' | 'gone' | 'ready'>(() => {
    if (this.doc.error()) return 'gone';
    if (this.doc.status() === 'loading' && !this.item()) return 'loading';
    return this.item() ? 'ready' : this.doc.exists() ? 'loading' : 'gone';
  });
  protected readonly expired = computed(() => {
    const item = this.item();
    return !!item && isExpired(item, Date.now());
  });

  protected readonly decided = computed(() => {
    const item = this.item();
    if (!item) return null;
    if (this.expired()) return 'Expired before anyone decided.';
    const copy = DECIDED[item.status];
    if (!copy) return null;
    const by = item.resolvedBy;
    const when = item.resolvedAt ? ` (${notificationTime(item.resolvedAt, this.timeZone, this.today())})` : '';
    if (by && by === this.context.uid()) return `${copy.mine}${when}.`;
    return `${copy.theirs} ${(by && this.names().get(by)) ?? 'someone else'}${when}.`;
  });

  /** clerk.use, the kind's underlying action, and privileged.view for a privileged one. */
  protected readonly mayAccept = computed(() => {
    const role = this.context.role();
    const item = this.item();
    return !!role && !!item && this.canUse() && canAcceptSuggestion(role, item.kind, item.privileged);
  });
}

/** What the narrow-screen review dialog needs. */
export interface InboxSuggestionDialogData {
  matterId: string;
  suggestionId: string;
  names: ReadonlyMap<string, string>;
}

/**
 * The review on a narrow screen, where there's no detail pane (CORE-22a): the suggestion in a
 * dialog that closes with what happened to it, or when a citation leads elsewhere.
 */
@Component({
  selector: 'mt-inbox-suggestion-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [InboxSuggestion, MtDialog],
  template: `
    <mt-dialog title="Review suggestion">
      <mt-inbox-suggestion
        [matterId]="data.matterId"
        [suggestionId]="data.suggestionId"
        [names]="data.names"
        (resolved)="ref.close($event)"
      />
    </mt-dialog>
  `,
})
export class InboxSuggestionDialog {
  protected readonly ref = injectDialogRef<InboxSuggestionDialogData, SuggestionResolved | undefined>();
  protected readonly data = this.ref.data;

  constructor() {
    const subscription = inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationStart) void this.ref.close();
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }
}
