import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { LegalBlock } from './legal-markdown';

/**
 * A legal document's text (`mt-legal-prose`, SEC-01): the blocks from `parseLegalMarkdown`, as
 * headings with ids, paragraphs, lists, quotes and tables. A wide table scrolls inside a focusable
 * region named by the heading above it, so it can be scrolled from the keyboard. Links to the app's
 * own pages stay in the app; others open in a new tab. Nothing is passed to `innerHTML`.
 */
@Component({
  selector: 'mt-legal-prose',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [NgTemplateOutlet, RouterLink],
  host: { class: 'mt-legal-prose' },
  template: `
    @for (block of blocks(); track $index) {
      @switch (block.type) {
        @case ('heading') {
          @if (block.level === 2) {
            <h2 class="title-m" [id]="block.id">
              <ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" />
            </h2>
          } @else {
            <h3 class="heading" [id]="block.id">
              <ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" />
            </h3>
          }
        }
        @case ('paragraph') {
          <p><ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" /></p>
        }
        @case ('quote') {
          <blockquote>
            @for (paragraph of block.paragraphs; track $index) {
              <p><ng-container *ngTemplateOutlet="inline; context: { $implicit: paragraph }" /></p>
            }
          </blockquote>
        }
        @case ('code') {
          <pre><code>{{ block.text }}</code></pre>
        }
        @case ('list') {
          @if (block.ordered) {
            <ol>
              @for (item of block.items; track $index) {
                <li><ng-container *ngTemplateOutlet="inline; context: { $implicit: item }" /></li>
              }
            </ol>
          } @else {
            <ul>
              @for (item of block.items; track $index) {
                <li><ng-container *ngTemplateOutlet="inline; context: { $implicit: item }" /></li>
              }
            </ul>
          }
        }
        @case ('table') {
          <div
            class="mt-legal-table"
            role="region"
            tabindex="0"
            [attr.aria-labelledby]="block.labelledBy"
            [attr.aria-label]="block.labelledBy ? null : 'Table'"
          >
            <table>
              <thead>
                <tr>
                  @for (cell of block.header; track $index) {
                    <th scope="col">
                      <ng-container *ngTemplateOutlet="inline; context: { $implicit: cell }" />
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of block.rows; track $index) {
                  <tr>
                    @for (cell of row; track $index) {
                      <td><ng-container *ngTemplateOutlet="inline; context: { $implicit: cell }" /></td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    }

    <ng-template #inline let-nodes>
      @for (node of nodes; track $index) {
        @switch (node.type) {
          @case ('text') {
            <ng-container>{{ node.text }}</ng-container>
          }
          @case ('strong') {
            <b><ng-container *ngTemplateOutlet="inline; context: { $implicit: node.children }" /></b>
          }
          @case ('em') {
            <i><ng-container *ngTemplateOutlet="inline; context: { $implicit: node.children }" /></i>
          }
          @case ('code') {
            <code>{{ node.text }}</code>
          }
          @case ('link') {
            @if (node.href.startsWith('/')) {
              <a [routerLink]="node.href"
                ><ng-container *ngTemplateOutlet="inline; context: { $implicit: node.children }"
              /></a>
            } @else {
              <a [href]="node.href" target="_blank" rel="noopener noreferrer"
                ><ng-container *ngTemplateOutlet="inline; context: { $implicit: node.children }"
              /></a>
            }
          }
        }
      }
    </ng-template>
  `,
  styles: `
    .mt-legal-prose {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      min-width: 0;
      font: 400 15px/24px var(--font-sans);
      color: var(--text-primary);
      overflow-wrap: break-word;
    }
    .mt-legal-prose h2,
    .mt-legal-prose h3 {
      margin: var(--space-12) 0 0;
      scroll-margin-top: var(--space-16);
    }
    .mt-legal-prose p,
    .mt-legal-prose blockquote {
      margin: 0;
    }
    .mt-legal-prose b {
      font-weight: 600;
    }
    .mt-legal-prose ul,
    .mt-legal-prose ol {
      margin: 0;
      padding-left: 22px;
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .mt-legal-prose blockquote {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding-left: var(--space-12);
      border-left: 2px solid var(--border-strong);
      color: var(--text-secondary);
    }
    .mt-legal-prose code {
      padding: 1px 4px;
      border-radius: var(--radius-xs);
      background: var(--bg-sunken);
      font: 500 13px/1 var(--font-mono);
      overflow-wrap: anywhere;
    }
    .mt-legal-prose pre {
      margin: 0;
      padding: var(--space-8) var(--space-12);
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
      font: 400 13px/20px var(--font-mono);
      white-space: pre-wrap;
    }
    .mt-legal-prose pre code {
      padding: 0;
      background: none;
      font: inherit;
    }
    .mt-legal-prose a {
      color: var(--text-brand);
      text-underline-offset: 2px;
    }
    .mt-legal-table {
      overflow-x: auto;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
    }
    .mt-legal-table:focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }
    .mt-legal-table table {
      width: 100%;
      min-width: 640px;
      border-collapse: collapse;
      font: 400 14px/20px var(--font-sans);
    }
    .mt-legal-table th,
    .mt-legal-table td {
      padding: var(--space-8) var(--space-12);
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--border-default);
    }
    .mt-legal-table th {
      background: var(--bg-sunken);
      font-weight: 600;
    }
    .mt-legal-table tbody tr:last-child td {
      border-bottom: 0;
    }
  `,
})
export class MtLegalProse {
  /** The document's blocks (`parseLegalMarkdown`). */
  readonly blocks = input.required<readonly LegalBlock[]>();
}
