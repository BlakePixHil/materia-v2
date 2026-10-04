import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, ViewEncapsulation } from '@angular/core';

import { type CitationOpenEvent, type CitationVm, MtCitation } from './citation';
import { MtClerkMark } from './clerk-mark';
import { citedRefs, type MdInline, parseMarkdown } from './markdown';
import { MtButton } from '../button/button';
import { MtIcon } from '../icon/icon';

export type ClerkMessageState = 'streaming' | 'done' | 'stopped' | 'error';

/**
 * ClerkMessage (`mt-clerk-message`): one of Clerk's answers, with the Clerk mark. `content` is Markdown
 * (streamed in as it arrives) parsed by the safe subset in `markdown.ts`, so no model HTML is ever
 * rendered. `[1]` markers become superscripts linked to the Citation chips below the answer.
 *
 * States: `streaming` shows a caret and marks the answer busy; `stopped` notes that the answer is
 * partial; `error` shows the message and a Retry button (`retry`). Actions ("Draft advice") are
 * projected and shown once the answer is done.
 */
@Component({
  selector: 'mt-clerk-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/msg.css',
    '../../generated/components/cites.css',
    '../../generated/components/caret.css',
  ],
  imports: [NgTemplateOutlet, MtClerkMark, MtCitation, MtButton, MtIcon],
  host: {
    class: 'mt-msg',
    'data-role': 'clerk',
    role: 'article',
    'aria-label': 'Clerk',
    '[attr.aria-busy]': 'state() === "streaming"',
    '[attr.data-state]': 'state()',
  },
  template: `
    <mt-clerk-mark />
    <div class="body">
      @for (block of blocks(); track $index; let last = $last) {
        @switch (block.type) {
          @case ('paragraph') {
            <p>
              <ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" />
              @if (last) {
                <ng-container *ngTemplateOutlet="caret" />
              }
            </p>
          }
          @case ('heading') {
            <p>
              <b><ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" /></b>
              @if (last) {
                <ng-container *ngTemplateOutlet="caret" />
              }
            </p>
          }
          @case ('quote') {
            <blockquote>
              <ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" />
              @if (last) {
                <ng-container *ngTemplateOutlet="caret" />
              }
            </blockquote>
          }
          @case ('code') {
            <pre><code>{{ block.text }}</code>@if (last) {<ng-container *ngTemplateOutlet="caret" />}</pre>
          }
          @case ('list') {
            @if (block.ordered) {
              <ol>
                @for (item of block.items; track $index; let lastItem = $last) {
                  <li>
                    <ng-container *ngTemplateOutlet="inline; context: { $implicit: item }" />
                    @if (last && lastItem) {
                      <ng-container *ngTemplateOutlet="caret" />
                    }
                  </li>
                }
              </ol>
            } @else {
              <ul>
                @for (item of block.items; track $index; let lastItem = $last) {
                  <li>
                    <ng-container *ngTemplateOutlet="inline; context: { $implicit: item }" />
                    @if (last && lastItem) {
                      <ng-container *ngTemplateOutlet="caret" />
                    }
                  </li>
                }
              </ul>
            }
          }
        }
      } @empty {
        @if (state() === 'streaming') {
          <p><ng-container *ngTemplateOutlet="caret" /></p>
        }
      }

      @if (state() === 'stopped') {
        <p class="mt-msg-note"><mt-icon name="info" [size]="14" />Stopped. This answer is incomplete.</p>
      }
      @if (state() === 'error') {
        <p class="mt-msg-note" data-tone="danger" role="alert">
          <mt-icon name="alert" [size]="14" />{{ error() ?? 'Clerk couldn’t finish this answer.' }}
        </p>
        <div class="mt-row"><button mtButton size="sm" (click)="retry.emit()">Retry</button></div>
      }

      @if (shownCitations().length) {
        <div class="mt-cites" role="group" aria-label="Sources">
          @for (citation of shownCitations(); track citation.n ?? citation.documentId) {
            <mt-citation [citation]="citation" (open)="citationOpen.emit($event)" />
          }
        </div>
      }
      @if (state() === 'done') {
        <div class="mt-row mt-wrap mt-msg-actions"><ng-content /></div>
      }
    </div>

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
            <a [href]="node.href" target="_blank" rel="noopener noreferrer"
              ><ng-container *ngTemplateOutlet="inline; context: { $implicit: node.children }"
            /></a>
          }
          @case ('cite') {
            <sup><span class="mt-sr">Sources </span>{{ refsText(node) }}</sup>
          }
        }
      }
    </ng-template>
    <ng-template #caret>
      @if (state() === 'streaming') {
        <span class="mt-caret" aria-hidden="true"></span>
      }
    </ng-template>
  `,
})
export class MtClerkMessage {
  /** The answer as Markdown; grows while streaming. */
  readonly content = input('');
  readonly citations = input<readonly CitationVm[]>([]);
  readonly state = input<ClerkMessageState>('done');
  /** Shown in the error state. */
  readonly error = input<string>();

  readonly retry = output();
  readonly citationOpen = output<CitationOpenEvent>();

  protected readonly blocks = computed(() => parseMarkdown(this.content(), this.state() === 'streaming'));
  /** Citations used in the text so far, in order; all of them once the answer is done. */
  protected readonly shownCitations = computed(() => {
    const all = this.citations();
    if (this.state() !== 'streaming') return all;
    const used = new Set(citedRefs(this.blocks()));
    return all.filter((citation) => citation.n === undefined || used.has(citation.n));
  });

  protected refsText(node: MdInline): string {
    return node.type === 'cite' ? node.refs.join(' ') : '';
  }
}

/** A message from the person asking (`mt-user-message`), right-aligned. */
@Component({
  selector: 'mt-user-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/msg.css',
  host: { class: 'mt-msg', 'data-role': 'user', role: 'article', 'aria-label': 'You' },
  template: `<ng-content />`,
})
export class MtUserMessage {}
