import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LEGAL_DOCUMENTS } from '@materia/domain';
import { MtNote } from '@materia/ui';

import { versionLine } from './legal-meta';

/** `/legal` (SEC-01): every published legal document, from the registry. Public, signed in or not. */
@Component({
  selector: 'mt-legal-index-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MtNote],
  host: { class: 'mt-legal-index' },
  template: `
    <header class="mt-auth-head">
      <h1 class="title-l">Legal</h1>
      <p>How Materia handles personal information, and the terms a practice agrees to when it uses Materia.</p>
    </header>
    @if (anyDraft) {
      <mt-note tone="warning">
        <b>Draft — not yet reviewed.</b> These documents are drafts and haven’t been reviewed by a lawyer yet.
      </mt-note>
    }
    <ul class="mt-legal-index-list">
      @for (doc of documents; track doc.key) {
        <li>
          <a class="heading" [routerLink]="['/legal', doc.key]">{{ doc.title }}</a>
          <p class="body">{{ doc.summary }}</p>
          <p class="caption">
            {{ versionLine(doc) }}
            @if (doc.status === 'draft') {
              · Draft
            }
          </p>
        </li>
      }
    </ul>
  `,
  styles: `
    .mt-legal-index-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .mt-legal-index-list li {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 14px 0;
      border-top: 1px solid var(--border-default);
    }
    .mt-legal-index-list li:last-child {
      padding-bottom: 0;
    }
    .mt-legal-index-list a {
      align-self: flex-start;
      color: var(--text-brand);
      text-underline-offset: 2px;
    }
    .mt-legal-index-list p {
      margin: 0;
      color: var(--text-secondary);
    }
  `,
})
export class LegalIndexPage {
  protected readonly documents = LEGAL_DOCUMENTS;
  protected readonly anyDraft = LEGAL_DOCUMENTS.some((doc) => doc.status === 'draft');
  protected readonly versionLine = versionLine;
}
