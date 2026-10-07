import { booleanAttribute, ChangeDetectionStrategy, Component, input, output, ViewEncapsulation } from '@angular/core';

import { type CitationOpenEvent, type CitationVm, MtCitation } from './citation';
import { MtClerkMark } from './clerk-mark';
import type { MtIconName } from '../../generated/icons';
import { MtButton } from '../button/button';
import { MtIcon } from '../icon/icon';

/** One item in a Clerk brief. */
export interface BriefItemVm {
  id: string;
  icon: MtIconName;
  tone?: 'brand' | 'warning' | 'danger' | 'success' | undefined;
  /** The bold lead, usually the matter ("Nguyen v Nguyen."). */
  lead?: string | undefined;
  text: string;
  citations: readonly CitationVm[];
  /** An optional next step ("Review draft"); emitted as `action`. */
  actionLabel?: string | undefined;
}

/**
 * ClerkBrief (`mt-clerk-brief`): Clerk's summary card ("Three things need you today"), with the Clerk
 * mark, one row per item with its sources, and an optional action per item. `plain` is the same
 * card when Clerk didn't write it (a matter's template brief, AI-06c): no AI edge or glow, and an
 * icon instead of the Clerk mark. Projected content follows the list (the footer, `mt-clerk-foot`).
 */
@Component({
  selector: 'mt-clerk-brief',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/clerk.css',
    '../../generated/components/brief.css',
    '../../generated/components/cites.css',
  ],
  imports: [MtClerkMark, MtCitation, MtButton, MtIcon],
  host: {
    class: 'mt-clerk-card',
    role: 'region',
    '[attr.aria-label]': 'label()',
    '[attr.data-plain]': 'plain() ? "" : null',
  },
  template: `
    <div class="in">
      <div class="mt-clerk-head">
        @if (plain()) {
          <mt-icon name="calendar" />
        } @else {
          <mt-clerk-mark />
        }
        {{ label() }}
        <span class="mt-ml mt-row"><ng-content select="[mtBriefActions]" /></span>
      </div>
      <!-- A level-2 heading: the card sits right under the page's h1 (the matter Overview). -->
      @if (title(); as text) {
        <h2 class="mt-clerk-title">{{ text }}</h2>
      }
      <ul class="mt-brief">
        @for (item of items(); track item.id) {
          <li class="mt-brief-item">
            <mt-icon [name]="item.icon" [class]="item.tone ? 't-' + item.tone : 't-3'" />
            <div class="mt-grow mt-col">
              <div class="mt-brief-text">
                @if (item.lead) {
                  <b>{{ item.lead }}</b>
                }
                {{ item.text }}
              </div>
              @if (item.citations.length) {
                <div class="mt-cites" role="group" aria-label="Sources">
                  @for (citation of item.citations; track citation.n ?? citation.documentId) {
                    <mt-citation [citation]="citation" (open)="citationOpen.emit($event)" />
                  }
                </div>
              }
            </div>
            @if (item.actionLabel; as label) {
              <button mtButton size="sm" (click)="action.emit(item)">{{ label }}</button>
            }
          </li>
        } @empty {
          <li class="mt-brief-item mt-brief-empty">Nothing needs you right now.</li>
        }
      </ul>
      <ng-content />
    </div>
  `,
})
export class MtClerkBrief {
  /** The card's heading ("Morning brief"). */
  readonly label = input('Clerk brief');
  readonly title = input<string>();
  readonly items = input.required<readonly BriefItemVm[]>();
  /** Not written by Clerk: the plain card, without the Clerk mark. */
  readonly plain = input(false, { transform: booleanAttribute });
  readonly action = output<BriefItemVm>();
  readonly citationOpen = output<CitationOpenEvent>();
}
