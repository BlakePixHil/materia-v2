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
 * matter screen, CORE-06) sets the scope while it's shown, so ⌘J asks about that matter. The
 * panel's content arrives in AI-06; it reads `scope()` to ground its answers.
 */
@Injectable({ providedIn: 'root' })
export class ClerkPanel {
  private readonly openState = signal(false);
  private readonly scopeState = signal<ClerkScope | null>(null);

  readonly open = this.openState.asReadonly();
  readonly scope = this.scopeState.asReadonly();

  toggle(): void {
    this.openState.update((open) => !open);
  }

  show(): void {
    this.openState.set(true);
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
