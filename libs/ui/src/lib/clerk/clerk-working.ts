import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation,
} from '@angular/core';

import { MtClerkMark } from './clerk-mark';
import { MtProgress } from '../progress/progress';

/**
 * ClerkWorking (`mt-clerk-working`): Clerk is working ("Reading Westpac statement, page 3 of 6"). The
 * pulsing dots and shimmer stop under `prefers-reduced-motion` (or with `reducedMotion`), leaving a
 * static label. Steps advance with `current`; `progress` adds a bar. Announced politely.
 */
@Component({
  selector: 'mt-clerk-working',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/working.css',
    '../../generated/components/shimmer.css',
    '../../generated/components/clerk.css',
  ],
  imports: [MtClerkMark, MtProgress],
  host: { class: 'mt-col mt-clerk-working', role: 'status', '[attr.data-static]': 'reducedMotion() ? "" : null' },
  template: `
    <span class="mt-working">
      <mt-clerk-mark size="xs" />
      <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="mt-shimmer">{{ text() }}</span>
    </span>
    @if (steps().length > 1) {
      <ol class="mt-working-steps" aria-label="Steps">
        @for (step of steps(); track $index) {
          <li
            [attr.data-state]="$index < current() ? 'done' : $index === current() ? 'current' : null"
            [attr.aria-current]="$index === current() ? 'step' : null"
          >
            {{ step }}
          </li>
        }
      </ol>
    }
    @if (progress() !== undefined) {
      <mt-progress tone="ai" [value]="progress() ?? 0" [label]="text()" />
    }
  `,
})
export class MtClerkWorking {
  /** What Clerk is doing now; defaults to the current step. */
  readonly label = input<string>();
  readonly steps = input<readonly string[]>([]);
  readonly current = input(0);
  /** 0–100, when Clerk knows how far through it is. */
  readonly progress = input<number>();
  /** Force the static, motion-free variant. */
  readonly reducedMotion = input(false, { transform: booleanAttribute });

  protected readonly text = computed(() => this.label() ?? this.steps()[this.current()] ?? 'Working…');
}
