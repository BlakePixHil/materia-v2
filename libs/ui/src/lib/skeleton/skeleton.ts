import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation,
} from '@angular/core';

export type MtSkeletonVariant = 'rows' | 'lines' | 'cards' | 'fields';

const WIDTHS: Record<MtSkeletonVariant, readonly string[]> = {
  rows: ['48%', '36%', '52%', '30%', '44%', '40%'],
  lines: ['92%', '78%', '85%', '60%'],
  cards: ['70%', '58%', '64%', '52%'],
  fields: ['28%', '36%', '24%', '32%'],
};

const COUNT: Record<MtSkeletonVariant, number> = { rows: 4, lines: 3, cards: 3, fields: 3 };

/**
 * Skeleton (`mt-skeleton`): the first load of a list, card or form, as shimmering bars in the shape
 * of what is coming, so the page doesn't jump when it arrives. Refreshes keep the old content and
 * show the loading bar instead.
 *
 * - `rows` (default): list or table rows (glyph, ref, title, trailing chip). `framed` draws the card.
 * - `lines`: a few lines of text, for a small section or panel.
 * - `cards`: a grid of cards (a board, Today's matters).
 * - `fields`: a settings form (title and description, control on the right).
 *
 * It waits 150ms before fading in, so a fast load never flashes it. Screen readers hear `label`
 * ("Loading matters…") through a polite status; the bars are hidden from them. Where several
 * skeletons draw one region, give the first the label and the rest `label=""` (decorative).
 */
@Component({
  selector: 'mt-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/skel.css', '../../generated/components/skeleton.css'],
  host: {
    class: 'mt-skeleton',
    '[attr.role]': "label() ? 'status' : null",
    '[attr.aria-hidden]': "label() ? null : 'true'",
    '[attr.data-variant]': "variant() === 'rows' ? null : variant()",
    '[attr.data-framed]': "framed() ? '' : null",
  },
  template: `
    @if (label(); as text) {
      <span class="mt-sr">{{ text }}</span>
    }
    @switch (variant()) {
      @case ('lines') {
        @for (width of widths(); track $index) {
          <span class="mt-skel" aria-hidden="true" [style.width]="width"></span>
        }
      }
      @case ('cards') {
        @for (width of widths(); track $index) {
          <div class="card" aria-hidden="true">
            <span class="mt-skel" style="width: 30%"></span>
            <span class="mt-skel" style="height: 14px" [style.width]="width"></span>
            <span class="chips">
              <span class="mt-skel" data-shape="chip" style="width: 64px"></span>
              <span class="mt-skel" data-shape="chip" style="width: 48px"></span>
            </span>
          </div>
        }
      }
      @case ('fields') {
        @for (width of widths(); track $index) {
          <div class="row" aria-hidden="true">
            <span class="tx">
              <span class="mt-skel" [style.width]="width"></span>
              <span class="mt-skel" style="width: 55%"></span>
            </span>
            <span class="mt-skel" style="width: 120px; height: 28px"></span>
          </div>
        }
      }
      @default {
        @for (width of widths(); track $index) {
          <div class="row" aria-hidden="true">
            <span class="mt-skel" data-shape="circle" style="width: 14px; height: 14px"></span>
            <span class="mt-skel" style="width: 40px"></span>
            <span class="mt-skel" [style.width]="width"></span>
            <span class="mt-skel" data-shape="chip" style="width: 72px"></span>
          </div>
        }
      }
    }
  `,
})
export class MtSkeleton {
  /** What is loading, for screen readers: "Loading matters…". */
  readonly label = input('Loading…');
  readonly variant = input<MtSkeletonVariant>('rows');
  /** How many rows, lines or cards; defaults to what fills the space (4 rows, 3 of the rest). */
  readonly count = input<number>();
  /** Draw the card around `rows` or `fields`, where the loaded content sits in one. */
  readonly framed = input(false, { transform: booleanAttribute });

  protected readonly widths = computed(() => {
    const variant = this.variant();
    const pattern = WIDTHS[variant];
    const count = Math.max(1, this.count() ?? COUNT[variant]);
    return Array.from({ length: count }, (_, i) => pattern[i % pattern.length] ?? '50%');
  });
}
