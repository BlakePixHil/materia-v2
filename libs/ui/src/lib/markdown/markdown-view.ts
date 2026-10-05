import { NgTemplateOutlet } from '@angular/common';
import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { parseMarkdown } from '../clerk/markdown';
import { MtIcon } from '../icon/icon';

/** A mentioned member as the reader sees them. `former` (removed or unknown) shows as plain text. */
export interface MtMentionMember {
  name: string;
  former?: boolean;
}

/** A mentioned matter the reader can open: a chip with its number and title, linking to it. */
export interface MtMentionMatter {
  number: string;
  title: string;
  /** Router link to the matter (`/matters/m-1/overview`). */
  link: string;
}

/** A member's name by uid; null for someone not in the org (shown as "Unknown member"). */
export type MtMentionMemberResolver = (uid: string) => MtMentionMember | null;
/**
 * A matter by id: the chip, `null` when the reader can't open it ("Restricted matter"), or
 * `undefined` while it's still being looked up.
 */
export type MtMentionMatterResolver = (matterId: string) => MtMentionMatter | null | undefined;

/** The label used when the reader can't open a mentioned matter (`RESTRICTED_MATTER_LABEL` in libs/domain). */
export const MT_RESTRICTED_MATTER_LABEL = 'Restricted matter';

/**
 * Markdown (`mt-markdown`): renders Markdown (a matter note, CORE-13) with the safe subset in
 * `clerk/markdown.ts`. Nothing is passed to `innerHTML`: raw HTML stays literal text, links are
 * http(s) and mailto only and open in a new tab, and images show their alt text only. Single line
 * breaks are kept (`breaks`).
 *
 * With `mentions`, `@[uid]` and `#[matterId]` tokens render through the resolvers: a member chip
 * with their name (plain text for a former or unknown member), and a matter chip with its number and
 * title that links to it ("Restricted matter", unlinked, when the reader can't open it). `[1]` is
 * text here: citations are Clerk's (`mt-clerk-message`).
 */
@Component({
  selector: 'mt-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [NgTemplateOutlet, RouterLink, MtIcon],
  host: { class: 'mt-md' },
  template: `
    @for (block of blocks(); track $index) {
      @switch (block.type) {
        @case ('paragraph') {
          <p><ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" /></p>
        }
        @case ('heading') {
          <p>
            <b><ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" /></b>
          </p>
        }
        @case ('quote') {
          <blockquote>
            <ng-container *ngTemplateOutlet="inline; context: { $implicit: block.children }" />
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
            <a [href]="node.href" target="_blank" rel="noopener noreferrer"
              ><ng-container *ngTemplateOutlet="inline; context: { $implicit: node.children }"
            /></a>
          }
          @case ('mention') {
            @if (node.kind === 'member') {
              @if (memberOf(node.id); as person) {
                @if (person.former) {
                  <span class="mt-mention-text">{{ person.name }}</span>
                } @else {
                  <span class="mt-mention" data-kind="member">&#64;{{ person.name }}</span>
                }
              } @else {
                <span class="mt-mention-text">Unknown member</span>
              }
            } @else {
              @switch (matterState(node.id)) {
                @case ('open') {
                  @if (matterOf(node.id); as m) {
                    <a class="mt-mention" data-kind="matter" [routerLink]="m.link"
                      ><span class="num">{{ m.number }}</span> {{ m.title }}</a
                    >
                  }
                }
                @case ('restricted') {
                  <span class="mt-mention" data-kind="restricted"
                    ><mt-icon name="shield" [size]="14" />{{ restrictedLabel }}</span
                  >
                }
                @default {
                  <span class="mt-mention" data-kind="pending" aria-busy="true">Matter…</span>
                }
              }
            }
          }
        }
      }
    </ng-template>
  `,
  styles: `
    .mt-md {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      font: 400 14px/22px var(--font-sans);
      color: var(--text-primary);
      overflow-wrap: anywhere;
    }
    .mt-md p,
    .mt-md blockquote {
      margin: 0;
      white-space: pre-line;
    }
    .mt-md b {
      font-weight: 600;
    }
    .mt-md ul,
    .mt-md ol {
      margin: 0;
      padding-left: 20px;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-md blockquote {
      padding-left: var(--space-12);
      border-left: 2px solid var(--border-strong);
      color: var(--text-secondary);
    }
    .mt-md code {
      padding: 1px 4px;
      border-radius: var(--radius-xs);
      background: var(--bg-sunken);
      font: 500 12px/1 var(--font-mono);
    }
    .mt-md pre {
      margin: 0;
      padding: var(--space-8) var(--space-12);
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
      font: 400 12px/18px var(--font-mono);
      white-space: pre-wrap;
    }
    .mt-md pre code {
      padding: 0;
      background: none;
      font: inherit;
    }
    .mt-md a {
      color: var(--text-brand);
      text-underline-offset: 2px;
    }
    .mt-mention {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
      max-width: 100%;
      padding: 0 var(--space-6);
      border-radius: var(--radius-xs);
      background: var(--bg-selected);
      color: var(--text-brand);
      font: 500 13px/20px var(--font-sans);
      vertical-align: baseline;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    a.mt-mention {
      text-decoration: none;
    }
    a.mt-mention:hover {
      text-decoration: underline;
    }
    .mt-mention .num {
      font: 500 12px/20px var(--font-mono);
    }
    .mt-mention[data-kind='restricted'],
    .mt-mention[data-kind='pending'] {
      background: var(--bg-sunken);
      color: var(--text-secondary);
    }
  `,
})
export class MtMarkdown {
  /** The Markdown to render. */
  readonly content = input('');
  /** Read `@[uid]` and `#[matterId]` mentions (notes). */
  readonly mentions = input(false, { transform: booleanAttribute });
  /** Keep single line breaks (default), as people expect in a file note. */
  readonly breaks = input(true, { transform: booleanAttribute });
  /** Names a mentioned member; without it every member mention reads "Unknown member". */
  readonly member = input<MtMentionMemberResolver>(() => null);
  /** Resolves a mentioned matter; without it every matter mention reads "Restricted matter". */
  readonly matter = input<MtMentionMatterResolver>(() => null);

  protected readonly restrictedLabel = MT_RESTRICTED_MATTER_LABEL;
  protected readonly blocks = computed(() =>
    parseMarkdown(this.content(), false, { mentions: this.mentions(), citations: false, breaks: this.breaks() }),
  );

  protected memberOf(uid: string): MtMentionMember | null {
    return this.member()(uid);
  }

  protected matterOf(id: string): MtMentionMatter | null | undefined {
    return this.matter()(id);
  }

  protected matterState(id: string): 'open' | 'restricted' | 'pending' {
    const found = this.matter()(id);
    if (found === undefined) return 'pending';
    return found ? 'open' : 'restricted';
  }
}
