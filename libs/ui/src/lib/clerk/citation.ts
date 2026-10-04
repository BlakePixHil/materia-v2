import { ChangeDetectionStrategy, Component, computed, effect, input, output, ViewEncapsulation } from '@angular/core';
import { injectTooltipContext, injectTooltipTriggerState, NgpTooltip, NgpTooltipTrigger } from 'ng-primitives/tooltip';

import type { MtIconName } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { MT_TOOLTIP_DELAY_MS } from '../tooltip/tooltip';

export type CitationKind = 'document' | 'law' | 'email' | 'record';

/** A source Clerk cites. */
export interface CitationVm {
  /** The marker number used in the answer (`[1]`). */
  n?: number | undefined;
  documentId: string;
  /** Document name and pinpoint, such as "Will · cl. 6". */
  label: string;
  page?: number | undefined;
  /** The cited passage, shown on hover and focus. */
  quote?: string | undefined;
  kind?: CitationKind | undefined;
  /** `removed`: the document was deleted. `restricted`: the viewer can't open it (privileged). */
  state?: 'available' | 'removed' | 'restricted' | undefined;
}

/** What `open` emits: enough for the citation viewer (AI-05) to open the document at the passage. */
export interface CitationOpenEvent {
  documentId: string;
  page?: number | undefined;
  quote?: string | undefined;
}

const KIND_ICONS: Record<CitationKind, MtIconName> = {
  document: 'document',
  law: 'scale',
  email: 'mail',
  record: 'archive',
};

/** The hover preview: the quoted passage and where it is from. */
@Component({
  selector: 'mt-citation-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/cite.css',
  hostDirectives: [NgpTooltip],
  host: { class: 'mt-cite-preview' },
  template: `
    <q>{{ context().quote }}</q>
    <span class="src"
      >{{ context().label }}
      @if (context().page) {
        · p {{ context().page }}
      }
    </span>
  `,
})
export class MtCitationPreview {
  protected readonly context = injectTooltipContext<CitationVm>();
}

/**
 * Citation (`mt-citation`): a chip naming a cited source ("Will · cl. 6"). Activating it emits `open`
 * with the document, page and quote; hovering or focusing shows the quote. A removed document reads
 * "Removed document" and a privileged one "Restricted source", with no preview and no `open`.
 */
@Component({
  selector: 'mt-citation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/cite.css',
  imports: [MtIcon],
  hostDirectives: [NgpTooltipTrigger],
  host: {
    class: 'mt-cite',
    role: 'button',
    tabindex: '0',
    '[attr.data-state]': 'state() === "available" ? null : state()',
    '[attr.aria-disabled]': 'state() === "available" ? null : "true"',
    '[attr.aria-label]': 'accessibleName()',
    '(click)': 'activate()',
    '(keydown.enter)': 'activate()',
    '(keydown.space)': '$event.preventDefault(); activate()',
  },
  template: `
    @if (citation().n !== undefined) {
      <span class="n" aria-hidden="true">{{ citation().n }}</span>
    } @else {
      <mt-icon [name]="icon()" />
    }
    <span class="mt-ell" aria-hidden="true">{{ text() }}</span>
  `,
})
export class MtCitation {
  readonly citation = input.required<CitationVm>();
  readonly open = output<CitationOpenEvent>();

  protected readonly state = computed(() => this.citation().state ?? 'available');
  protected readonly icon = computed<MtIconName>(() =>
    this.state() === 'restricted' ? 'shield' : KIND_ICONS[this.citation().kind ?? 'document'],
  );
  protected readonly text = computed(() => {
    const citation = this.citation();
    if (this.state() === 'restricted') return 'Restricted source';
    if (this.state() === 'removed') return `${citation.label} (removed document)`;
    return citation.page && !citation.label.includes(' p ') ? `${citation.label} p ${citation.page}` : citation.label;
  });
  protected readonly accessibleName = computed(() => {
    const n = this.citation().n;
    return `${n === undefined ? 'Source' : `Source ${n}`}: ${this.text()}`;
  });

  constructor() {
    const trigger = injectTooltipTriggerState();
    effect(() => {
      const state = trigger();
      const citation = this.citation();
      const preview = this.state() === 'available' && !!citation.quote;
      state.setTooltip(MtCitationPreview);
      state.setContext(citation);
      state.setDisabled(!preview);
      state.setPlacement('top');
      state.setShowDelay(MT_TOOLTIP_DELAY_MS);
      state.setOffset(6);
    });
  }

  protected activate(): void {
    if (this.state() !== 'available') return;
    const { documentId, page, quote } = this.citation();
    this.open.emit({ documentId, page, quote });
  }
}
