import { ChangeDetectionStrategy, Component, input, ViewEncapsulation } from '@angular/core';

import { MtAvatar, type MtAvatarSize } from '../markers/markers';

/**
 * The Clerk mark (`mt-clerk-mark`): the violet sparkle avatar. Every Clerk component renders it, so
 * AI-generated content is always marked (Clerk rule 1).
 */
@Component({
  selector: 'mt-clerk-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtAvatar],
  host: { style: 'display: contents' },
  template: `<mt-avatar name="Clerk" kind="clerk" [size]="size()" />`,
})
export class MtClerkMark {
  readonly size = input<MtAvatarSize>('sm');
}
