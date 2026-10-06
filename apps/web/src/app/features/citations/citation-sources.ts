import { inject, Injectable, signal } from '@angular/core';

import { matterDocumentRepository } from '@materia/data-access/repository';
import { DomainError, type CitationInput } from '@materia/domain';
import type { CitationVm } from '@materia/ui';

import { citationVms, viewerCitations, type CitedDocState, type ViewerCitation } from './citation-view';
import { MatterScreen } from '../matter-detail/matter-screen';

/** The citation viewer's state: the citations it steps through and the one shown. */
export interface CitationViewing {
  citations: ViewerCitation[];
  index: number;
}

/**
 * The cited documents of a matter screen and the citation viewer's state (AI-05). Each cited
 * document is read once, by id (never the matter's whole document list): a refused read is a source
 * the reader can't see ("Restricted source") and a missing one is gone ("Removed document").
 * Provide it where citations show (the Overview's suggestions; the Clerk panel later).
 */
@Injectable()
export class CitationSources {
  private readonly screen = inject(MatterScreen);
  private readonly repo = matterDocumentRepository(() => this.screen.id());
  private readonly states = signal<ReadonlyMap<string, CitedDocState>>(new Map());
  private readonly asked = new Set<string>();
  readonly viewing = signal<CitationViewing | null>(null);

  /** Reads the cited documents not read yet. Call from an effect or an event. */
  want(citations: readonly CitationInput[]): void {
    const ids = citations.flatMap((citation) =>
      citation.kind !== 'record' && citation.documentId && !this.asked.has(citation.documentId)
        ? [citation.documentId]
        : [],
    );
    for (const id of new Set(ids)) {
      this.asked.add(id);
      void this.read(id);
    }
  }

  /** The chips for a list of citations, numbered by position. */
  vms(citations: readonly CitationInput[]): CitationVm[] {
    return citationVms(citations, this.states(), this.screen.canPrivileged());
  }

  /** Opens the viewer at citation `n` of a list (or the first it can open). */
  open(citations: readonly CitationInput[], n: number | undefined): void {
    const list = viewerCitations(this.vms(citations), citations);
    if (!list.length) return;
    const index = Math.max(
      0,
      list.findIndex((citation) => citation.n === n),
    );
    this.viewing.set({ citations: list, index });
  }

  close(): void {
    this.viewing.set(null);
  }

  private async read(id: string): Promise<void> {
    this.set(id, { status: 'loading' });
    try {
      const doc = await this.repo.get(id);
      this.set(id, doc ? { status: 'found', doc } : { status: 'missing' });
    } catch (error) {
      const denied =
        error instanceof DomainError &&
        ['ACCESS_REVOKED', 'PERMISSION_DENIED', 'NOT_FOUND'].includes(error.code as string);
      if (denied) return this.set(id, { status: 'denied' });
      // Offline or failing: say nothing about the source yet, and read it again next time.
      this.asked.delete(id);
    }
  }

  private set(id: string, state: CitedDocState): void {
    this.states.update((states) => new Map([...states, [id, state]]));
  }
}
