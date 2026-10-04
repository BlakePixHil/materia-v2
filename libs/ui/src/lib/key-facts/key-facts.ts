import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  contentChild,
  DestroyRef,
  Directive,
  inject,
  input,
  output,
  signal,
  TemplateRef,
  ViewEncapsulation,
} from '@angular/core';

import { MtIconButton } from '../icon-button/icon-button';

/** One fact in KeyFacts. */
export interface KeyFactVm {
  /** Stable key, such as `dateOfDeath`. */
  id: string;
  label: string;
  value: string;
  /** Show a copy button (default true when there is a value). */
  copyable?: boolean | undefined;
  /** Where Clerk found the value; rendered by the `mtFactCitation` template ("Will p3"). */
  citation?: { label: string; href?: string | undefined } | undefined;
}

/** Context for the `mtFactCitation` template. */
export interface MtFactCitationContext {
  $implicit: KeyFactVm;
}

/**
 * The citation marker for Clerk-sourced facts: `<ng-template mtFactCitation let-fact>…</ng-template>`.
 * Without it, KeyFacts shows the citation label as a plain chip.
 */
@Directive({ selector: 'ng-template[mtFactCitation]' })
export class MtFactCitation {
  readonly template = inject<TemplateRef<MtFactCitationContext>>(TemplateRef);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter only names the type guard
  static ngTemplateContextGuard(_dir: MtFactCitation, _ctx: unknown): _ctx is MtFactCitationContext {
    return true;
  }
}

/** How long the copy button shows its tick. */
export const MT_COPIED_MS = 1500;

/**
 * KeyFacts (`mt-key-facts`): a matter's facts as a definition list, each with a copy button. Clerk-sourced
 * values carry a citation marker (FND-11's Citation, through the `mtFactCitation` template).
 */
@Component({
  selector: 'mt-key-facts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/facts.css', '../../generated/components/cite.css'],
  imports: [MtIconButton, NgTemplateOutlet],
  host: { style: 'display: block' },
  template: `
    <dl class="mt-facts">
      @for (fact of facts(); track fact.id) {
        <dt>{{ fact.label }}</dt>
        <dd>
          <span class="mt-facts-value">{{ fact.value || empty }}</span>
          @if (fact.citation; as citation) {
            @if (citationTemplate(); as custom) {
              <ng-container *ngTemplateOutlet="custom.template; context: { $implicit: fact }" />
            } @else {
              <span class="mt-cite"><span class="mt-sr">Source: </span>{{ citation.label }}</span>
            }
          }
          @if (fact.value && fact.copyable !== false) {
            <button
              mtIconButton
              class="mt-facts-copy"
              size="sm"
              [icon]="copiedId() === fact.id ? 'check' : 'copy'"
              [label]="'Copy ' + fact.label"
              (click)="copy(fact)"
            ></button>
          }
        </dd>
      }
    </dl>
    <span class="mt-sr" aria-live="polite">{{ announcement() }}</span>
  `,
})
export class MtKeyFacts {
  readonly facts = input.required<readonly KeyFactVm[]>();
  /** A value was copied to the clipboard. */
  readonly copied = output<KeyFactVm>();

  protected readonly empty = '—';
  protected readonly citationTemplate = contentChild(MtFactCitation);
  protected readonly copiedId = signal<string | null>(null);
  protected readonly announcement = signal('');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected async copy(fact: KeyFactVm): Promise<void> {
    try {
      await navigator.clipboard.writeText(fact.value);
    } catch {
      this.announcement.set(`Couldn't copy ${fact.label}`);
      return;
    }
    this.copiedId.set(fact.id);
    this.announcement.set(`${fact.label} copied`);
    this.copied.emit(fact);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.copiedId.set(null);
      this.announcement.set('');
    }, MT_COPIED_MS);
  }
}
