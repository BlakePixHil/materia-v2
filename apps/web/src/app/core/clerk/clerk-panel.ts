import { Injectable, signal } from '@angular/core';

/** What Clerk is asked about: the page's subject (a matter), or the whole practice when null. */
export interface ClerkScope {
  kind: 'matter';
  id: string;
  /** Shown in the panel's header ("M-2026-0142"). */
  label: string;
}

/**
 * The shell's Clerk panel (FND-12): open or closed, and its scope. A page with a subject (the
 * matter screen, CORE-06) sets the scope while it's shown, so ⌘J asks about that matter. The chat
 * (AI-06, `features/clerk`) reads `scope()` to ground its answers.
 */
@Injectable({ providedIn: 'root' })
export class ClerkPanel {
  private readonly openState = signal(false);
  private readonly scopeState = signal<ClerkScope | null>(null);

  /** The thread last open on each matter, so coming back from "How Clerk works" resumes it. */
  private readonly lastThreads = new Map<string, string>();
  private resumePending = false;

  readonly open = this.openState.asReadonly();
  readonly scope = this.scopeState.asReadonly();

  toggle(): void {
    this.openState.update((open) => !open);
  }

  /** Opens the panel; with `resume`, the chat reopens the thread it last showed on the next matter it's scoped to. */
  show(options: { resume?: boolean } = {}): void {
    if (options.resume) this.resumePending = true;
    this.openState.set(true);
  }

  /** The chat noting which thread it shows on a matter. */
  rememberThread(matterId: string, threadId: string): void {
    this.lastThreads.set(matterId, threadId);
  }

  /** The thread to reopen on this matter after `show({ resume: true })`, once; otherwise null (a new thread). */
  takeResume(matterId: string | null): string | null {
    if (!matterId || !this.resumePending) return null;
    this.resumePending = false;
    return this.lastThreads.get(matterId) ?? null;
  }

  close(): void {
    this.openState.set(false);
  }

  /** Scopes the panel to a page's subject; returns a release that clears it if it's still this one. */
  setScope(scope: ClerkScope): () => void {
    this.scopeState.set(scope);
    return () => {
      if (this.scopeState() === scope) this.scopeState.set(null);
    };
  }
}
