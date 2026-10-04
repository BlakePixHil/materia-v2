import { Directive, inject, Injectable, type OnDestroy, signal, TemplateRef } from '@angular/core';

/** The shell header's actions slot, filled by the current page. */
@Injectable({ providedIn: 'root' })
export class PageHeader {
  readonly actions = signal<TemplateRef<unknown> | null>(null);
}

/**
 * Puts page actions in the shell header: `<ng-template mtPageActions><button mtButton>New matter</button></ng-template>`.
 * Cleared when the page goes away.
 */
@Directive({ selector: 'ng-template[mtPageActions]' })
export class MtPageActions implements OnDestroy {
  private readonly header = inject(PageHeader);
  private readonly template = inject(TemplateRef);

  constructor() {
    this.header.actions.set(this.template);
  }

  ngOnDestroy(): void {
    if (this.header.actions() === this.template) this.header.actions.set(null);
  }
}
