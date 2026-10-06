import { ChangeDetectionStrategy, Component, computed, effect, input, output, ViewEncapsulation } from '@angular/core';
import { injectTooltipContext, injectTooltipTriggerState, NgpTooltip, NgpTooltipTrigger } from 'ng-primitives/tooltip';

import { truncateQuote } from '@materia/domain';

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
  /** The cited document version (AI-05: the viewer opens that version). */
  version?: number | undefined;
  page?: number | undefined;
  /** The cited passage, shown on hover and focus (long ones cut; the viewer shows it whole). */
  quote?: string | undefined;
  kind?: CitationKind | undefined;
  /**
   * `removed`: the document was deleted ("Removed document"; the quote still shows). `restricted`:
   * the viewer can't open it (privileged): "Restricted source", no preview, no `open`.
   */
  state?: 'available' | 'removed' | 'restricted' | undefined;
  /**
   * `false`: verification (AI-05) didn't find the quote on the cited page. Containers
   * (`mt-clerk-message`, `mt-suggestion`) never show such a citation.
   */
  verified?: boolean | undefined;
}

/** What `open` emits: enough for the citation viewer (AI-05) to open the document at the passage. */
export interface CitationOpenEvent {
  documentId: string;
  /** The citation's marker number, when it has one (the viewer steps through the others with [ and ]). */
  n?: number | undefined;
  version?: number | undefined;
  page?: number | undefined;
  quote?: string | undefined;
}

/** The longest quote a chip's preview shows; the citation viewer shows the whole passage. */
export const CITATION_PREVIEW_MAX = 240;

/** The citations a container shows: verification failures are dropped (AI-05). */
export const shownCitations = <T extends Pick<CitationVm, 'verified'>>(citations: readonly T[]): T[] =>
  citations.filter((citation) => citation.verified !== false);

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
    <q>{{ quote() }}</q>
    <span class="src"
      >{{ context().state === 'removed' ? 'Removed document' : context().label }}
      @if (context().page) {
        · p {{ context().page }}
      }
    </span>
  `,
})
export class MtCitationPreview {
  protected readonly context = injectTooltipContext<CitationVm>();
  protected readonly quote = computed(() => truncateQuote(this.context().quote ?? '', CITATION_PREVIEW_MAX));
}

/**
 * Citation (`mt-citation`): a chip naming a cited source ("Will · cl. 6"). Activating it emits `open`
 * with the document, version, page and quote; hovering or focusing shows the quote (a long one cut
 * short). A removed document reads "Removed document" with the start of the quote, and still
 * previews it; a privileged one the viewer can't see reads "Restricted source", with no preview.
 * Neither opens.
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
    if (this.state() === 'removed')
      return citation.quote ? `Removed document: “${truncateQuote(citation.quote, 48)}”` : 'Removed document';
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
      // A removed document's quote stays readable; a restricted source shows nothing of itself.
      const preview = this.state() !== 'restricted' && !!citation.quote;
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
    const { documentId, n, version, page, quote } = this.citation();
    this.open.emit({ documentId, n, version, page, quote });
  }
}
