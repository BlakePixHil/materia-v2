import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import { MtClerkMark } from '@materia/ui';

interface Rule {
  title: string;
  body: string;
}

/** The seven Clerk rules (docs/07-clerk-ai.md), in plain words for the people who use it. */
export const CLERK_RULES: readonly Rule[] = [
  {
    title: 'You can always tell it’s Clerk',
    body: 'Anything Clerk writes carries the violet Clerk mark and the word “Clerk”, so you never mistake it for something a person wrote.',
  },
  {
    title: 'It shows where every fact came from',
    body: 'When Clerk states a fact about a matter, it cites the document, page and words it relied on, or the record (a deadline, an event, a time entry). Anything it can’t cite is labelled as not from your file.',
  },
  {
    title: 'It suggests; you decide',
    body: 'Clerk never changes anything itself. Every task, deadline, party or draft it proposes waits for a person to accept, edit or dismiss it. It never sends email, files with a court or bills a client.',
  },
  {
    title: 'It only sees what you can see',
    body: 'Clerk works within your practice and, usually, one matter. It only reads matters and documents the person asking can open, and nothing from another firm.',
  },
  {
    title: 'It says when it doesn’t know',
    body: 'If the answer isn’t in the file, or there was too much to read at once, Clerk says so. It doesn’t invent citations, legislation or case law.',
  },
  {
    title: 'It respects privilege',
    body: 'Privileged documents are used only for people allowed to see them (owners, admins and lawyers). Anything Clerk produces from privileged material is marked privileged too.',
  },
  {
    title: 'It doesn’t predict outcomes for clients',
    body: 'Clerk can help lawyers weigh a matter internally, but it won’t draft client-facing predictions of how a dispute will turn out.',
  },
];

/**
 * How Clerk works (`/help/clerk`, AI-13): the seven Clerk rules in plain words, for everyone.
 * Linked from the Clerk panel and Settings → Clerk and AI.
 */
@Component({
  selector: 'mt-clerk-guide-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtClerkMark, RouterLink],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 720px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l mt-row" style="margin: 0; gap: 8px; align-items: center">
        <mt-clerk-mark size="sm" />
        How Clerk works
      </h1>
      <p style="margin: 0; color: var(--text-secondary)">
        Clerk is Materia’s assistant. It reads the file, drafts and suggests, and it follows seven rules.
      </p>
    </div>
    <ol class="rules">
      @for (rule of rules; track rule.title; let i = $index) {
        <li>
          <span class="n" aria-hidden="true">{{ i + 1 }}</span>
          <div class="mt-col" style="gap: 4px">
            <h2 class="title-s" style="margin: 0">{{ rule.title }}</h2>
            <p style="margin: 0; color: var(--text-secondary)">{{ rule.body }}</p>
          </div>
        </li>
      }
    </ol>
    <p style="margin: 0; color: var(--text-secondary)">
      Practitioners remain responsible for the advice they give.
      <a routerLink="/settings/clerk">{{ canConfigure() ? 'Clerk settings' : 'What Clerk can do in your practice' }}</a>
      covers which features are on and how your firm’s data is used.
    </p>
  `,
  styles: `
    .rules {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .rules li {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .rules .n {
      flex: none;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font: 600 12px/1 var(--font-sans);
      color: var(--text-ai);
      background: var(--bg-ai-subtle);
    }
  `,
})
export class ClerkGuidePage {
  protected readonly rules = CLERK_RULES;
  protected readonly canConfigure = can('clerk.configure');
}
