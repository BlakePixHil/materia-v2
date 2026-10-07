import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { LEGAL_DOCUMENTS, legalDocument, type LegalDocumentKey } from '@materia/domain';
import { MtNote } from '@materia/ui';

import { LEGAL_CONTENT } from './legal-content.generated';
import { parseLegalMarkdown } from './legal-markdown';
import { DRAFT_NOTICE_TEXT, versionLine } from './legal-meta';
import { MtLegalProse } from './legal-prose';

/**
 * A legal document (`/legal/<key>`, SEC-01): its title, version and effective date, a notice while
 * it's a draft, then its text (compiled from docs/compliance) and the other documents. Public,
 * signed in or not. The route's `data.legalKey` names the document.
 */
@Component({
  selector: 'mt-legal-document-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MtNote, MtLegalProse],
  host: { class: 'mt-legal-document' },
  template: `
    @if (doc(); as doc) {
      <header class="mt-auth-head">
        <a class="mt-legal-back label" routerLink="/legal">Legal</a>
        <h1 class="title-l">{{ doc.title }}</h1>
        <p>{{ versionLine(doc) }}</p>
      </header>
      @if (doc.status === 'draft') {
        <mt-note tone="warning"><b>Draft — not yet reviewed.</b> {{ draftNotice }}</mt-note>
      }
      <mt-legal-prose [blocks]="blocks()" />
      <nav class="mt-legal-others" aria-label="Other legal documents">
        <h2 class="heading">Other legal documents</h2>
        <ul>
          @for (other of others(); track other.key) {
            <li>
              <a [routerLink]="['/legal', other.key]">{{ other.title }}</a>
            </li>
          }
        </ul>
      </nav>
    }
  `,
  styles: `
    .mt-legal-back {
      align-self: flex-start;
      color: var(--text-brand);
      text-underline-offset: 2px;
    }
    .mt-legal-others {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
      padding-top: 16px;
      border-top: 1px solid var(--border-default);
    }
    .mt-legal-others h2 {
      margin: 0;
    }
    .mt-legal-others ul {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 20px;
    }
    .mt-legal-others a {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      color: var(--text-brand);
      text-underline-offset: 2px;
    }
  `,
})
export class LegalDocumentPage {
  private readonly key = toSignal(
    inject(ActivatedRoute).data.pipe(map((data) => data['legalKey'] as LegalDocumentKey)),
    { requireSync: true },
  );

  protected readonly doc = computed(() => legalDocument(this.key()));
  protected readonly blocks = computed(() => parseLegalMarkdown(LEGAL_CONTENT[this.key()] ?? ''));
  protected readonly others = computed(() => LEGAL_DOCUMENTS.filter((doc) => doc.key !== this.key()));
  protected readonly draftNotice = DRAFT_NOTICE_TEXT;
  protected readonly versionLine = versionLine;
}
